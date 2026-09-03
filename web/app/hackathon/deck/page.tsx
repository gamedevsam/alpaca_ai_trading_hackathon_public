import type { ReactNode } from 'react';
import { DeckNav } from './deck-nav';

/**
 * The MANDATE deck — the eight slides the owner presents on screen, and, printed at
 * 16in × 9in, the submission PDF (see deck.css for the two renderings).
 *
 * Every figure, quote and ceiling name on these slides is read off the live paper desk at
 * https://alpaca-ai-hackathon.dataconnector-pro.com/desk on 2026-09-03, and the screenshots
 * are captures of that same page. A deck that invents a number cannot be checked against the
 * record it is claiming to be proud of, so nothing here is illustrative.
 */

const ACCOUNT_ID = 'PA3R6NNBYGML';
const REPO_URL = 'https://github.com/gamedevsam/alpaca_ai_trading_hackathon_public';

/** The eleven that score any order, in the order the checker runs them. */
const GENERAL_CEILINGS = [
  ['kill_switch', 'Anything at all, when the owner has killed the desk'],
  ['order_request', 'A malformed order'],
  ['symbol_tradable', 'A symbol the broker does not list'],
  ['symbol_not_denied', 'Anything on the deny-list'],
  ['symbol_allowed', 'Anything off the allow-list'],
  ['sufficient_holdings', 'Selling more shares than are held'],
  ['buying_power', 'A buy the account cannot fund'],
  ['max_notional_per_order', 'One order above the dollar cap'],
  ['max_position_pct', 'A name pushed past its weight cap'],
  ['max_orders_per_day', 'The runaway case'],
  ['max_daily_notional', 'Too much money moved in a day'],
];

/** The ten more that an option order additionally has to clear. */
const OPTION_CEILINGS = [
  ['options_enabled', 'Every option order, when options are off'],
  ['defined_risk_floor', 'Any naked short option, ever'],
  ['max_contracts_per_order', 'An oversized single option order'],
  ['max_contracts_per_underlying', 'Stacking contracts on one name'],
  ['short_call_coverage_pct', 'Signing away too much upside'],
  ['dte_bounds', 'An expiry outside the window'],
  ['strike_otm', 'A strike that is not out of the money'],
  ['strike_vs_cost_basis', 'A covered call struck below cost'],
  ['delta_ceiling', 'More likely to be assigned than allowed'],
  ['earnings_proximity', 'Writing through an earnings blackout'],
];

/** The record as of the capture below — deliberately stated with its own caveat attached. */
const RECORD = [
  ['16', 'actions on the record'],
  ['11', 'stopped by a ceiling'],
  ['5', 'sent to the broker'],
  ['4', 'refused by the broker'],
  ['18', 'creator claims filed'],
];

function Kicker({ index, label }: { index: string; label: string }) {
  return (
    <div className="deck-muted flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.22em] sm:text-[11px]">
      <span className="deck-accent tabular-nums">{index}</span>
      <span aria-hidden className="h-px w-8 bg-current opacity-30" />
      <span>{label}</span>
    </div>
  );
}

function Slide({ children }: { children: ReactNode }) {
  return (
    <section className="deck-slide px-7 pt-14 pb-24 sm:px-14 sm:pb-14 xl:px-20">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 sm:gap-8">{children}</div>
    </section>
  );
}

