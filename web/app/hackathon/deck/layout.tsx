import { Newsreader } from 'next/font/google';
import type { Metadata } from 'next';
import './deck.css';

// The same display serif the public pages use, scoped here because the deck sits outside
// the (home) group and so never inherits that layout's --font-display.
const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  weight: ['400', '500', '600'],
  variable: '--font-display',
});

export const metadata: Metadata = {
  title: 'MANDATE — slide deck',
  description: 'The autonomous options desk that can prove it obeyed. Eight slides; print to PDF at 16in × 9in.',
};

// No site chrome: the deck is presented full-bleed on screen and printed page-per-slide.
export default function Layout({ children }: LayoutProps<'/hackathon/deck'>) {
  return <div className={newsreader.variable}>{children}</div>;
}
