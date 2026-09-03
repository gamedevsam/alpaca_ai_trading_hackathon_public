// H2a — the proxy that re-exposes Alpaca's own MCP read tools on the portfolio-manager surface.
//
// The sidecar's real tool list and schemas were captured from the deployed `alpaca-mcp` app on 2026-09-03
// (40 tools, OpenAPI-derived schemas carrying `format` and `example`); the fixtures below are that shape.
// What these tests hold is OUR half of the contract, and specifically the two things whose failure is silent:
// that nothing outside the allow-list can reach the surface however the broker's server is configured, and
// that a schema we advertise is one this server can actually validate against at call time.

import { Ajv } from 'ajv';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';
import {
  ALPACA_MCP_READ_TOOLS,
  ALPACA_MCP_TOOL_PREFIX,
  ALPACA_MCP_WITHHELD_TOOLS,
  registerAlpacaMcpProxyTools,
  sanitizeRemoteToolSchema,
} from '../alpaca_mcp_proxy';

const mockConnect = jest.fn();
const mockListTools = jest.fn();
const mockCallTool = jest.fn();
const mockClose = jest.fn();
const mockTerminateSession = jest.fn();

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    terminateSession: (...args: unknown[]) => mockTerminateSession(...args),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: (...args: unknown[]) => mockConnect(...args),
    listTools: (...args: unknown[]) => mockListTools(...args),
    callTool: (...args: unknown[]) => mockCallTool(...args),
    close: (...args: unknown[]) => mockClose(...args),
  })),
}));

/** The sidecar's real `get_option_chain` schema, trimmed — OpenAPI keywords and all. */
const optionChainSchema = {
  type: 'object',
  properties: {
    underlying_symbol: { type: 'string', description: 'The underlying.' },
    strike_price_gte: { type: 'number', format: 'double', description: 'Minimum strike.' },
    expiration_date: { type: 'string', format: 'date', example: '2026-01-16', description: 'Exact expiry.' },
    limit: { type: 'integer', maximum: 1000.0, minimum: 1.0, default: 100 },
  },
  required: ['underlying_symbol'],
};

type RegisteredTool = { name: string; description: string; schema: object; callback: (args: object) => unknown };

function fakeMcpServer() {
  const tools: RegisteredTool[] = [];
  const mcp = {
    tool: (name: string, description: string, schema: object, callback: (args: object) => unknown) => {
      tools.push({ name, description, schema, callback });
    },
  } as unknown as AjvMcpServer;
  return { mcp, tools };
}

function remoteTool(name: string) {
  return { name, description: `${name} description`, inputSchema: optionChainSchema };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockTerminateSession.mockResolvedValue(undefined);
});

describe('the allow-list', () => {
  it('never contains a tool that writes', () => {
    for (const withheld of ALPACA_MCP_WITHHELD_TOOLS) {
      expect(ALPACA_MCP_READ_TOOLS as readonly string[]).not.toContain(withheld);
    }
  });

  it('lists every tool exactly once, so a rename cannot double-register one', () => {
    expect(new Set(ALPACA_MCP_READ_TOOLS).size).toBe(ALPACA_MCP_READ_TOOLS.length);
  });
});

describe('sanitizeRemoteToolSchema', () => {
  it('strips the OpenAPI-only keywords that make Ajv throw at call time', () => {
    const sanitized = sanitizeRemoteToolSchema(optionChainSchema) as Record<string, any>;
    expect(sanitized).not.toBeNull();
    expect(sanitized.properties.expiration_date).toEqual({ type: 'string', description: 'Exact expiry.' });
    expect(sanitized.properties.strike_price_gte.format).toBeUndefined();
    // Everything that carries meaning survives.
    expect(sanitized.required).toEqual(['underlying_symbol']);
    expect(sanitized.properties.limit).toEqual({ type: 'integer', maximum: 1000, minimum: 1, default: 100 });
  });

  it('returns a schema the server can actually compile — the whole point of sanitizing', () => {
    // Constructed exactly as `AjvMcpServer` does on every call. The raw schema throws here; the sanitized
    // one must not, or the proxied tool would 500 on its first invocation.
    expect(() => new Ajv({ allErrors: true }).compile(optionChainSchema)).toThrow();
    const sanitized = sanitizeRemoteToolSchema(optionChainSchema)!;
    const validate = new Ajv({ allErrors: true }).compile(sanitized);
    expect(validate({ underlying_symbol: 'SPY', expiration_date: '2026-01-16' })).toBe(true);
    expect(validate({ limit: 5 })).toBe(false);
  });

  it('returns null rather than a broken tool when a schema cannot be salvaged', () => {
    expect(sanitizeRemoteToolSchema({ type: 'object', properties: { a: { type: 'not-a-type' } } })).toBeNull();
    expect(sanitizeRemoteToolSchema(undefined)).toBeNull();
  });
});