function Headline({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const size = compact
    ? 'text-[1.6rem] sm:text-[2rem] xl:text-[2.35rem]'
    : 'text-[1.75rem] sm:text-4xl xl:text-[2.9rem]';
  return <h2 className={`font-display max-w-4xl leading-[1.15] font-medium tracking-tight ${size}`}>{children}</h2>;
}

function Lead({ children }: { children: ReactNode }) {
  return <p className="deck-muted max-w-3xl text-sm leading-relaxed sm:text-base xl:text-lg">{children}</p>;
}

/**
 * Argument on the left, the live desk on the right. A 16:9 slide is far wider than it is tall,
 * so a screenshot stacked under a headline overflows the page it has to print onto — splitting
 * the slide is what keeps every one of these to a single printed page.
 */
function Split({ children }: { children: ReactNode }) {
  return <div className="grid items-center gap-8 lg:grid-cols-[0.95fr_1.1fr] lg:gap-12">{children}</div>;
}

/**
 * A capture of the live desk. It links to itself because at a phone width the desk's own dense
 * type shrinks past reading size, and opening the raw image is the only way to read it there.
 */
function Shot({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  return (
    <a href={src} className="deck-shot block" aria-label={`Open the full-size capture: ${alt}`}>
      <img src={src} alt={alt} width={width} height={height} className="block w-full" />
    </a>
  );
}

/**
 * The architecture, drawn rather than described: three inputs converge on one inference call,
 * whose only outward arrow points *into* the ceilings. That containment is the whole claim of
 * the project, so the diagram is built to make a path around them visibly absent.
 */
function ArchitectureDiagram() {
  const inputs = [
    { y: 40, title: 'Mandate', sub: 'human-approved prose, versioned' },
    { y: 168, title: 'Alpaca', sub: 'account · positions · option chain' },
    { y: 296, title: 'Creator signals', sub: 'graded, falsifiable claims' },
  ];
  return (
    <svg
      viewBox="0 0 1160 400"
      role="img"
      aria-label="Three inputs — the mandate, the Alpaca account and option chain, and the creators' signals — feed one LLM call. Its only output goes into 21 deterministic ceilings, which either clear a proposal through the Alpaca CLI to the broker or discard it with the reason kept."
      className="w-full"
      style={{ color: 'var(--slide-fg)' }}
    >
      <defs>
        <marker id="deck-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,1 L9,5 L0,9" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.55" />
        </marker>
      </defs>

      {inputs.map((input) => (
        <g key={input.title}>
          <rect
            x="8"
            y={input.y}
            width="278"
            height="64"
            rx="10"
            fill="var(--slide-surface)"
            stroke="var(--slide-line)"
          />
          <text x="26" y={input.y + 27} fontSize="14" fontWeight="600" fill="currentColor">
            {input.title}
          </text>
          <text x="26" y={input.y + 47} fontSize="12" fill="var(--slide-muted)">
            {input.sub}
          </text>
        </g>
      ))}

      {/* The three arrows. They converge, because there is exactly one inference call per cycle. */}
      <path
        d="M292,72 C328,72 322,190 348,193"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.55"
        markerEnd="url(#deck-arrow)"
      />
      <path
        d="M292,200 L348,200"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.55"
        markerEnd="url(#deck-arrow)"
      />
      <path
        d="M292,328 C328,328 322,210 348,207"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.55"
        markerEnd="url(#deck-arrow)"
      />

      <rect x="356" y="152" width="228" height="96" rx="10" fill="var(--slide-surface)" stroke="var(--slide-line)" />
      <text x="470" y="188" fontSize="13" fontWeight="600" textAnchor="middle" fill="currentColor">
        ONE LLM CALL
      </text>
      <text x="470" y="211" fontSize="12" textAnchor="middle" fill="var(--slide-muted)">
        proposes contracts,
      </text>
      <text x="470" y="229" fontSize="12" textAnchor="middle" fill="var(--slide-muted)">
        argues for each one
      </text>

      <path
        d="M590,200 L634,200"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        opacity="0.55"
        markerEnd="url(#deck-arrow)"
      />

      <rect
        x="642"
        y="146"
        width="238"
        height="108"
        rx="10"
        fill="none"
        stroke="var(--slide-accent)"
        strokeWidth="1.6"
      />
      <text x="761" y="182" fontSize="13" fontWeight="600" textAnchor="middle" fill="var(--slide-accent)">
        21 DETERMINISTIC CEILINGS
      </text>
      <text x="761" y="205" fontSize="12" textAnchor="middle" fill="var(--slide-muted)">
        plain code, no model
      </text>
      <text x="761" y="223" fontSize="12" textAnchor="middle" fill="var(--slide-muted)">
        input, run twice
      </text>

      <path
        d="M886,180 C914,180 906,104 930,104"
        fill="none"
        stroke="var(--slide-accent)"
        strokeWidth="1.6"
        opacity="0.8"
        markerEnd="url(#deck-arrow)"
      />
      <path
        d="M886,220 C914,220 906,300 930,300"
        fill="none"
        stroke="var(--slide-warn)"
        strokeWidth="1.6"
        opacity="0.8"
        markerEnd="url(#deck-arrow)"
      />
      {/* The branch verdict is a tag inside each outcome box rather than a label on the arrow:
          the curves run diagonally, and text beside them collides at every viewport width. */}
      <rect x="938" y="58" width="214" height="92" rx="10" fill="var(--slide-surface)" stroke="var(--slide-line)" />
      <text x="958" y="80" fontSize="9.5" fontWeight="600" letterSpacing="1.4" fill="var(--slide-accent)">
        CLEARED
      </text>
      <text x="958" y="103" fontSize="13" fontWeight="600" fill="currentColor">
        proposed
      </text>
      <text x="958" y="123" fontSize="11.5" fill="var(--slide-muted)">
        alpaca order submit
      </text>
      <text x="958" y="140" fontSize="11.5" fill="var(--slide-muted)">
        → the broker
      </text>

      <rect x="938" y="254" width="214" height="92" rx="10" fill="var(--slide-surface)" stroke="var(--slide-line)" />
      <text x="958" y="276" fontSize="9.5" fontWeight="600" letterSpacing="1.4" fill="var(--slide-warn)">
        FAILED
      </text>
      <text x="958" y="299" fontSize="13" fontWeight="600" fill="currentColor">
        discarded
      </text>
      <text x="958" y="319" fontSize="11.5" fill="var(--slide-muted)">
        the failing ceiling and
      </text>
      <text x="958" y="336" fontSize="11.5" fill="var(--slide-muted)">
        all 21 verdicts kept
      </text>
    </svg>
  );
}

function CeilingList({ title, count, rows }: { title: string; count: string; rows: string[][] }) {
  return (
    <div>
      <p className="deck-muted text-[10px] font-medium uppercase tracking-[0.2em] sm:text-[11px]">
        {title} <span className="deck-accent tabular-nums">{count}</span>
      </p>
      <ul className="deck-rule mt-3 border-t">
        {rows.map(([name, refuses]) => (
          <li key={name} className="deck-rule flex flex-wrap items-baseline gap-x-3 border-b py-[5px]">
            <code className="text-[11px] font-medium sm:text-xs">{name}</code>
            <span className="deck-faint text-[10px] sm:text-[11px]">{refuses}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DeckPage() {
  return (
    <>
      <main className="deck">
        {/* 01 — the thesis, verbatim. */}
        <Slide>
          <Kicker index="01" label="Alpaca AI Trading Agents Hackathon · September 2026" />
          <div>
            <p className="font-display text-5xl leading-none font-semibold tracking-tight sm:text-7xl xl:text-8xl">
              MANDATE
            </p>
            <p className="font-display deck-muted mt-4 text-xl leading-snug italic sm:text-3xl xl:text-[2.6rem]">
              The autonomous options desk that can prove it obeyed.
            </p>
          </div>
          <p className="deck-muted max-w-5xl text-sm leading-relaxed sm:text-base xl:text-xl">
            Most trading agents ask you to trust that the model behaved. This one is built so you never have to: an LLM
            proposes, deterministic code disposes, and every order carries the record of the rules it was measured
            against — including the ones it failed.
          </p>
          <div className="deck-faint flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
            <span>Samuel Batista</span>
            <span aria-hidden>·</span>
            <span>Alpaca paper account — simulated money, never pointed at a live one</span>
          </div>
          <p className="deck-chrome deck-faint hidden text-[11px] sm:block">Use ← → to move through the deck.</p>
        </Slide>

        {/* 02 — the strategy is a document, not a deployment. */}
        <Slide>
          <Split>
            <div className="flex flex-col gap-5">
              <Kicker index="02" label="The mandate" />
              <Headline compact>The strategy is a paragraph a human wrote and approved.</Headline>
              <Lead>
                It is versioned like a document, not shipped like code — change the mandate and the desk changes
                behaviour, change nothing else. Beside it, the autonomy gate says who may act on a proposal; above them
                both, the kill switch is the owner&rsquo;s alone.
              </Lead>
            </div>
            <Shot
              src="/hackathon/desk-mandate.png"
              alt="The live desk showing the Friday Income Desk mandate, the autonomy gate set to fully autonomous, the kill switch armed, and a $100,000 paper account."
              width={1776}
              height={1212}
            />
          </Split>
        </Slide>

        {/* 03 — where the model's output can and cannot go. */}
        <Slide>
          <Kicker index="03" label="Architecture" />
          <Headline>The model&rsquo;s output points into the ceilings, never around them.</Headline>
          {/* Scaled to a phone width the diagram's labels become specks, so below `sm` it keeps a
              readable minimum and scrolls sideways inside its own box instead. */}
          <div className="-mx-1 overflow-x-auto px-1 sm:mx-0 sm:overflow-x-visible sm:px-0">
            <div className="min-w-[640px] sm:min-w-0">
              <ArchitectureDiagram />
            </div>
          </div>
          <Lead>
            One inference call per cycle, and no path from its output to the broker that skips code the model cannot
            see, negotiate or even know the result of.
          </Lead>
        </Slide>

        {/* 04 — the ceilings, by name, because a count is not a claim. */}
        <Slide>
          <Kicker index="04" label="The risk gates" />
          <Headline>Twenty-one named ceilings score every option order.</Headline>
          <div className="grid gap-x-12 gap-y-6 sm:grid-cols-2">
            <CeilingList title="Any order" count="11" rows={GENERAL_CEILINGS} />
            <CeilingList title="Options only" count="10" rows={OPTION_CEILINGS} />
          </div>
          <Lead>
            They fail closed, they run twice — once at proposal and again at execution against the live account — and
            all 21 verdicts are stored on the action, pass and fail.
          </Lead>
        </Slide>

        {/* 05 — the artifact that makes "it obeyed" checkable. */}
        <Slide>
          <Split>
            <div className="flex flex-col gap-5">
              <Kicker index="05" label="The proof bundle" />
              <Headline compact>A refusal is a record, not a silence.</Headline>
              <Lead>
                This proposal cleared 20 of 21 ceilings and was thrown away by the twenty-first — the daily order cap,
                caught by the re-check against the account as it stood at that second, not as it stood when the proposal
                was made.
              </Lead>
              <p className="deck-faint text-xs sm:text-sm">
                Stored on the action: the rationale, all 21 verdicts with the numbers that produced them, and every
                state transition with its timestamp.
              </p>
            </div>
            <Shot
              src="/hackathon/desk-proposal-refused.png"
              alt="A discarded SPY cash-secured put on the desk: the rationale ending in its own falsifiable condition, the failing max_orders_per_day ceiling in amber, all 21 verdicts, and the timestamped event trail through auto-approval to discard."
              width={1604}
              height={1680}
            />
          </Split>
        </Slide>

        {/* 06 — the creators, treated as claimants rather than oracles. */}
        <Slide>
          <Split>
            <div className="flex flex-col gap-5">
              <Kicker index="06" label="Signals" />
              <Headline compact>A creator&rsquo;s call enters as a claim to test, not an instruction.</Headline>
              <Lead>
                Each followed channel&rsquo;s transcript is read once, and every falsifiable claim in it is filed with
                the verbatim quote, a horizon and the condition that would prove it wrong. The desk then has to say, in
                one sentence, why it acted on that claim or declined it.
              </Lead>
              <p className="deck-faint text-xs sm:text-sm">
                18 claims from 3 channels so far, each graded later on its own terms whether or not the desk agreed. The{' '}
                <code>sampleSize 0</code> it cites here is the creator&rsquo;s own record: nothing of his has resolved
                yet, so there is no track record to lean on.
              </p>
            </div>
            <Shot
              src="/hackathon/desk-signal-declined.png"
              alt="A bearish QQQ call by The Patient Investor, quoted verbatim from his video, with the desk's written reason for declining to act on it."
              width={1672}
              height={686}
            />
          </Split>
        </Slide>

        {/* 07 — the honest read: the caveat before the numbers. */}
        <Slide>
          <Split>
            <div className="flex flex-col gap-5">
              <Kicker index="07" label="The record" />
              <Headline compact>A small, legible record beats a large, unfalsifiable one.</Headline>
              <Lead>
                The caveat before the numbers: this is a tiny sample, nothing has been held to expiry, no hit rate is
                claimed, and equity is still exactly its $100,000 start. Eleven of sixteen proposals never left the
                building — that is the desk obeying its ceilings, which is the thing being demonstrated.
              </Lead>
              {/* Five figures across three columns: an even 3 + 2 rather than the ragged 4 + 1
                  a wrapping row produces at the width this column actually gets. */}
              <div className="grid grid-cols-3 gap-x-6 gap-y-5">
                {RECORD.map(([value, label]) => (
                  <div key={label}>
                    <p className="font-display text-3xl leading-none font-medium tabular-nums">{value}</p>
                    <p className="deck-faint mt-1.5 text-[11px] leading-snug">{label}</p>
                  </div>
                ))}
              </div>
              <p className="deck-faint text-xs sm:text-sm">
                Alpaca paper account <code className="font-medium">{ACCOUNT_ID}</code>, read from the running desk on
                2026-09-03. Of the five orders sent, one was accepted and rested until it was cancelled; the four
                refusals were the most useful thing that happened all week, exposing per-name collateral maths and a
                phantom pledge, both since fixed.
              </p>
            </div>
            <Shot
              src="/hackathon/desk-scorecards.png"
              alt="The desk's scorecards: the desk itself with 7 withdrawn claims, and three followed creators with 18 open claims between them, every hit rate withheld as nothing has resolved yet."
              width={1776}
              height={804}
            />
          </Split>
        </Slide>

        {/* 08 — where it goes, and who stands behind it. */}
        <Slide>
          <Kicker index="08" label="What’s next" />
          <Headline>Same desk. More mandates, and a record long enough to grade.</Headline>
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              [
                'Held to expiry',
                'Assignment, roll and settlement graded end to end, so the scorecards start meaning something.',
              ],
              [
                'Many mandates, one account',
                'Several strategies under one owner, each with its own ceilings and its own record.',
              ],
              [
                'Two editions',
                'A hosted cloud desk, and a self-hosted build that ships with the autonomous loop that wrote it.',
              ],
            ].map(([title, body]) => (
              <div key={title} className="deck-rule border-t pt-4">
                <p className="text-sm font-medium sm:text-base">{title}</p>
                <p className="deck-muted mt-2 text-xs leading-relaxed sm:text-sm">{body}</p>
              </div>
            ))}
          </div>
          <div className="deck-rule mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t pt-6">
            <p className="font-display text-xl sm:text-2xl">Samuel Batista</p>
            <a href="/docs/hackathon" className="deck-muted text-xs underline underline-offset-4 sm:text-sm">
              The write-up
            </a>
            <a href={REPO_URL} className="deck-muted text-xs underline underline-offset-4 sm:text-sm">
              The source
            </a>
            <span className="deck-faint text-xs sm:text-sm">MIT licensed · paper only</span>
          </div>
        </Slide>
      </main>
      <DeckNav total={8} />
    </>
  );
}
