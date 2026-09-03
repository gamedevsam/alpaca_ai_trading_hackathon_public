import type { ReactNode } from 'react';

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-16">
      <h1 className="font-display mb-2 text-3xl font-medium tracking-tight">{title}</h1>
      <p className="mb-10 text-sm text-fd-muted-foreground">Last updated {updated}</p>
      <div className="space-y-4 text-sm leading-relaxed text-fd-muted-foreground [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fd-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5 [&_a]:text-fd-foreground [&_a]:underline">
        {children}
      </div>
    </div>
  );
}
