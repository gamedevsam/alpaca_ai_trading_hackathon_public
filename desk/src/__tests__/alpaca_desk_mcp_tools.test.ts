// H2c — the desk's four tools on the portfolio-manager MCP surface.
//
// The lifecycle service is already covered by its own suite; what these tests hold is the wrapper's own
// contract, and specifically the three things a wrapper gets wrong silently: the paper clamp (a `live`
// argument must not exist, let alone reach the service), the status filter (filtering a page that was
// already cut returns an empty list that reads as "there are none"), and the error mapping (a deliberate
// 409 refusal must not arrive looking like a fault).

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AjvMcpServer } from '~/api/admin/mcp/lib/@modelcontextprotocol/sdk/ajv_mcp_server';
import type { AlpacaLifecycleService } from '../alpaca_lifecycle.service';
import { registerDeskTools } from '../alpaca_desk_mcp_tools';

const OWNER = 'usr_owner';
const extra = { authInfo: { extra: { userId: OWNER } } };

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, any>;
  callback: (args: object, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

function fakeAction(id: string, status: string) {
  return {
    id,
    body: {
      status,
      symbol: 'SPY260116P00600000',
      side: 'sell',
      qty: 1,
      limitPrice: 5.25,
      orderType: 'limit',
      timeInForce: 'day',
      rationale: 'CSP on SPY',
      clearedLimits: [],
      signalIds: [],
      events: [],
    },
  } as any;
}

const control = { killState: 'running', mode: 'sandbox', liveArmed: false, executionGate: 'per_action', limits: {} };

function setup(lifecycle: Partial<AlpacaLifecycleService>) {
  const tools = new Map<string, RegisteredTool>();
  const mcp = {
    tool: (name: string, description: string, schema: Record<string, any>, callback: RegisteredTool['callback']) => {
      tools.set(name, { name, description, schema, callback });
    },
  } as unknown as AjvMcpServer;
  registerDeskTools(mcp, lifecycle as AlpacaLifecycleService);
  return {
    tools,
    call: async (name: string, args: object = {}) => {
      const result = await tools.get(name)!.callback(args, extra);
      return JSON.parse(result.content[0].text);
    },
  };
}

describe('registerDeskTools', () => {
  it('registers exactly the five desk tools', () => {
    const { tools } = setup({});
    expect([...tools.keys()]).toEqual([
      'list_actions',
      'approve_action',
      'reject_action',
      'set_execution_gate',
      'set_ceilings',
    ]);
  });

  it('offers no way to name an environment — live is not reachable from this surface', () => {
    const { tools } = setup({});
    for (const tool of tools.values()) {
      expect(Object.keys(tool.schema.properties ?? {})).not.toContain('environment');
      expect(tool.schema.additionalProperties).toBe(false);
    }
  });
});

describe('list_actions', () => {
  it('clamps to paper and reports the gate alongside the rows', async () => {
    const listActions = jest.fn().mockResolvedValue([fakeAction('AAC1', 'proposed')]);
    const getControl = jest.fn().mockResolvedValue(control);
    const { call } = setup({ listActions, getControl } as any);

    const payload = await call('list_actions');

    expect(listActions).toHaveBeenCalledWith(OWNER, 'paper', 25);
    expect(getControl).toHaveBeenCalledWith(OWNER, 'paper');
    expect(payload.environment).toBe('paper');
    expect(payload.control.executionGate).toBe('per_action');
    expect(payload.count).toBe(1);
    expect(payload.actions[0]).toMatchObject({ id: 'AAC1', status: 'proposed', rationale: 'CSP on SPY' });
  });

  it('finds a filtered status that falls outside the default page', async () => {
    // 25 fills then one discard: filtering a 25-row page would answer "none", which is the exact lie the
    // widened fetch exists to prevent — the discarded proposal is the one the judge page pins first.
    const actions = [...Array(25)].map((_, i) => fakeAction(`AAC${i}`, 'filled'));
    actions.push(fakeAction('AAC_DISCARDED', 'discarded'));
    const listActions = jest.fn().mockResolvedValue(actions);
    const { call } = setup({ listActions, getControl: jest.fn().mockResolvedValue(control) } as any);

    const payload = await call('list_actions', { status: 'discarded' });

    expect(listActions).toHaveBeenCalledWith(OWNER, 'paper', 100);
    expect(payload.count).toBe(1);
    expect(payload.actions[0].id).toBe('AAC_DISCARDED');
    expect(payload.truncated).toBe(false);
  });

  it('reports truncation rather than quietly dropping rows', async () => {
    const listActions = jest.fn().mockResolvedValue([...Array(5)].map((_, i) => fakeAction(`AAC${i}`, 'filled')));
    const { call } = setup({ listActions, getControl: jest.fn().mockResolvedValue(control) } as any);

    const payload = await call('list_actions', { status: 'filled', limit: 2 });

    expect(payload.count).toBe(2);
    expect(payload.truncated).toBe(true);
  });
});

describe('approve_action / reject_action', () => {
  it('passes the decision through to the guarded execute', async () => {
    const decideAction = jest.fn().mockResolvedValue(fakeAction('AAC1', 'filled'));
    const { call } = setup({ decideAction } as any);

    const payload = await call('approve_action', { id: 'AAC1' });

    expect(decideAction).toHaveBeenCalledWith(OWNER, 'AAC1', 'approved');
    expect(payload.action.status).toBe('filled');
  });

  it('returns a discarded action as the answer — approval is not permission to execute', async () => {
    // The service fails closed when conditions moved since the proposal. The wrapper must report that
    // outcome as a normal result, not swallow it or dress it up as success.
    const decideAction = jest.fn().mockResolvedValue(fakeAction('AAC1', 'discarded'));
    const { call } = setup({ decideAction } as any);

    expect((await call('approve_action', { id: 'AAC1' })).action.status).toBe('discarded');
  });

  it('records a rejection', async () => {
    const decideAction = jest.fn().mockResolvedValue(fakeAction('AAC1', 'rejected'));
    const { call } = setup({ decideAction } as any);

    await call('reject_action', { id: 'AAC1' });

    expect(decideAction).toHaveBeenCalledWith(OWNER, 'AAC1', 'rejected');
  });

  it('names a deliberate refusal as a conflict, not a fault', async () => {
    const decideAction = jest
      .fn()
      .mockRejectedValue(new ConflictException('Action AAC1 is filled, not awaiting approval.'));
    const { call } = setup({ decideAction } as any);

    const payload = await call('approve_action', { id: 'AAC1' });

    expect(payload.error.code).toBe('CONFLICT');
    expect(payload.error.message).toContain('not awaiting approval');
  });

  it('names a missing action as not found', async () => {
    const decideAction = jest.fn().mockRejectedValue(new NotFoundException('No such action.'));
    const { call } = setup({ decideAction } as any);

    expect((await call('reject_action', { id: 'AAC9' })).error.code).toBe('NOT_FOUND');
  });
});

describe('set_execution_gate', () => {
  it('writes the gate and nothing else — it cannot widen a ceiling or arm live as a side effect', async () => {
    const setControl = jest.fn().mockResolvedValue({ ...control, executionGate: 'fully_autonomous' });
    const { call } = setup({ setControl } as any);

    const payload = await call('set_execution_gate', { gate: 'fully_autonomous' });

    expect(setControl).toHaveBeenCalledWith(OWNER, 'paper', { executionGate: 'fully_autonomous' });
    expect(payload.control.executionGate).toBe('fully_autonomous');
    expect(payload.control.liveArmed).toBe(false);
  });

  it('accepts only the two known gates', () => {
    const { tools } = setup({});
    expect(tools.get('set_execution_gate')!.schema.properties.gate.enum).toEqual(['per_action', 'fully_autonomous']);
  });
});
