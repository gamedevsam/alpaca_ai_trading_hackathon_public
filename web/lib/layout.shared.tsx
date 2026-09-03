import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, appUrl } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported
      title: appName,
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Pricing', url: '/pricing' },
      { text: 'Blog', url: '/blog' },
      { text: 'About', url: '/about' },
      { text: 'Open the app', url: appUrl },
      { type: 'button', text: 'Sign in', url: `${appUrl}/auth/signin` },
    ],
  };
}
