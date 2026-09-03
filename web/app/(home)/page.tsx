import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  Cable,
  Check,
  ClipboardCheck,
  Eye,
  Layers,
  MessagesSquare,
  Plug,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { appDescription, appName, appUrl, siteUrl } from '@/lib/shared';

// Structured data for search engines: one SoftwareApplication node for the product.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: appName,
  description: appDescription,
  url: siteUrl,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  offers: {
    '@type': 'AggregateOffer',
    lowPrice: '0',
    highPrice: '19.99',
    priceCurrency: 'USD',
  },
};

const ICON_STROKE = 1.75;

/**
 * Inline link used the first time a strong product term appears in copy. Every
 * target comes from the docs Concepts section (B220), so a stranger can resolve
 * any term in one click without leaving their reading flow.
 */
function Term({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="font-medium text-fd-foreground/90 underline decoration-fd-foreground/35 decoration-dotted underline-offset-[3px] transition hover:text-fd-foreground hover:decoration-fd-foreground"
    >
      {children}
    </Link>
  );
}

/** Numbered section label — the visible structural rhythm of the page. */
function Kicker({ index, label }: { index: string; label: string }) {
  return (
    <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.2em] text-fd-muted-foreground">
      <span className="tabular-nums text-emerald-700 dark:text-emerald-400">{index}</span>
      <span aria-hidden className="h-px w-10 bg-fd-foreground/25" />
      <span>{label}</span>
    </div>
  );
}

/**
 * The hero artifact: a real proposal the desk made and the deterministic ceilings
 * refused, over the mandate that produced it. Every string here is verbatim from a
 * stored action on the paper account (`QQQ260908P00709000`, 2026-09-03) — the point
 * of the composition is that the numbers are checkable, so inventing them would
 * defeat it. Non-interactive decoration, hence aria-hidden on the whole thing.
 */
