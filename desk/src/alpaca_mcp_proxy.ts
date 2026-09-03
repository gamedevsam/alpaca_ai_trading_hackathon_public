/**
 * H2a — Alpaca's own MCP server, re-exposed through ours.
 *
 * The hackathon requires the project use Alpaca's MCP server or its CLI. H1 shipped the CLI half and made
 * it the live execution path; this is the MCP half, and it exists for a second reason the CLI cannot serve:
 * the owner connects **one** connector to a chat and gets Alpaca's market-data tools *and* the desk's tools
 * side by side. Our surface becomes a superset rather than a competitor.
 *
 * The shape is a proxy, not a re-implementation. A sidecar (`alpaca-mcp`, upstream `alpacahq/alpaca-mcp-server`,
 * pinned) runs `--transport streamable-http` on an internal Docker network with no public port; our MCP server
 * connects to it as a *client*, and re-registers an allow-listed subset of its tools under an `alpaca_` prefix
 * with their original schemas. What the sidecar answers, it answers itself — we forward the call and return
 * its content verbatim, so nothing here can silently reinterpret a quote or a chain.
 *
 * ## Why an allow-list, when the sidecar is already scoped
 *
 * Belt and braces, and the two are independent on purpose:
 *
 * - **Belt (deployment):** the sidecar's `ALPACA_TOOLSETS` omits `trading` and `watchlists` entirely, so it
 *   never even constructs the tools that place, cancel, close or exercise. `place_option_order`,
 *   `close_all_positions` and `exercise_options_position` do not exist in that process.
 * - **Braces (this file):** `ALPACA_MCP_READ_TOOLS` is an explicit enumeration, so a tool that appears because
 *   upstream added one, or because someone widened the toolsets on the Dokku app, is *still* not proxied. The
 *   allow-list can only shrink the surface, never grow it.
 *
 * That matters because a write reached through this proxy would bypass the whole desk: the mandate, the
 * fourteen ceilings, the execution gate and the owner's approval all live on our propose path. Every write
 * stays there. The proxy is reads only, forever.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';

/** Every proxied tool wears this prefix, so a reader can always tell whose answer they are looking at. */
export const ALPACA_MCP_TOOL_PREFIX = 'alpaca_';

/**
 * The tools this proxy will expose, by their sidecar name. Anything not on this list is not proxied —
 * including tools that do not exist today. Ordered by what an options desk actually reaches for.
 *
 * Deliberately absent, and each for a stated reason rather than an oversight:
 * - every order/position tool (`place_option_order`, `close_all_positions`, `exercise_options_position`,
 *   cancels, `deleteOpenPosition`…) — writes belong to the desk's propose→approve→execute path, never here;
 * - `update_account_config` — the sidecar's one account *write*, and the only write it exposes at all;
 * - the crypto feeds — outside the mandate's universe, so proxying them would only cost context;
 * - the ReadMe documentation tools (`search_alpaca_docs` and friends) — they answer about Alpaca's docs, not
 *   about the market, and they make their own outbound calls.
 */
export const ALPACA_MCP_READ_TOOLS = [
  // Options — the desk's own instrument.
  'get_option_chain',
  'get_option_snapshot',
  'get_option_latest_quote',
  'get_option_latest_trade',
  'get_option_bars',
  'get_option_trades',
  'get_option_contracts',
  'get_option_contract',
  'get_option_exchange_codes',
  // Equities — the underlyings those options settle against.
  'get_stock_snapshot',
  'get_stock_latest_quote',
  'get_stock_latest_trade',
  'get_stock_latest_bar',
  'get_stock_bars',
  'get_stock_quotes',
  'get_stock_trades',
  'get_market_movers',
  'get_most_active_stocks',
  // Reference — is the market open, is this symbol optionable, what is happening to it.
  'get_clock',
  'get_calendar',
  'get_all_assets',
  'get_asset',
  'get_news',
  'get_corporate_actions',
  'get_corporate_action_announcements',
  'get_corporate_action_announcement',
  // Account, reads only. The desk reports its own equity; this is the broker's answer to the same question.
  'get_account_info',
  'get_account_config',
  'get_account_activities',
  'get_account_activities_by_type',
  'get_portfolio_history',
] as const;

/**
 * Named here so `describe_manager_surface` can say what is missing and why, rather than leaving a consumer to
 * infer it from an absence. These are the three the plan calls out by name; the surface promise is broader.
 */
export const ALPACA_MCP_WITHHELD_TOOLS = [
  'place_option_order',
  'close_all_positions',
  'exercise_options_position',
  'update_account_config',
] as const;

/** How long a discovery handshake may take before boot gives up and ships without the proxy. */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** How long one proxied call may take. Generous: an option chain for a liquid name is a large response. */
const CALL_TIMEOUT_MS = 30_000;

export type AlpacaMcpProxyResult = {
  /** Prefixed names actually registered, in registration order. */
  registered: string[];
  /** Allow-listed names the sidecar did not offer — a toolset narrowed on the app, or an upstream rename. */
  missing: string[];
  /** Sidecar tools we saw and chose not to proxy. Reported so the exclusion is visible, not silent. */
  notProxied: string[];
};

