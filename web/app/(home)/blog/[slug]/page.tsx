import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getMDXComponents } from '@/components/mdx';
import { blog } from '@/lib/source';

export default async function BlogPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  const Mdx = page.data.body;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-16">
      <Link href="/blog" className="mb-8 text-sm text-fd-muted-foreground hover:underline">
        ← Back to blog
      </Link>
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{page.data.title}</h1>
      <p className="mb-10 text-sm text-fd-muted-foreground">
        {page.data.author} ·{' '}
        {new Date(page.data.date).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })}
      </p>
      <div className="prose min-w-0">
        <Mdx components={getMDXComponents()} />
      </div>
    </div>
  );
}

export function generateStaticParams(): { slug: string }[] {
  return blog.getPages().map((page) => ({ slug: page.slugs[0] }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
