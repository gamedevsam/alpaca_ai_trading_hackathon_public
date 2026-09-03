import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  // The docs sidebar renders `links` as menu items above the page tree (fumadocs-ui
  // Sidebar), so the marketing header's Docs/Pricing/Blog/About/etc. would clutter the
  // document tree if spread in here. Give DocsLayout only its nav title; the marketing
  // links stay exclusive to the HomeLayout navbar in app/(home)/layout.tsx.
  const { links: _marketingLinks, ...docsOptions } = baseOptions();
  return (
    <DocsLayout tree={source.getPageTree()} {...docsOptions}>
      {children}
    </DocsLayout>
  );
}
