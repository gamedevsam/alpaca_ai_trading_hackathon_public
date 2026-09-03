/**
 * H2c — the desk's own tools on the portfolio-manager MCP surface.
 *
 * Five thin wrappers over `AlpacaLifecycleService`, alongside H13's channel tools and H14's signal tools, so
 * one connector can carry the whole loop: read what the desk proposed, approve or reject it, and set whether
 * it may act unattended. Every rule that matters — the mandate's bounds, the fourteen ceilings, the TTL, the
 * fail-closed re-check against fresh broker state — lives in the service and is untouched here. This file
 * adds reachability, not permission.
 *
 * Everything is clamped to the **paper** environment, exactly as the REST controller is, and for the same
 * reason: `live` is an owner gate that no tool may open as a side effect of being called.
 *
 * The line these tools have to hold is sharper than the intake tools' (H13/H14). Approving a proposal is the
 * owner's judgment, and `approve_action` does not merely record it — it hands off to the guarded execute and
 * an order reaches the broker. So the descriptions say, in the place an AI actually reads them, that these
 * execute a decision he stated and never one the caller reached; `describe_manager_surface`'s `neverPerforms`
 * says the same thing in the place a careful consumer checks first.
 */

import { HttpException } from '@nestjs/common';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';
import { resolveMcpTokenOwnerId } from '~/api/admin/mcp/mcp_owner_identity';
import type { AlpacaEnvironment } from './alpaca.types';
import type { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import type { AlpacaControlLimits, AlpacaExecutionGate } from './alpaca_safeguards';

/** The only environment reachable from this surface. Live stays an owner gate, opened by nobody's tool call. */
const DESK_ENVIRONMENT: AlpacaEnvironment = 'paper';

/** How many actions one `list_actions` call returns by default, and the most it will ever return. */
const ACTION_PAGE_SIZE = 25;
const ACTION_PAGE_MAX = 100;

function buildDeskToolResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function buildDeskErrorResponse(error: unknown) {
  const status = error instanceof HttpException ? error.getStatus() : null;
  const code =
    status === 404
      ? 'NOT_FOUND'
      : status === 409
        ? // A 409 is the desk refusing on purpose — a re-decision, or a proposal that already expired. The
          // caller must be able to tell that apart from a fault, because the right next step is different.
          'CONFLICT'
        : status === 400
          ? 'INVALID_PARAMS'
          : 'INTERNAL_ERROR';
  return buildDeskToolResponse({ error: { code, message: error instanceof Error ? error.message : String(error) } });
}

function compactAction(action: Required<$.AlpacaAction>) {
  const body = action.body;
  return {
    id: action.id,
    status: body.status,
    symbol: body.symbol,
    side: body.side,
    qty: body.qty,
    limitPrice: body.limitPrice,
    orderType: body.orderType,
    timeInForce: body.timeInForce,
    rationale: body.rationale,
    // Which ceilings were checked and what they returned. An empty list means the safeguards did not run,
    // NOT that everything passed — a discarded action's cleared limits are what say where it stopped.
    clearedLimits: body.clearedLimits,
    instrument: body.instrument,
    mandateId: body.mandateId,
    // H14/H15 — the creators' calls this proposal cited, if any. Empty means the desk acted on the chain
    // alone, which is a different claim from "no creator was bullish".
    signalIds: body.signalIds,
    // H8 — the falsifiable claim this proposal stands on, in the prediction ledger. Read it with
    // `get_prediction`; the desk's whole record is `get_manager_scorecard` on its `ai_sleeve` source.
    predictionId: body.predictionId ?? null,
    approval: body.approval,
    // H1 — which transport actually placed it (`cli` = Alpaca's own CLI, `http` = our typed client), and
    // whether it was a dry run. Null until something was submitted.
    execution: body.execution,
    optionOutcome: body.optionOutcome,
    alpacaOrderId: body.alpacaOrderId,
    errorMessage: body.errorMessage,
    expiresAt: body.expiresAt,
    events: body.events,
  };
}

export function registerDeskTools(mcp: AjvMcpServer, lifecycle: AlpacaLifecycleService) {
  mcp.tool(
    'list_actions',
    `List the desk's paper trade actions, most recently active first — what it proposed, what cleared or breached which ceiling, what was approved, and what the broker did with it. Every row carries \`clearedLimits\` (the safeguards that actually ran; an empty list means they did NOT run, which is not the same as passing), \`rationale\` in the desk's own words, \`signalIds\` for the creators' calls it cited, and \`execution\` provenance once an order was placed. The reply also carries the current \`control\`, because it changes what a \`proposed\` row means: under \`fully_autonomous\` nothing is waiting on the owner, under \`per_action\` everything is. Read-only — listing an action neither approves nor expires it. Default ${ACTION_PAGE_SIZE} rows, ${ACTION_PAGE_MAX} maximum.`,
    {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [
            'draft',
            'proposed',
            'approved',
            'rejected',
            'submitted',
            'filled',
            'failed',
            'canceled',
            'reconciled',
            'expired',
            'discarded',
          ],
          description:
            "Narrow to one lifecycle state. 'proposed' is what awaits a decision; 'discarded' is what the safeguards refused. Omit for all of them.",
        },
        limit: { type: 'integer', minimum: 1, maximum: ACTION_PAGE_MAX, description: `Default ${ACTION_PAGE_SIZE}.` },
      },
      additionalProperties: false,
    },
    async (args: { status?: $.AlpacaAction['body']['status']; limit?: number }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const limit = args.limit ?? ACTION_PAGE_SIZE;
        // Filtering by status narrows a page that was already cut, so ask for the ceiling and cut after —
        // otherwise "show me the discarded ones" silently returns nothing whenever the last 25 were fills.
        const actions = await lifecycle.listActions(ownerId, DESK_ENVIRONMENT, args.status ? ACTION_PAGE_MAX : limit);
        const filtered = args.status ? actions.filter((action) => action.body.status === args.status) : actions;
        const page = filtered.slice(0, limit);
        const control = await lifecycle.getControl(ownerId, DESK_ENVIRONMENT);
        return buildDeskToolResponse({
          environment: DESK_ENVIRONMENT,
          control,
          count: page.length,
          truncated: filtered.length > page.length,
          actions: page.map(compactAction),
        });
      } catch (error) {
        return buildDeskErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'approve_action',
    "Approve a proposed trade — and be clear about what that does: approval hands straight off to the guarded execute, so a real (paper) order goes to the broker. Every safeguard is re-run first against FRESH account and market state, so an action approved after conditions moved comes back `discarded` rather than executed; approval is necessary, never sufficient. A proposal past its TTL is returned `expired` and un-decided. Only call this when the owner has told you, in this conversation, to approve this specific action — judging a proposal on its merits is his job, not yours, and 'it looks reasonable' is not an instruction. Read the action with list_actions and put its rationale and cleared limits in front of him first.",
    {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Action id from list_actions (AAC…).' } },
      additionalProperties: false,
    },
    async (args: { id: string }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const action = await lifecycle.decideAction(ownerId, args.id, 'approved');
        return buildDeskToolResponse({ action: compactAction(action) });
      } catch (error) {
        return buildDeskErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'reject_action',
    "Reject a proposed trade. The action stops here — nothing reaches the broker, and the decision is recorded on its timeline so the desk's record shows a call that was declined rather than one that was never made. Like approval, this executes the owner's decision and never your reading of the proposal; a proposal you find unconvincing is a case to put to him, not one to close.",
    {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Action id from list_actions (AAC…).' } },
      additionalProperties: false,
    },
    async (args: { id: string }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const action = await lifecycle.decideAction(ownerId, args.id, 'rejected');
        return buildDeskToolResponse({ action: compactAction(action) });
      } catch (error) {
        return buildDeskErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'set_execution_gate',
    "Set whether the desk may act unattended. `per_action` means every proposal waits for the owner's approval; `fully_autonomous` means the desk approves and executes its own proposals within the mandate's bounds and the fourteen ceilings, with no human in the loop for that cycle. This is the single most consequential setting on the surface: it is the owner handing over the wheel, so set it ONLY on his explicit instruction, and never as a step toward getting some other task done. It cannot widen a ceiling, change the mandate or arm the live broker — those are untouched by this tool, and only `set_ceilings` moves a ceiling — and the kill switch overrides it either way. Paper only.",
    {
      type: 'object',
      required: ['gate'],
      properties: {
        gate: {
          type: 'string',
          enum: ['per_action', 'fully_autonomous'],
          description: 'per_action = the owner approves each trade. fully_autonomous = the desk acts on its own.',
        },
      },
      additionalProperties: false,
    },
    async (args: { gate: AlpacaExecutionGate }, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const control = await lifecycle.setControl(ownerId, DESK_ENVIRONMENT, { executionGate: args.gate });
        return buildDeskToolResponse({ control });
      } catch (error) {
        return buildDeskErrorResponse(error);
      }
    },
  );

  mcp.tool(
    'set_ceilings',
    "Change the deterministic ceilings the desk is checked against — the per-order and per-day caps, the options limits, the allow/deny lists. Send only the fields you are changing; the rest keep their stored values. A number must be >= 0; `null` means NO CAP for that ceiling, which is a removal of a safety limit and not a default you should reach for. These ceilings are the owner's risk appetite, so set them ONLY on his explicit instruction and never to clear a blockage you ran into — a proposal stopped by `max_orders_per_day` is a fact to report to him, not a number to raise. Raising a ceiling is recorded in the server log and in the control's version history. This cannot arm the live broker or change the mandate, and the kill switch overrides every ceiling either way. Paper only.",
    {
      type: 'object',
      minProperties: 1,
      properties: {
        maxOrdersPerDay: { type: ['number', 'null'], minimum: 0, description: 'Orders per UTC day. null = uncapped.' },
        maxNotionalPerOrder: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Largest single order, in dollars. null = uncapped.',
        },
        maxDailyNotional: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Total traded notional per UTC day. null = uncapped.',
        },
        maxPositionPct: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Largest position as a % of equity. null = uncapped.',
        },
        cooldownAfterFailureMs: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Pause after a failed order, in ms. null = none.',
        },
        optionsEnabled: { type: 'boolean', description: 'Whether option orders may be proposed at all.' },
        maxContractsPerOrder: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Contracts in one order. null = uncapped.',
        },
        maxContractsPerUnderlying: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Open contracts per underlying. null = uncapped.',
        },
        maxShortCallCoveredPct: {
          type: ['number', 'null'],
          minimum: 0,
          description: '% of a holding that may be written against. null = uncapped.',
        },
        minDaysToExpiry: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Shortest allowed expiry, in days. null = no floor.',
        },
        maxDaysToExpiry: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Longest allowed expiry, in days. null = no ceiling.',
        },
        requireOtm: { type: 'boolean', description: 'Whether a strike must be out of the money.' },
        minStrikeVsCostBasisPct: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Covered-call strike floor as a % of cost basis. null = no floor.',
        },
        maxAbsDelta: { type: ['number', 'null'], minimum: 0, description: 'Largest |delta| allowed. null = uncapped.' },
        earningsBlackoutDays: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Days around earnings to refuse. null = no blackout.',
        },
        symbolAllowList: {
          type: 'array',
          items: { type: 'string' },
          description: 'If non-empty, ONLY these tickers may trade.',
        },
        symbolDenyList: { type: 'array', items: { type: 'string' }, description: 'Tickers that may never trade.' },
      },
      additionalProperties: false,
    },
    async (args: Partial<AlpacaControlLimits>, extra: unknown) => {
      try {
        const ownerId = resolveMcpTokenOwnerId(extra);
        const control = await lifecycle.setControl(ownerId, DESK_ENVIRONMENT, { limits: args });
        return buildDeskToolResponse({ control });
      } catch (error) {
        return buildDeskErrorResponse(error);
      }
    },
  );
}