/**
 * JSON Schema keywords the sidecar emits that come from OpenAPI rather than JSON Schema. Ajv is constructed
 * in strict mode by `AjvMcpServer` and throws on both — an unknown keyword (`example`) and an unknown format
 * (`double`) — and it compiles at *call* time, outside that class's try/catch. So an unsanitized schema would
 * turn every proxied call into a 500. They carry no validation meaning we lose: the descriptions already say
 * "RFC-3339 or YYYY-MM-DD", and the sidecar validates its own arguments regardless.
 */
const OPENAPI_ONLY_KEYWORDS = ['example', 'format'] as const;

function stripOpenApiKeywords(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripOpenApiKeywords);
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((OPENAPI_ONLY_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    out[key] = stripOpenApiKeywords(value);
  }
  return out;
}

/**
 * Return a schema this server can both advertise and validate against, or `null` if it cannot.
 *
 * The compile check is the point: `AjvMcpServer` compiles the schema on every call, so a schema that throws
 * here would throw on the caller instead. Proving it compiles once, at boot, is what keeps a remote schema
 * change from becoming a runtime fault — and a tool we cannot validate is skipped rather than shipped broken.
 */
export function sanitizeRemoteToolSchema(schema: unknown): object | null {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const sanitized = stripOpenApiKeywords(schema) as object;
  try {
    new Ajv({ allErrors: true }).compile(sanitized);
    return sanitized;
  } catch {
    return null;
  }
}

/** One connection per operation. See `registerAlpacaMcpProxyTools` for why this is not pooled. */
async function withRemoteClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'stock-rankings-alpaca-proxy', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport, { timeout: DISCOVERY_TIMEOUT_MS });
  try {
    return await run(client);
  } finally {
    // `close()` only aborts our side — it does NOT tell the server the session is over, so a connection
    // per call would leave one live session behind on the sidecar per call. `terminateSession()` sends the
    // DELETE that reaps it (405 is tolerated by the SDK for servers that don't support termination), and
    // both are best-effort: a cleanup failure must never turn a successful answer into an error.
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

function buildProxyErrorResult(toolName: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        // Name the boundary. "Alpaca is down" and "our sidecar is down" are different problems for the owner,
        // and a bare error message from a proxied call reads as the former when it is usually the latter.
        text: JSON.stringify(
          {
            error: {
              code: 'ALPACA_MCP_UNAVAILABLE',
              message: `${ALPACA_MCP_TOOL_PREFIX}${toolName} could not reach Alpaca's MCP server: ${message}`,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Discover the sidecar's tools and register the allow-listed ones on `mcp`.
 *
 * Connections are made per operation rather than held open. The sidecar keeps per-session state for a
 * streamable-HTTP connection, so a long-lived client would go stale the moment the sidecar restarts — and it
 * restarts on every deploy of it. A fresh handshake costs one round trip on a Docker-internal network, which
 * is the right price for never serving a caller from a dead session.
 *
 * Throws if the sidecar cannot be reached; the caller decides whether that is fatal (it is not — the desk
 * reads market data over HTTP either way, so a missing proxy costs the chat convenience and nothing else).
 */
export async function registerAlpacaMcpProxyTools(mcp: AjvMcpServer, url: string): Promise<AlpacaMcpProxyResult> {
  const remoteTools = await withRemoteClient(url, async (client) => {
    const { tools } = await client.listTools(undefined, { timeout: DISCOVERY_TIMEOUT_MS });
    return tools;
  });

  const offered = new Map(remoteTools.map((tool) => [tool.name, tool]));
  const registered: string[] = [];
  const missing: string[] = [];

  for (const name of ALPACA_MCP_READ_TOOLS) {
    const tool = offered.get(name);
    if (!tool) {
      missing.push(name);
      continue;
    }
    const schema = sanitizeRemoteToolSchema(tool.inputSchema);
    if (!schema) {
      missing.push(name);
      continue;
    }
    const proxiedName = `${ALPACA_MCP_TOOL_PREFIX}${name}`;
    mcp.tool(
      proxiedName,
      // Upstream's own description, marked as proxied. The provenance belongs in the description because it
      // changes how a consumer should read the answer: this one is Alpaca's, not the desk's.
      `[Alpaca MCP · read-only] ${tool.description ?? ''}`.trim(),
      schema,
      async (args: object): Promise<CallToolResult> => {
        try {
          const result = await withRemoteClient(url, (client) =>
            client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, {
              timeout: CALL_TIMEOUT_MS,
            }),
          );
          return result as CallToolResult;
        } catch (error) {
          return buildProxyErrorResult(name, error);
        }
      },
    );
    registered.push(proxiedName);
  }

  const allowed = new Set<string>(ALPACA_MCP_READ_TOOLS);
  const notProxied = remoteTools.map((tool) => tool.name).filter((name) => !allowed.has(name));

  return { registered, missing, notProxied };
}
