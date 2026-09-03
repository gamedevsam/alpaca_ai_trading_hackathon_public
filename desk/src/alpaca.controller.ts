import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccessTokenAuthGuard } from '~/api/auth/guards/access_token_auth.guard';
import { JwtSession } from '~/api/auth/utilities/jwt_utilities';
import { API_VERSION } from '~/modules/config';
import { Public } from '~/utilities/decorators/public.decorator';
import { Session } from '~/utilities/decorators/session.decorator';
import { AlpacaEnvironment } from './alpaca.types';
import { AlpacaLifecycleService, ProposeActionInput, SetControlInput } from './alpaca_lifecycle.service';
import { AlpacaMandateService, CreateMandateInput, UpdateMandateInput } from './alpaca_mandate.service';
import { AlpacaTradeCycleService } from './alpaca_trade_cycle.service';

/**
 * Alpaca HTTP surface (B26 slice 1d). Read-only account/positions view, the `draft → proposed`
 * propose-a-trade flow, and (B45) the guarded `approved → submitted → filled → reconciled` execute
 * spine, all against the deterministic SIMULATED broker. Session-auth'd like the
 * forum/stocks controllers: `@Public()` opts out of the Basic-Auth perimeter,
 * `AccessTokenAuthGuard` requires a logged-in JWT (owner only).
 *
 * Today every route is backed by the deterministic simulated client; tomorrow's paper key swaps the
 * broker at `createAlpacaClient` with zero changes here (B51).
 */
@Public()
@ApiTags('alpaca')
@UseGuards(AccessTokenAuthGuard)
@Controller({ path: 'alpaca', version: API_VERSION })
export class AlpacaController {
  constructor(
    private readonly lifecycle: AlpacaLifecycleService,
    private readonly mandates: AlpacaMandateService,
    private readonly tradeCycle: AlpacaTradeCycleService,
  ) {}

  /** One call powers the read-only page: broker account/positions/clock + the owner's control + recent actions. */
  @Get('overview')
  async overview(@Session() session: JwtSession, @Query('environment') environment?: string) {
    const env = normalizeEnvironment(environment);
    const [view, control, actions] = await Promise.all([
      this.lifecycle.readAccount(session.userId, env),
      this.lifecycle.getControl(session.userId, env),
      this.lifecycle.listActions(session.userId, env),
    ]);
    return { ...view, control, actions };
  }

  /**
   * H4 — set the owner's runtime controls: the autonomy gate (`executionGate`) and the kill switch.
   * Paper-clamped like every other route here, and deliberately narrow — it cannot touch `mode`,
   * `liveArmed` or any ceiling, so flipping autonomy on can never widen a limit as a side effect.
   */
  @Post('control')
  async setControl(@Session() session: JwtSession, @Body() body: SetControlInput) {
    const control = await this.lifecycle.setControl(session.userId, normalizeEnvironment(), body);
    return { control };
  }

  /** Run a proposed trade through the deterministic safeguards and persist the resulting action. */
  @Post('propose')
  async propose(@Session() session: JwtSession, @Body() body: ProposeActionInput) {
    const action = await this.lifecycle.proposeAction(session.userId, body);
    return { action };
  }

  /**
   * Owner approves a `proposed` action (B16) — authenticated (the JWT owner), so no login-free token.
   * Approval immediately hands off to the guarded execute (B45): every safeguard is re-checked against
   * fresh broker state before an order is submitted, so the returned action may come back `discarded`
   * (conditions changed) rather than executed, even though the owner approved it.
   */
  @Post('actions/:id/approve')
  async approve(@Session() session: JwtSession, @Param('id') id: string) {
    const action = await this.lifecycle.decideAction(session.userId, id, 'approved');
    return { action };
  }

  /** Owner rejects a `proposed` action (B16) — records the decision and stops the action. */
  @Post('actions/:id/reject')
  async reject(@Session() session: JwtSession, @Param('id') id: string) {
    const action = await this.lifecycle.decideAction(session.userId, id, 'rejected');
    return { action };
  }

  /** List the owner's option mandates (B49) — the strategy lives here, not in code. */
  @Get('mandates')
  async listMandates(@Session() session: JwtSession) {
    return { mandates: await this.mandates.list(session.userId) };
  }

  /** Create a new mandate — starts `draft`/`sandbox`, paper-only until B54's owner-armed promotion. */
  @Post('mandates')
  async createMandate(@Session() session: JwtSession, @Body() body: CreateMandateInput) {
    return { mandate: await this.mandates.create(session.userId, body) };
  }

  /** Edit a mandate's SOUL text, provider/model, or option-strategy bounds. Fully versioned for free. */
  @Post('mandates/:id')
  async updateMandate(@Session() session: JwtSession, @Param('id') id: string, @Body() body: UpdateMandateInput) {
    return { mandate: await this.mandates.update(session.userId, id, body) };
  }

  /**
   * The simulated dry-run (B49): generate today's bounds-eligible covered-call/CSP candidates, let the
   * persona pick, and propose its picks through the unchanged `proposeAction` safeguards. Always paper,
   * always stops at `proposed`/`discarded` — never executes.
   */
  @Post('mandates/:id/dry-run')
  async dryRunMandate(@Session() session: JwtSession, @Param('id') id: string) {
    return this.mandates.dryRun(session.userId, id);
  }

  /**
   * The owner's manual "Run evaluation now" trigger (B55) — the same `AlpacaTradeCycleService.runCycle`
   * the paper webhook (`AlpacaAutomationController`) fires, just session-auth'd instead of bearer-token'd.
   * Clamped to paper like every other route on this controller today.
   */
  @Post('cycle/run')
  async runTradeCycle(@Session() session: JwtSession) {
    return this.tradeCycle.runCycle(session.userId, 'paper');
  }
}

// Slice 1 is paper-only and `createAlpacaClient` throws on `live`, so clamp every request to `paper`
// here — a stray `?environment=live` can never select (and 500 on) an environment we don't yet support.
// A later live slice flips this clamp on; the param stays the single axis so callers don't change.
function normalizeEnvironment(_value?: string): AlpacaEnvironment {
  return 'paper';
}