describe('registerAlpacaMcpProxyTools', () => {
  it('registers the allow-listed reads under the prefix and withholds everything else', async () => {
    mockListTools.mockResolvedValue({
      tools: [
        remoteTool('get_option_chain'),
        remoteTool('get_clock'),
        // Offered by the broker's server, never proxied by ours.
        remoteTool('place_option_order'),
        remoteTool('update_account_config'),
        remoteTool('get_crypto_bars'),
      ],
    });
    const { mcp, tools } = fakeMcpServer();

    const result = await registerAlpacaMcpProxyTools(mcp, 'http://alpaca-mcp.web:8000/mcp');

    expect(tools.map((tool) => tool.name)).toEqual([
      `${ALPACA_MCP_TOOL_PREFIX}get_option_chain`,
      `${ALPACA_MCP_TOOL_PREFIX}get_clock`,
    ]);
    expect(result.registered).toEqual([
      `${ALPACA_MCP_TOOL_PREFIX}get_option_chain`,
      `${ALPACA_MCP_TOOL_PREFIX}get_clock`,
    ]);
    expect(result.notProxied).toEqual(['place_option_order', 'update_account_config', 'get_crypto_bars']);
    // Allow-listed but not offered is reported, not silently dropped — it means the sidecar was narrowed.
    expect(result.missing).toContain('get_option_snapshot');
    // Closing our end is not enough — without the DELETE the sidecar keeps one live session per call.
    expect(mockTerminateSession).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it("marks a proxied tool as Alpaca's answer rather than the desk's", async () => {
    mockListTools.mockResolvedValue({ tools: [remoteTool('get_clock')] });
    const { mcp, tools } = fakeMcpServer();

    await registerAlpacaMcpProxyTools(mcp, 'http://alpaca-mcp.web:8000/mcp');

    expect(tools[0].description).toBe('[Alpaca MCP · read-only] get_clock description');
  });

  it("forwards the call under its unprefixed name and returns the broker's answer verbatim", async () => {
    mockListTools.mockResolvedValue({ tools: [remoteTool('get_option_chain')] });
    const remoteResult = { content: [{ type: 'text', text: '{"SPY260116C00600000":{}}' }] };
    mockCallTool.mockResolvedValue(remoteResult);
    const { mcp, tools } = fakeMcpServer();

    await registerAlpacaMcpProxyTools(mcp, 'http://alpaca-mcp.web:8000/mcp');
    const answer = await tools[0].callback({ underlying_symbol: 'SPY' });

    expect(mockCallTool).toHaveBeenCalledWith(
      { name: 'get_option_chain', arguments: { underlying_symbol: 'SPY' } },
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(answer).toEqual(remoteResult);
  });

  it('reports an unreachable sidecar as a named error instead of throwing at the caller', async () => {
    mockListTools.mockResolvedValue({ tools: [remoteTool('get_clock')] });
    mockCallTool.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const { mcp, tools } = fakeMcpServer();

    await registerAlpacaMcpProxyTools(mcp, 'http://alpaca-mcp.web:8000/mcp');
    const answer = (await tools[0].callback({})) as { isError: boolean; content: { text: string }[] };

    expect(answer.isError).toBe(true);
    const payload = JSON.parse(answer.content[0].text);
    expect(payload.error.code).toBe('ALPACA_MCP_UNAVAILABLE');
    expect(payload.error.message).toContain('alpaca_get_clock');
    expect(payload.error.message).toContain('ECONNREFUSED');
    // Once for discovery, once for the failed call: a failure must still reap its session.
    expect(mockTerminateSession).toHaveBeenCalledTimes(2);
  });

  it('propagates a discovery failure so boot can decide, rather than registering a half surface', async () => {
    mockListTools.mockRejectedValue(new Error('sidecar down'));
    const { mcp, tools } = fakeMcpServer();

    await expect(registerAlpacaMcpProxyTools(mcp, 'http://alpaca-mcp.web:8000/mcp')).rejects.toThrow('sidecar down');
    expect(tools).toHaveLength(0);
  });
});
