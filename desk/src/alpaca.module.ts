import { Module } from '@nestjs/common';
import { EntityModule } from '~/entity/entity.module';
import { ForumModule } from '~/api/forum/forum.module';
import { PredictionLedgerModule } from '~/api/user/prediction_ledger/prediction_ledger.module';
import { TargetEngineModule } from '~/api/user/target_engine/target_engine.module';
import { AlpacaAutomationController } from './alpaca_automation.controller';
import { AlpacaController } from './alpaca.controller';
import { AlpacaChannelService } from './alpaca_channel.service';
import { AlpacaDeskLedgerService } from './alpaca_desk_ledger.service';
import { AlpacaLifecycleService } from './alpaca_lifecycle.service';
import { AlpacaMandateService } from './alpaca_mandate.service';
import { AlpacaPublicController } from './alpaca_public.controller';
import { AlpacaPublicDeskService } from './alpaca_public_desk.service';
import { AlpacaSignalService } from './alpaca_signal.service';
import { AlpacaTradeCycleService } from './alpaca_trade_cycle.service';

/**
 * Alpaca module (B26 slices 1c–1d, B45, B49, B50). Provides the action-lifecycle service that proposes
 * schema-validated `alpaca_action`s through the deterministic safeguards and executes an approved action
 * (equity since B45, options since B50) through `submitted → filled → reconciled` against the simulated
 * broker; the mandate service (B49 — mandate CRUD + the persona-driven simulated dry-run); the trade-cycle
 * service (B50 — the callable evaluate→propose→reconcile cycle + options expiration/assignment
 * settlement, trigger-agnostic — nothing here schedules itself, B55 wires the manual/webhook trigger);
 * plus (H13/H14) the followed-YouTube-channel intake and the signal extractor behind the desk's edge —
 * no HTTP surface by design, their only front door is MCP; extraction writes falsifiable claims to the
 * prediction ledger, which is why this module imports it (a one-way edge: nothing in the ledger knows
 * about the desk) — and (H8) the desk's own proposals are written there too, by
 * `AlpacaDeskLedgerService`, so the desk and the creators it listens to are graded by one instrument;
 * plus (H7) `AlpacaPublicController` — the desk's ONLY session-less read, a hand-built projection for the
 * hackathon judge's `/desk` page with no write path anywhere on it; plus the session-auth'd HTTP surface
 * (`AlpacaController`) for the read-only account view +
 * propose/approve/reject flow behind `ff=alpaca`, and (B55) `AlpacaAutomationController` — a `@Public()`
 * bearer-token webhook + the owner's manual trigger route that are the ONLY two things allowed to fire
 * the trade cycle. No `@Cron`, no real money — every broker call today reaches the deterministic
 * simulated client only.
 */
@Module({
  imports: [EntityModule, ForumModule, PredictionLedgerModule, TargetEngineModule],
  controllers: [AlpacaController, AlpacaAutomationController, AlpacaPublicController],
  providers: [
    AlpacaChannelService,
    AlpacaDeskLedgerService,
    AlpacaLifecycleService,
    AlpacaMandateService,
    AlpacaPublicDeskService,
    AlpacaSignalService,
    AlpacaTradeCycleService,
  ],
  exports: [
    AlpacaChannelService,
    AlpacaDeskLedgerService,
    AlpacaLifecycleService,
    AlpacaMandateService,
    AlpacaSignalService,
    AlpacaTradeCycleService,
  ],
})
export class AlpacaModule {}
