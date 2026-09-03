import Link from 'next/link';
import { blog } from '@/lib/source';

export const metadata = {
  title: 'Blog',
  description: 'Notes on what we’re building and why.',
};

export default function BlogIndexPage() {
  const posts = [...blog.getPages()].sort((a, b) => (a.data.date < b.data.date ? 1 : -1));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-16">
      <h1 className="font-display mb-3 text-center text-4xl font-medium tracking-tight sm:text-5xl">Blog</h1>
      <p className="mb-12 text-center text-fd-muted-foreground">Notes on what we&apos;re building and why.</p>
      <div className="flex flex-col gap-6">
        {posts.map((post) => (
          <Link
            key={post.url}
            href={post.url}
            className="rounded-xl border p-6 transition-colors hover:border-fd-primary"
          >
            <p className="mb-2 text-xs text-fd-muted-foreground">
              {new Date(post.data.date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
            <h2 className="mb-2 text-xl font-semibold">{post.data.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{post.data.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