function MandateIllustration() {
  const ceilings = [
    { limit: 'defined_risk_floor', detail: '$70,900.00 reserved, $100,000.00 available', passed: true },
    { limit: 'delta_ceiling', detail: '|delta| 0.2041 (feed-supplied) vs cap 0.3', passed: true },
    { limit: 'dte_bounds', detail: '4 days to expiry (bounds: 1–10)', passed: true },
    { limit: 'max_orders_per_day', detail: '6 of 6 orders used today', passed: false },
  ];
  return (
    <div aria-hidden className="pointer-events-none select-none">
      {/* flex prevents the front card's top margin from collapsing through the
          wrapper, which would drag the absolutely-positioned back card down. */}
      <div className="relative flex flex-col">
        {/* Back card: the mandate the proposal was reasoned from. */}
        <div className="absolute -top-1 right-0 w-[86%] rotate-[1.5deg] rounded-xl border bg-fd-card p-4 opacity-90 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-fd-muted-foreground">Mandate · Friday Income Desk</p>
            <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium text-fd-muted-foreground">
              approved
            </span>
          </div>
          <p className="font-display mt-2.5 text-sm italic leading-relaxed text-fd-foreground/80">
            &ldquo;Sell cash-secured puts — out of the money, expiring this Friday, at strikes you would be content to
            own the name at… Treat a creator&rsquo;s call as a claim to test, not an instruction.&rdquo;
          </p>
        </div>
        {/* Front card: the discarded proposal. mt clears the back card's full
            content so no line is sliced mid-glyph; the overlap covers only its
            bottom padding. */}
        <div className="relative mt-32 rounded-xl border bg-fd-card p-5 shadow-xl shadow-black/5 dark:shadow-black/30">
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-rose-500" />
            <p className="text-xs font-medium text-fd-muted-foreground">Discarded — did not clear</p>
          </div>
          <p className="mt-3 text-lg font-semibold tracking-tight">QQQ 709 put · sell to open</p>
          <p className="mt-1 text-sm text-fd-muted-foreground">1 contract, limit $1.19. Proposed by the desk agent.</p>
          <div className="mt-4 space-y-2 border-t pt-4">
            {ceilings.map((row) => (
              <div key={row.limit} className="flex items-start gap-2.5">
                {row.passed ? (
                  <Check
                    size={14}
                    strokeWidth={2.5}
                    className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                  />
                ) : (
                  <X size={14} strokeWidth={2.5} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
                )}
                <span className="min-w-0">
                  <span
                    className={`font-mono text-xs ${row.passed ? 'text-fd-foreground/80' : 'font-medium text-rose-600 dark:text-rose-400'}`}
                  >
                    {row.limit}
                  </span>
                  <span className="ml-2 text-xs text-fd-muted-foreground">{row.detail}</span>
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t pt-3 text-xs text-fd-muted-foreground">
            17 further ceilings cleared · all 21 verdicts stored on the action
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs text-fd-muted-foreground">
        A real proposal from the paper desk, refused by a limit the owner set.
      </p>
    </div>
  );
}

// The four questions serious investors already ask — each answered by a named,
// documented capability. This is the "what's in it for you" section.
const questions = [
  {
    q: 'Why do I own this?',
    a: 'Anchor every position to the manager whose conviction put it there — its conviction custodian. A position with no reason left behind it is flagged as an orphan. Flagged, never sold for you.',
    term: 'Conviction custodians',
    href: '/docs/concepts/custodians',
  },
  {
    q: 'Am I actually following them?',
    a: 'Copy fidelity measures your book against each investor you meant to mirror, position by position — including what they hold that you don’t.',
    term: 'Copy fidelity',
    href: '/docs/concepts/custodians#copy-fidelity-are-you-actually-following-them',
  },
  {
    q: 'What did they quietly sell?',
    a: 'Manager books are kept as dated, append-only snapshots. When a position disappears with no disclosed trade, the diff names it: the exit they never mentioned.',
    term: 'Snapshots',
    href: '/docs/concepts/sources#snapshots-are-dated-and-append-only',
  },
  {
    q: 'How many bets am I really making?',
    a: 'Names that move together collapse into effective bets. A 28-stock portfolio can be 23 real bets — or far fewer. Diversification you can count, not guess.',
    term: 'Effective bets',
    href: '/docs/concepts/target#effective-bets-how-many-bets-are-you-really-making',
  },
];

const steps = [
  {
    title: 'Connect',
    icon: Cable,
    body: (
      <>
        Sync your portfolio tracker, import a CSV, or type holdings in. Then record the disclosed books of investors you
        follow as <Term href="/docs/concepts/sources">sources</Term> — dated, append-only, with the origin of every
        number kept.
      </>
    ),
  },
  {
    title: 'Blend',
    icon: SlidersHorizontal,
    body: (
      <>
        Weight those sources by how much you trust them, add your rules — exclusions, position caps, correlation — and
        the <Term href="/docs/concepts/blend">blend</Term> produces one explainable{' '}
        <Term href="/docs/concepts/target">target</Term>. Every line traces back to who believes it, and how strongly.
      </>
    ),
  },
  {
    title: 'Approve',
    icon: BadgeCheck,
    accent: true,
    body: (
      <>
        <Term href="/docs/concepts/reconcile">Reconcile</Term> compares the target with what you actually hold and turns
        the drift into a concrete <Term href="/docs/concepts/reconcile#the-trade-plan">trade plan</Term>. Approve,
        refine, or deny each proposal. Nothing executes on its own.
      </>
    ),
  },
];

/**
 * "What working in it feels like": an illustrative MCP-assistant session.
 * THIS FRAME IS THE FUTURE PRODUCT-TOUR VIDEO SLOT — when the video exists,
 * swap the inner composition for an aspect-video embed; the frame, caption, and
 * surrounding layout stay as they are. (The frame hugs its content today rather
 * than forcing 16:9 — a sparse mock stretched to video proportions reads as
 * dead space on desktop.)
 */
function AssistantVignette() {
  const activity = [
    { label: 'Snapshot #4 recorded', detail: 'append-only · #3 kept' },
    { label: 'Diff vs #3', detail: '1 add · 1 trim · 1 exit' },
    { label: 'Undisclosed exit flagged', detail: 'SHOP · no stated trade', alert: true },
    { label: 'ASML anchored', detail: 'copy fidelity 91.4%' },
  ];
  return (
    <figure className="landing-scroll-rise mt-14">
      <div className="relative overflow-hidden rounded-xl border bg-fd-card shadow-sm">
        <div
          aria-hidden
          className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle,var(--color-fd-border)_1px,transparent_1px)] [background-size:18px_18px]"
        />
        <div className="relative flex h-full flex-col">
          <div className="flex items-center gap-2 border-b px-5 py-3">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <p className="text-xs font-medium text-fd-muted-foreground">Your assistant · connected over MCP</p>
          </div>
          <div className="grid flex-1 gap-px lg:grid-cols-[3fr_2fr]">
            {/* The conversation: the owner states, the assistant executes. */}
            <div className="flex flex-col justify-center gap-4 p-5 sm:p-8">
              <p className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-fd-primary px-4 py-2.5 text-sm text-fd-primary-foreground">
                Here&apos;s the Q2 disclosure from the manager I follow — record it.
              </p>
              <p className="max-w-[92%] rounded-xl rounded-bl-sm border bg-fd-background px-4 py-2.5 text-sm text-fd-foreground/90">
                Recorded as snapshot #4 — append-only, #3 stays. Three changes: added CPNG at 2.1%, trimmed AAPL 6.1% →
                4.8%, and SHOP is gone with <span className="font-medium">no disclosed sale</span> — flagged as an
                undisclosed exit.
              </p>
              <p className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-fd-primary px-4 py-2.5 text-sm text-fd-primary-foreground">
                Anchor my ASML position to their book.
              </p>
              <p className="max-w-[92%] rounded-xl rounded-bl-sm border bg-fd-background px-4 py-2.5 text-sm text-fd-foreground/90">
                Done — ASML&apos;s custodian is now that manager. Your copy fidelity against them is 91.4%.
              </p>
            </div>
            {/* The receipts: every conversational write lands as a legible event. */}
            <div className="flex flex-col justify-center gap-3 border-t p-5 sm:p-8 lg:border-l lg:border-t-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-fd-muted-foreground">
                What just happened
              </p>
              {activity.map((event) => (
                <div key={event.label} className="rounded-lg border bg-fd-card px-3.5 py-2.5">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {event.alert && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
                    {event.label}
                  </p>
                  <p className="mt-0.5 text-xs text-fd-muted-foreground">{event.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-fd-muted-foreground">
        An illustrative session. The assistant does the typing — it can read, file, and fix, but it can never place a
        trade.{' '}
        <Link href="/docs/mcp-assistant" className="font-medium underline underline-offset-2 hover:text-fd-foreground">
          How assistants connect
        </Link>
      </figcaption>
    </figure>
  );
}

// The six product pillars. Substance and docs targets are stable; the bento
// placement (wide / three across / full band) is layout, driven by `cell`.
// `tier` marks paid capabilities so the landing never sells a pillar as
// universally included when pricing gates it.
const pillars: {
  title: string;
  description: ReactNode;
  href: string;
  icon: typeof Layers;
  cell: 'wide' | 'normal' | 'band';
  tier?: string;
  guarantees?: string[];
}[] = [
  {
    title: 'One true book, with receipts',
    description:
      'Tracker sync, CSV import, or manual entry — every account converges on one versioned portfolio. Every number carries provenance (who said it, and when) and freshness that admits its age: a source that has gone quiet reads stale, never fresh-by-default.',
    href: '/docs/concepts/sources',
    icon: Layers,
    cell: 'wide' as const,
  },
  {
    title: 'Managers, on the record',
    description:
      'Record what the investors you follow disclose. Snapshots never overwrite — corrections supersede, history stays. Diffs show every add, trim, and exit, with their stated reasoning attached verbatim.',
    href: '/docs/concepts/managers',
    icon: Eye,
    cell: 'normal' as const,
  },
  {
    title: 'Predictions, scored without flattery',
    description:
      'Log a manager’s public claims verbatim, each with a falsifiable resolution condition. Scorecards refuse to show a hit rate below eight resolved calls — a small sample reads as a small sample, not a track record.',
    href: '/docs/concepts/predictions',
    icon: ClipboardCheck,
    cell: 'normal' as const,
  },
  {
    title: 'An AI Council on your real book',
    description:
      'Chat 1:1 with AI portfolio managers, or put the whole Council on a trade idea and let them debate it — grounded in your actual holdings, not generic takes.',
    href: '/docs/concepts/ai-council',
    icon: MessagesSquare,
    cell: 'normal',
    tier: 'Pro tier',
  },
  {
    title: 'An assistant that does the typing',
    description: (
      <>
        Connect Claude or any assistant that speaks MCP — the open protocol AI assistants use to work other software —
        to your portfolio. It files snapshots, fixes ticker mappings, anchors positions: executing what you state, never
        inferring your judgment. And it can never place a trade.
      </>
    ),
    href: '/docs/mcp-assistant',
    icon: Plug,
    cell: 'normal',
  },
  {
    title: 'Execution that waits for you',
    description:
      'The automated execution manager — built on the Alpaca brokerage — reaches the market only through a gate you hold. Four hard guarantees stand between any idea and real money:',
    href: '/docs/alpaca-portfolio-manager',
    icon: BadgeCheck,
    cell: 'band',
    tier: 'Ultimate tier',
    guarantees: ['Your approval by default', 'Hard-coded risk limits', 'Kill switch', 'Paper-first prove-out'],
  },
];

// The trust model, stated as verifiable properties rather than promises — each
// with the doc page where a skeptic can check the claim.
const proofs = [
  {
    title: 'Approval is a hard boundary',
    body: 'Nothing approves itself unless you have said it may, on a paper account, in a setting only you can change. The risk limits run either way, and the kill switch outranks all of it.',
    proofLabel: 'The execution lifecycle',
    proofHref: '/docs/alpaca-portfolio-manager',
  },
  {
    title: 'Honesty is the default output',
    body: 'Unknown reads unknown. Unrecorded reads not recorded. Stale reads stale. The system admits a gap rather than fabricate a number to fill it.',
    proofLabel: 'How freshness is computed',
    proofHref: '/docs/concepts/sources#freshness-how-old-is-this',
  },
  {
    title: 'Everything is versioned',
    body: 'Portfolios, rules, agents — every change keeps its history. Corrections supersede; nothing is silently overwritten. You can always see what changed, and when.',
    proofLabel: 'Append-only snapshots',
    proofHref: '/docs/concepts/sources#snapshots-are-dated-and-append-only',
  },
  {
    title: 'The AI has hands, not judgment',
    body: 'Your assistant executes the instructions you give it. What you believe, and what you are willing to risk, stay yours to say — it never guesses at either.',
    proofLabel: 'What it can never do',
    proofHref: '/docs/mcp-assistant',
  },
];

export default function HomePage() {
  // A <div>, not <main>: the surrounding HomeLayout already renders the page's
  // single <main> landmark.
  return (
    <div className="flex flex-1 flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      {/* Hero: asymmetric split, copy left, the proposal artifact right. */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 opacity-50 [background-image:radial-gradient(circle,var(--color-fd-border)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_75%_65%_at_50%_0%,black,transparent)]"
        />
        <div
          aria-hidden
          className="absolute -top-32 right-[8%] size-80 rounded-full bg-emerald-500/10 blur-3xl dark:bg-emerald-400/10"
        />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-6 pb-20 pt-14 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pt-24">
          <div>
            <p className="landing-rise flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-fd-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              MANDATE · an autonomous options desk
            </p>
            <h1 className="landing-rise font-display mt-5 max-w-xl text-balance text-5xl font-medium leading-[1.05] tracking-tight sm:text-6xl">
              A trading agent that can <em className="italic">prove</em> it obeyed.
            </h1>
            <p className="landing-rise landing-delay-1 mt-6 max-w-lg text-pretty text-fd-muted-foreground">
              You write the strategy as a <Term href="/docs/hackathon">mandate</Term> — a paragraph of plain English you
              approve — and set the ceilings. An LLM proposes trades against it; deterministic code disposes, scoring{' '}
              <Term href="/docs/hackathon#the-risk-gates">21 named limits</Term> on every order and keeping all 21
              verdicts. Orders reach the market through Alpaca&rsquo;s own CLI. Nothing is claimed that the{' '}
              <Term href="/docs/hackathon/proof-bundle">record</Term> can&rsquo;t show.
            </p>
            <div className="landing-rise landing-delay-2 mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/docs/hackathon"
                className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
              >
                Read the write-up
              </Link>
              <Link
                href="/docs/hackathon/architecture"
                className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-medium transition hover:bg-fd-accent active:scale-[0.98]"
              >
                How it&rsquo;s built
              </Link>
            </div>
            <p className="landing-rise landing-delay-2 mt-4 text-xs text-fd-muted-foreground">
              Built on {appName}, our portfolio-intelligence platform. Runs on an Alpaca <strong>paper</strong> account
              — simulated money, never a live one.
            </p>
          </div>
          <div className="landing-rise landing-delay-3 mx-auto w-full max-w-md lg:max-w-none">
            <MandateIllustration />
          </div>
        </div>
      </section>

      {/* 01 — The problem, and what's in it for the reader. */}
      <section className="border-t landing-band">
        <div className="mx-auto w-full max-w-6xl px-6 py-20">
          <Kicker index="01" label="Why this exists" />
          <h2 className="font-display mt-5 max-w-2xl text-balance text-3xl font-medium tracking-tight sm:text-4xl">
            You already do this work. Your tools just don&apos;t keep the receipts.
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-fd-muted-foreground">
            If you invest seriously, you follow a handful of investors whose judgment you rate, you keep a spreadsheet
            of what you hold, and a few times a year you try to reconcile the two. The spreadsheet forgets where every
            number came from. This doesn&apos;t — it was built so that every position, weight, and trade can answer for
            itself.
          </p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {questions.map((item) => (
              <div key={item.q} className="landing-scroll-rise rounded-xl border bg-fd-card p-6 shadow-sm">
                <h3 className="font-display text-xl font-medium italic tracking-tight sm:text-2xl">
                  &ldquo;{item.q}&rdquo;
                </h3>
                <p className="mt-3 text-sm text-pretty text-fd-muted-foreground">{item.a}</p>
                <Link
                  href={item.href}
                  className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 transition hover:underline dark:text-emerald-400"
                >
                  {item.term}
                  <ArrowUpRight size={14} strokeWidth={2} />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 02 — How it works: three verbs, then the workflow vignette. */}
      <section className="border-t">
        <div className="mx-auto w-full max-w-6xl px-6 py-20">
          <Kicker index="02" label="The loop" />
          <h2 className="font-display mt-5 text-balance text-3xl font-medium tracking-tight sm:text-4xl">
            From raw accounts to an approved trade
          </h2>
          <p className="mt-4 max-w-lg text-pretty text-fd-muted-foreground">
            One loop, always in this order. The system prepares everything; the only irreversible step is yours.
          </p>
          <div className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {steps.map((step) => (
              <div key={step.title} className="landing-scroll-rise">
                <div
                  className={`flex size-10 items-center justify-center rounded-lg border ${
                    step.accent
                      ? 'border-emerald-700/30 bg-emerald-700/10 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
                      : 'bg-fd-card text-fd-muted-foreground'
                  }`}
                >
                  <step.icon size={20} strokeWidth={ICON_STROKE} />
                </div>
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-pretty text-fd-muted-foreground">{step.body}</p>
              </div>
            ))}
          </div>
          <AssistantVignette />
        </div>
      </section>

      {/* 03 — The six pillars as a bento: [wide, normal] / [normal x3] / [full band]. */}
      <section className="border-t landing-band">
        <div className="mx-auto w-full max-w-6xl px-6 py-20">
          <Kicker index="03" label="The toolkit" />
          <h2 className="font-display mt-5 text-balance text-3xl font-medium tracking-tight sm:text-4xl">
            What&apos;s inside
          </h2>
          <p className="mt-4 max-w-lg text-pretty text-fd-muted-foreground">
            Six pillars, one goal: higher intelligence on fresher, more accurate data. Each card links into its full
            documentation. Tier-marked pillars activate at public launch — in early access, every account runs on Free.
          </p>
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            {pillars.map((pillar) => (
              <Link
                key={pillar.href}
                href={pillar.href}
                className={`landing-scroll-rise group relative overflow-hidden rounded-xl border bg-fd-card p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-fd-primary ${
                  pillar.cell === 'wide'
                    ? 'lg:col-span-2'
                    : pillar.cell === 'band'
                      ? 'border-emerald-700/25 bg-emerald-700/[0.09] lg:col-span-3 dark:border-emerald-500/25 dark:bg-emerald-500/[0.06]'
                      : ''
                }`}
              >
                {pillar.cell === 'wide' && (
                  <div
                    aria-hidden
                    className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle,var(--color-fd-border)_1px,transparent_1px)] [background-size:16px_16px]"
                  />
                )}
                <div className="relative">
                  <div className="flex items-start justify-between gap-4">
                    <pillar.icon
                      size={22}
                      strokeWidth={ICON_STROKE}
                      className={
                        pillar.cell === 'band' ? 'text-emerald-700 dark:text-emerald-400' : 'text-fd-muted-foreground'
                      }
                    />
                    <span className="flex items-center gap-3">
                      {pillar.tier && (
                        <span className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fd-muted-foreground">
                          {pillar.tier}
                        </span>
                      )}
                      <ArrowUpRight
                        size={16}
                        strokeWidth={ICON_STROKE}
                        className="text-fd-muted-foreground opacity-60 transition group-hover:text-fd-foreground group-hover:opacity-100"
                      />
                    </span>
                  </div>
                  <h3 className="mt-4 font-semibold">{pillar.title}</h3>
                  <p className="mt-2 max-w-2xl text-sm text-pretty text-fd-muted-foreground">{pillar.description}</p>
                  {pillar.guarantees && (
                    <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:flex-wrap sm:gap-x-6">
                      {pillar.guarantees.map((guarantee) => (
                        <li key={guarantee} className="flex items-center gap-1.5 text-sm">
                          <Check
                            size={15}
                            strokeWidth={2.25}
                            className="shrink-0 text-emerald-700 dark:text-emerald-400"
                          />
                          {guarantee}
                        </li>
                      ))}
                    </ul>
                  )}
                  {pillar.cell === 'wide' && (
                    <div className="mt-5 flex flex-wrap gap-2 text-xs text-fd-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 rounded-full border bg-fd-background px-3 py-1">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        Synced 2 hours ago
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border bg-fd-background px-3 py-1">
                        <span className="size-1.5 rounded-full bg-amber-500" />
                        19 days old · Overdue
                      </span>
                      <span className="inline-flex items-center rounded-full border bg-fd-background px-3 py-1">
                        v4 supersedes v3
                      </span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* 04 — The trust model, stated as checkable properties. */}
      <section className="border-t">
        <div className="mx-auto w-full max-w-6xl px-6 py-20">
          <Kicker index="04" label="Why trust it" />
          <h2 className="font-display mt-5 max-w-2xl text-balance text-3xl font-medium tracking-tight sm:text-4xl">
            Built to be checked, not believed
          </h2>
          <p className="mt-4 max-w-2xl text-pretty text-fd-muted-foreground">
            Software that sits next to your money should not ask for faith. These are structural properties of the
            system — <Term href="/docs">the docs</Term> describe exactly how each one works, and the product shows them
            to you as you use it. Credentials you connect are encrypted at rest (AES-256-GCM) and used only on your
            behalf — the <Term href="/privacy">privacy policy</Term> spells it out.
          </p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {proofs.map((proof) => (
              <div
                key={proof.title}
                className="landing-scroll-rise rounded-xl border border-l-2 border-l-emerald-700/50 bg-fd-card p-6 shadow-sm dark:border-l-emerald-400/50"
              >
                <h3 className="font-semibold">{proof.title}</h3>
                <p className="mt-2 text-sm text-pretty text-fd-muted-foreground">{proof.body}</p>
                <Link
                  href={proof.proofHref}
                  className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 transition hover:underline dark:text-emerald-400"
                >
                  {proof.proofLabel}
                  <ArrowUpRight size={14} strokeWidth={2} />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Closing manifesto + the same two destinations, restated once. */}
      <section className="border-t landing-band">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 py-24 text-center">
          <p className="landing-scroll-rise font-display max-w-2xl text-balance text-4xl font-medium tracking-tight sm:text-5xl">
            The system does the <em className="italic">doing</em>. You do the <em className="italic">deciding</em>.
          </p>
          <p className="mt-5 max-w-md text-pretty text-fd-muted-foreground">
            That contract is enforced in code, not promised in copy. Start with <Term href="/docs">the docs</Term> and
            check it yourself — then bring your book.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={`${appUrl}/auth/signin`}
              className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition hover:opacity-90 active:scale-[0.98]"
            >
              Sign in
            </a>
            <Link
              href="/pricing"
              className="rounded-lg border bg-fd-card px-5 py-2.5 text-sm font-medium transition hover:bg-fd-accent active:scale-[0.98]"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
