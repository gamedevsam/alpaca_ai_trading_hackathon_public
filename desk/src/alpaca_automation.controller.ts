import {
  BadRequestException,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { API_VERSION } from '~/modules/config';
import { ALPACA_LIVE_TRIGGER_TOKEN, ALPACA_PAPER_TRIGGER_TOKEN } from '~/server_config';
import { timingSafeEqualString } from '~/utilities/crypto_utilities';
import { Public } from '~/utilities/decorators/public.decorator';
import { AlpacaEnvironment } from './alpaca.types';
import { AlpacaTradeCycleService } from './alpaca_trade_cycle.service';

/**
 * Alpaca trade-cycle webhook trigger (B55). Mirrors `StocksAutomationController`'s timing-safe
 * bearer-token pattern exactly: `@Public()` (opts out of Basic Auth only, no JWT session — this is
 * for an external scheduler like Cronicle) + an inline constant-time token check, hard-failing if
 * unconfigured. Alongside the owner's manual in-app button (`AlpacaController.runTradeCycle`), this is
 * the ONLY way `AlpacaTradeCycleService.runCycle` fires — there is deliberately no in-app `@Cron`
 * (owner directive, see `alpaca_trade_cycle.service.ts`).
 *
 * Per-environment URLs by design (BACKLOG.md B55/B54): each environment has its OWN distinct trigger
 * token — the URL selects the account. `.../trade-cycle/paper` (ALPACA_PAPER_TRIGGER_TOKEN) runs paper;
 * `.../trade-cycle/live` (ALPACA_LIVE_TRIGGER_TOKEN) runs live. Firing the live URL is necessary but NOT
 * sufficient to move real money: the cycle still fails closed unless the owner has armed
 * `alpaca_control.liveArmed` (enforced in `AlpacaLifecycleService.createEnvironmentClient`). So real money
 * moves only when the owner both (a) arms the live toggle AND (b) fires the live URL — two independent
 * owner actions. Neither the token nor the toggle alone is enough (B54).
 */
@Public()
@ApiTags('alpaca')
@Controller({ path: 'alpaca/automation', version: API_VERSION })
export class AlpacaAutomationController {
  constructor(private readonly tradeCycle: AlpacaTradeCycleService) {}

  @Post('trade-cycle/:environment')
  async triggerTradeCycle(@Req() request: FastifyRequest, @Param('environment') environment: string) {
    if (environment !== 'paper' && environment !== 'live') {
      throw new BadRequestException(`Unknown Alpaca environment "${environment}" — expected "paper" or "live".`);
    }
    const env: AlpacaEnvironment = environment;

    // Each environment authenticates with its own distinct token; the live URL is refused until the owner
    // configures ALPACA_LIVE_TRIGGER_TOKEN (which, like arming liveArmed, is a deliberate owner action).
    const expectedToken = env === 'live' ? ALPACA_LIVE_TRIGGER_TOKEN : ALPACA_PAPER_TRIGGER_TOKEN;
    if (!expectedToken) {
      const varName = env === 'live' ? 'ALPACA_LIVE_TRIGGER_TOKEN' : 'ALPACA_PAPER_TRIGGER_TOKEN';
      throw new InternalServerErrorException(`${varName} is not configured`);
    }
    const authorizationHeader = String(request.headers.authorization ?? '');
    const expectedAuthorization = `Bearer ${expectedToken}`;
    if (!timingSafeEqualString(authorizationHeader, expectedAuthorization)) {
      throw new ForbiddenException('Invalid Alpaca trade-cycle trigger token');
    }

    // For live, this fails closed inside the cycle unless liveArmed is set — the token got us this far,
    // the armed toggle is the second, independent gate that actually permits a live broker client.
    return this.tradeCycle.runCycleForOwner(env);
  }
}
