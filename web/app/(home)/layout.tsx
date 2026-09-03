import Link from 'next/link';
import { Newsreader } from 'next/font/google';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { appName, appTagline, appUrl } from '@/lib/shared';

// Display serif for the public pages' headlines (see .font-display in global.css).
// Scoped to this layout so the docs keep their standard type.
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
});

const footerColumns = [
  {
    title: 'Product',
    links: [
      { text: 'Open the app', href: appUrl, external: true },
      { text: 'Sign in', href: `${appUrl}/auth/signin`, external: true },
      { text: 'Pricing', href: '/pricing' },
    ],
  },
  {
    title: 'Learn',
    links: [
      { text: 'Docs', href: '/docs' },
      { text: 'Concepts & glossary', href: '/docs/concepts' },
      { text: 'Getting started', href: '/docs/getting-started' },
      { text: 'Blog', href: '/blog' },
    ],
  },
  {
    title: 'Company',
    links: [
      { text: 'About', href: '/about' },
      { text: 'Terms', href: '/terms' },
      { text: 'Privacy', href: '/privacy' },
    ],
  },
];

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <HomeLayout {...baseOptions()} className={newsreader.variable}>
      {children}
      <footer className="border-t px-6 py-12">
        <div className="mx-auto grid w-full max-w-6xl gap-10 sm:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <p className="text-sm font-medium">{appName}</p>
            <p className="mt-1 max-w-56 text-xs text-fd-muted-foreground">{appTagline}</p>
          </div>
          {footerColumns.map((column) => (
            <nav key={column.title} aria-label={column.title} className="text-xs">
              <p className="font-medium text-fd-muted-foreground">{column.title}</p>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) =>
                  link.external ? (
                    <li key={link.href}>
                      <a href={link.href} className="text-fd-muted-foreground transition hover:text-fd-foreground">
                        {link.text}
                      </a>
                    </li>
                  ) : (
                    <li key={link.href}>
                      <Link href={link.href} className="text-fd-muted-foreground transition hover:text-fd-foreground">
                        {link.text}
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            </nav>
          ))}
        </div>
      </footer>
    </HomeLayout>
  );
}
