import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AccessTokenAuthGuard } from '~/api/auth/guards/access_token_auth.guard';
import { API_VERSION } from '~/modules/config';
import { Public } from '~/utilities/decorators/public.decorator';
import { AlpacaPublicDeskService, PublicDeskView } from './alpaca_public_desk.service';

/**
 * The desk's one read, behind `/alpaca/public/*` so the boundary stays legible in the URL.
 *
 * "Public" here names the *projection*, not the audience: nothing on this deployment answers a stranger.
 * `@Public()` opts out of the Basic-Auth perimeter only, and `AccessTokenAuthGuard` still demands the
 * owner's JWT — the same pairing `AlpacaController` uses. The marketing site is hosted separately; every
 * page on this host requires a login.
 *
 * The projection is what makes it safe to widen the audience later, if that is ever wanted:
 * `AlpacaPublicDeskService` decides field by field what may be shown (mandate, gate, headline paper
 * figures, proposals with their ceilings, the creators' calls, the scorecards) and nothing else reaches
 * the wire. There is deliberately no write, no parameter and no environment switch here — every mutation,
 * and the autonomy toggle above all, lives on the controller beside it.
 */
@Public()
@ApiTags('alpaca')
@UseGuards(AccessTokenAuthGuard)
@Controller({ path: 'alpaca/public', version: API_VERSION })
export class AlpacaPublicController {
  constructor(private readonly desk: AlpacaPublicDeskService) {}

  /** The whole `/desk` page in one call — memoized in the service, so polling costs the broker nothing. */
  @Get('desk')
  async getDesk(): Promise<PublicDeskView> {
    return this.desk.getDesk();
  }
}
