import type { Metadata } from 'next';
import { LegalPage } from '@/components/legal-page';
import { appName } from '@/lib/shared';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: `What ${appName} collects, how it's used, and the choices you have.`,
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="July 6, 2026">
      <p>
        This Privacy Policy explains what information {appName} collects, how it&apos;s used, and the choices you have.
        The Service is currently in active development with limited access (see our{' '}
        <a href="/terms">Terms of Service</a>).
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Account information:</strong> email address and a hashed password (or OAuth identity), plan and
          subscription status.
        </li>
        <li>
          <strong>Portfolio & holdings data:</strong> positions, transactions, and valuations you connect via portfolio
          tracker sync, manual entry, or CSV import.
        </li>
        <li>
          <strong>Brokerage credentials:</strong> if you connect Alpaca, your API keys are encrypted at rest
          (AES-256-GCM) and used only to call the Alpaca API on your behalf.
        </li>
        <li>
          <strong>Third-party sync credentials:</strong> authentication tokens for your connected portfolio tracker,
          encrypted at rest, used only to sync your portfolio.
        </li>
        <li>
          <strong>Billing information:</strong> handled directly by Stripe; we store your subscription status and Stripe
          customer/subscription IDs, not your card number.
        </li>
        <li>
          <strong>Usage & diagnostic data:</strong> basic application logs (errors, request metadata) used for operating
          and debugging the Service.
        </li>
      </ul>

      <h2>How we use information</h2>
      <p>
        To operate the Service (sync your portfolio, run the features you use), to process billing, to communicate with
        you about your account (email verification, password reset, billing receipts), and to maintain and improve
        reliability.
      </p>

      <h2>AI features & third-party providers</h2>
      <p>
        When you use the AI Council or the automated Alpaca manager, relevant portfolio data is sent to the AI provider
        configured for your account (for example OpenRouter, or a locally run model) to generate a response; automated
        trading calls are sent to Alpaca&apos;s brokerage API. If you connect an AI assistant via MCP, the portfolio
        data returned by its scoped tools is delivered to that assistant (and its AI provider) under an OAuth grant you
        authorize and can revoke; its write access is limited to a small sanctioned tool set, and every write is logged
        as a reviewable activity event. We use Stripe for billing and an email provider to send transactional email. We
        don&apos;t sell your data to anyone.
      </p>

      <h2>Data security</h2>
      <p>
        Sensitive credentials (portfolio tracker sync tokens, Alpaca keys) are encrypted at rest. The Service is a
        single-tenant, private deployment — your data isn&apos;t pooled with other customers&apos; data beyond the
        underlying database.
      </p>

      <h2>Data retention & deletion</h2>
      <p>
        We retain your data for as long as your account is active. You can request deletion of your account and
        associated data by contacting us.
      </p>

      <h2>Children&apos;s privacy</h2>
      <p>The Service isn&apos;t directed at, or intended for use by, anyone under 18.</p>

      <h2>Changes to this policy</h2>
      <p>
        We may update this Policy as the Service evolves; we&apos;ll update the &quot;last updated&quot; date above when
        we do.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this Policy: <a href="mailto:support@dataconnector-pro.com">support@dataconnector-pro.com</a>.
      </p>
    </LegalPage>
  );
}
