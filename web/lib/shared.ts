// Interim brand — the final public name is settled by the owner's domain test
// (samfolios.com vs samstocks.com). Keep copy brand-light so either domain reads
// credibly; flip these constants at go-live.
export const appName = 'Stock Rankings';
export const appTagline = 'Portfolio intelligence that proposes. You decide.';
// Also the meta/OG description — keep it ≤160 chars so search results don't truncate it.
export const appDescription =
  'AI portfolio intelligence: sync your real holdings, follow the managers you trust, blend their convictions into a target, and approve every proposed trade.';
// The authenticated product app (separate Dokku app / subdomain). The public site
// links out to it; see the domain-topology note in docs/dokku/apps/stocks_docs.md.
export const appUrl = 'https://stocks.dataconnector-pro.com';
// This public site's own CANONICAL origin: metadataBase resolves every relative
// canonical/OG URL against it, so all domains serving this app (samfolios.com,
// samstocks.com, …) consolidate their SEO onto this one. Change it exactly once,
// at go-live, to the chosen primary domain — never point it at a domain that
// doesn't resolve yet.
//
// DECIDED (owner + Architect, 2026-07-16): the canonical primary is samfolios.com.
// (Coined word → an ownable brand SERP, vs "sam stocks" colliding with Boston Beer's
// SAM ticker; matches the portfolio-intelligence positioning; pairs with samloops.)
// samstocks.com will serve the same app for the ads test — paid landings ignore
// canonicals, so the test is unaffected. DO NOT flip until the domain resolves:
//   1. DNS: point samfolios.com + samstocks.com at the host serving this site
//   2. domains + TLS on that host (e.g. dokku domains:add stocks-docs <domains> + letsencrypt)
//   3. swap in the line below, redeploy, submit the sitemap in Search Console
// export const siteUrl = 'https://samfolios.com';
export const siteUrl = 'https://stocks-docs.dataconnector-pro.com';

// Who publishes this. Openly a one-person operation — used in the About page copy
// and its JSON-LD (Organization/Person `sameAs`). Not a secret; deliberately public.
export const companyName = 'DataConnector Pro';
export const companyUrl = 'https://dataconnector-pro.com';
export const ownerName = 'Samuel Batista';
export const ownerUrl = 'https://sambatista.com';

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

// NOTE: the platform behind this site is closed-source — deliberately no per-page
// "view source" / "edit on GitHub" affordances anywhere in the site. The hackathon
// repository publishes the desk module and this site only; it is linked from the
// write-up, not from the chrome.
