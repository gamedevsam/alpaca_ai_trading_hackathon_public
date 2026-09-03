import type { MetadataRoute } from 'next';
import { blog, source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

// One sitemap for every indexable page. URLs resolve against the canonical origin
// (siteUrl), so alternate domains serving this app inherit the same consolidated map.
export default function sitemap(): MetadataRoute.Sitemap {
  const staticPages = ['', '/pricing', '/blog', '/about', '/terms', '/privacy'];

  return [
    ...staticPages.map((path) => ({
      url: `${siteUrl}${path}`,
      changeFrequency: 'weekly' as const,
      priority: path === '' ? 1 : 0.6,
    })),
    ...source.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
    ...blog.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
  ];
}
