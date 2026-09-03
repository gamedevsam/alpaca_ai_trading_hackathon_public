import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { appDescription, appName, siteUrl } from '@/lib/shared';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName} — AI portfolio intelligence`,
    template: `%s | ${appName}`,
  },
  description: appDescription,
  // Every page self-canonicalizes onto the primary origin (metadataBase), so serving
  // this same app from multiple domains (the samfolios/samstocks test) never splits
  // search ranking across them.
  alternates: { canonical: './' },
  openGraph: {
    siteName: appName,
    type: 'website',
    url: './',
    description: appDescription,
  },
  twitter: {
    card: 'summary',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
