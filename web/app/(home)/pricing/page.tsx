import Link from 'next/link';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { Metadata } from 'next';
import { appName, appUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Pricing',
  description: `${appName} pricing: an accurate portfolio view for free; AI research and gated automated execution on the paid tiers.`,
};

/** Inline link to a term's docs definition — same affordance as the landing page. */
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

// Mirrors the Free/Pro/Ultimate tiers seeded server-side in
// infrastructure/prisma/src/seed/seed_entitlements.ts (B70) — keep in sync if pricing/capabilities change there.
// Features are nodes so product terms can deep-link their docs definitions at first use.
const plans: {
  slug: string;
  name: string;
  price: string;
  period: string;
  description: string;
  features: ReactNode[];
  cta: string;
  highlighted?: boolean;
}[] = [
  {
    slug: 'free',
    name: 'Free',
    price: '$0',
    period: '',
    description: 'One accurate, always-current view of everything you hold.',
    features: [
      'Portfolio tracker sync + manual and CSV import',
      <>
        <Term href="/docs/concepts/target">Target</Term> allocations, drift, and a{' '}
        <Term href="/docs/concepts/reconcile#the-trade-plan">trade-plan</Term> engine
      </>,
      <>
        Tracked <Term href="/docs/concepts/managers">managers</Term>, <Term href="/docs/concepts/sources">sources</Term>
        , and the <Term href="/docs/concepts/blend">blend</Term> workbench
      </>,
      'Nightly valuation history & performance tracking',
      'Activity log & health diagnostics',
    ],
    cta: 'Sign in',
  },
  {
    slug: 'pro',
    name: 'Pro',
    price: '$9.99',
    period: '/mo',
    description: 'Add the AI Council for research and debate.',
    features: [
      'Everything in Free',
      <>
        <Term href="/docs/concepts/ai-council">AI Council</Term>: 1:1 chat with each AI portfolio manager
      </>,
      'AI Council: multi-agent debate mode on an idea',
      'Up to 20 AI Council runs per day',
    ],
    cta: 'Start on Free — Pro at launch',
    highlighted: true,
  },
  {
    slug: 'ultimate',
    name: 'Ultimate',
    price: '$19.99',
    period: '/mo',
    description: 'Everything, plus automated execution.',
    features: [
      'Everything in Pro',
      'Unlimited AI Council runs',
      <>
        <Term href="/docs/alpaca-portfolio-manager">Automated execution</Term> via the Alpaca brokerage (equities +
        options)
      </>,
      'Defined-risk safeguards and a kill switch on every trade',
    ],
    cta: 'Start on Free — Ultimate at launch',
  },
];

// Honest answers to the questions a skeptic actually has on this page. The
// early-access answer must stay consistent with /docs/getting-started step 1.
const faq: { q: string; a: ReactNode }[] = [
  {
    q: 'Can I use it today?',
    a: (
      <>
        {/* Explicit string: the compiled output drops a plain JSX space after the expression here. */}
        {appName}
        {` is in early access. Sign-up is live, but during the current development phase access is limited to invited accounts — the same note you'll find in `}
        <Term href="/docs/getting-started">Getting started</Term>. Paid tiers activate at public launch; early-access
        accounts run on the Free tier.
      </>
    ),
  },
  {
    q: 'Do I need a brokerage account?',
    a: (
      <>
        No. Tracker sync, CSV import, manual books, targets, and trade plans all work without one. A brokerage
        connection (Alpaca) only matters for Ultimate&apos;s{' '}
        <Term href="/docs/alpaca-portfolio-manager">automated execution</Term> — and even that proves itself on paper
        trading first.
      </>
    ),
  },
  {
    q: 'Can the AI trade without me?',
    a: (
      <>
        Only if you hand it that authority yourself, deliberately, and only on a paper account. By default every trade
        ships as a proposal you approve, deny, or refine. The hard-coded risk limits and the kill switch apply the same
        either way. <Term href="/docs/alpaca-portfolio-manager">How execution is gated</Term> documents the full
        lifecycle.
      </>
    ),
  },
  {
    q: 'What happens to my data if I leave?',
    a: (
      <>
        Your portfolio is yours. Deleting your account deletes your data — the ownership model is built so everything
        you own is removed cleanly, not orphaned. The <Term href="/privacy">privacy policy</Term> is short and in plain
        language.
      </>
    ),
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-4 py-16">
      <h1 className="font-display mb-3 text-center text-4xl font-medium tracking-tight sm:text-5xl">Pricing</h1>
      <p className="mb-12 max-w-xl text-center text-fd-muted-foreground">
        The free tier keeps one accurate, always-current view of everything you hold — the foundation the intelligence
        runs on. The paid tiers unlock what {appName} is really for: AI research and debate, and automated execution
        that can never act without your approval.
      </p>
      <div className="grid w-full gap-6 sm:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.slug}
            className={`flex flex-col rounded-xl border bg-fd-card p-6 shadow-sm ${plan.highlighted ? 'border-fd-primary shadow-lg' : ''}`}
          >
            <h2 className="text-lg font-semibold">{plan.name}</h2>
            <p className="mt-2 text-3xl font-bold">
              {plan.price}
              <span className="text-base font-normal text-fd-muted-foreground">{plan.period}</span>
            </p>
            <p className="mt-2 text-sm text-fd-muted-foreground">{plan.description}</p>
            <ul className="mt-6 flex-1 space-y-3 text-sm">
              {plan.features.map((feature, index) => (
                <li key={index} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-fd-primary" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
            {/* The solid button belongs to Free; paid tiers activate at launch. While access
                is invitation-only the CTA is sign-in — the waitlist (B230) replaces it. */}
            <a
              href={`${appUrl}/auth/signin`}
              className={`mt-6 rounded-lg px-5 py-2.5 text-center text-sm font-medium ${
                plan.slug === 'free' ? 'bg-fd-primary text-fd-primary-foreground' : 'border'
              }`}
            >
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
      <p className="mt-6 max-w-lg text-center text-xs text-fd-muted-foreground">
        In early access, every account starts on Free — paid tiers activate at public launch.
      </p>

      <section className="mt-16 w-full max-w-3xl">
        <h2 className="font-display text-center text-2xl font-medium tracking-tight sm:text-3xl">Fair questions</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {faq.map((item) => (
            <div key={item.q} className="rounded-xl border bg-fd-card p-5 shadow-sm">
              <h3 className="font-semibold">{item.q}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{item.a}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="mt-10 max-w-lg text-center text-xs text-fd-muted-foreground">
        Prices in USD, billed monthly, cancel anytime from your account&apos;s billing page. See our{' '}
        <Link href="/terms" className="underline">
          Terms of Service
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="underline">
          Privacy Policy
        </Link>
        .
      </p>
    </div>
  );
}
