import { Newsreader } from 'next/font/google';
import type { Metadata } from 'next';
import './cover.css';

// The same display serif the deck and the public pages use, scoped here because the cover
// sits outside the (home) group and so never inherits that layout's --font-display.
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
});

export const metadata: Metadata = {
  title: 'MANDATE — cover',
  description: 'The 16:9 cover image for the MANDATE submission.',
};

// No site chrome: this page exists to be captured, and anything around the frame would
// end up in the export.
export default function Layout({ children }: LayoutProps<'/hackathon/cover'>) {
  return <div className={newsreader.variable}>{children}</div>;
}
