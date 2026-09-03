import Link from 'next/link';
import type { Metadata } from 'next';
import { appName, appUrl, companyName, companyUrl, ownerName, ownerUrl, siteUrl } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'About',
  description: `Who builds ${appName} and what it stands for — a one-person operation from ${companyName}, built on an honest contract: the system proposes, you decide.`,
};

// Structured data: an AboutPage that describes the publishing Organization and the
// person behind it. sameAs consolidates the identity across the company + personal
// sites for search engines. Kept consistent with the visible copy below.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'AboutPage',
  name: `About ${appName}`,
  url: `${siteUrl}/about`,
  mainEntity: {
    '@type': 'Organization',
    name: companyName,
    url: companyUrl,
    sameAs: [companyUrl, ownerUrl],
    founder: {
      '@type': 'Person',
      name: ownerName,
      url: ownerUrl,
      sameAs: [ownerUrl, companyUrl],
    },
  },
};

// The values are the Charter's honesty-first posture, restated as company values.
const values = [
  {
    title: 'It proposes. You decide.',
    body: 'Every consequential action arrives as a proposal you can review, approve, deny, or refine. The system does the doing; you do the deciding. It never places a trade or moves money on its own.',
  },
  {
    title: 'Real data, or none.',
    body: 'Numbers are only worth acting on if they are current and true. When something is unknown or missing, it is reported as missing — never quietly filled in with a plausible-looking default.',
  },
  {
    title: 'Nothing is silently cut.',
    body: 'When a limit is hit, you are told. Output is never truncated behind your back to look complete. If the whole answer will not fit, the boundary is shown, not hidden.',
  },
  {
    title: 'Built to be inspected.',
    body: 'Versioned records, provenance on every source, freshness shown everywhere, honest health endpoints. The whole system is built to be checked, not trusted blindly.',
  },
];

export default function AboutPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <h1 className="font-display mb-4 text-4xl font-medium tracking-tight sm:text-5xl">About</h1>
      <p className="mb-12 max-w-2xl text-lg text-fd-muted-foreground">
        {appName} is portfolio intelligence that assembles your real data, reasons over it, and proposes — while every
        decision stays yours. Here is who builds it, and the contract it holds itself to.
      </p>

      <section className="mb-12">
        <h2 className="mb-3 text-xl font-semibold">Who runs this</h2>
        <div className="space-y-4 text-fd-muted-foreground">
          <p>
            {appName} is published by{' '}
            <a href={companyUrl} className="text-fd-foreground underline">
              {companyName}
            </a>
            , and — openly — it is a one-person operation. I&apos;m{' '}
            <a href={ownerUrl} className="text-fd-foreground underline">
              {ownerName}
            </a>
            , an engineer working at the frontier of software: building AI tools and running businesses that run
            themselves. This product is one of those experiments, built and operated end to end by me.
          </p>
          <p>
            That a single person builds and runs it is not something to hide — it&apos;s the point. It keeps the work
            honest and the direction coherent: no committee to blur the vision, no distance between the person who
            decides what matters and the person who ships it.
          </p>
          <p>
            The pull toward frontiers runs deeper than the day job. I&apos;m Portuguese, and exploration is written into
            that heritage — a small nation that once sailed past the edges of its maps. I build in the same spirit:
            pointed at the unknown edge of what software can do on its own, and comfortable out there.
          </p>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="mb-3 text-xl font-semibold">What we stand for</h2>
        <p className="mb-6 max-w-2xl text-fd-muted-foreground">
          {/* Explicit string: the compiled output drops a plain JSX space after the expression here. */}
          {appName}
          {` enforces a set of honesty rules on itself internally — and they double as the values this operation runs on. They are non-negotiable because a portfolio tool you can't fully trust is worse than none.`}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {values.map((value) => (
            <div key={value.title} className="rounded-xl border p-5">
              <h3 className="mb-2 font-semibold">{value.title}</h3>
              <p className="text-sm text-fd-muted-foreground">{value.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border p-6">
        <h2 className="mb-2 text-lg font-semibold">Get in touch</h2>
        <p className="mb-4 text-sm text-fd-muted-foreground">
          Read more about the company at{' '}
          <a href={companyUrl} className="text-fd-foreground underline">
            {companyUrl.replace('https://', '')}
          </a>{' '}
          or about me at{' '}
          <a href={ownerUrl} className="text-fd-foreground underline">
            {ownerUrl.replace('https://', '')}
          </a>
          .
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href={appUrl}
            className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground"
          >
            Open the app
          </a>
          <Link href="/pricing" className="rounded-lg border px-5 py-2.5 text-sm font-medium">
            See pricing
          </Link>
        </div>
      </section>
    </div>
  );
}
