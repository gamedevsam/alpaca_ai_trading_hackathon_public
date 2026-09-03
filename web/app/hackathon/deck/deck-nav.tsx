'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Keyboard + button navigation for the deck, and the slide counter.
 *
 * It reads the slides out of the DOM rather than owning them, so the slides themselves stay
 * server-rendered markup — a deck is content, and only the moving between slides is behaviour.
 * `scrollIntoView` drives the same scroll container the snap points live on, so keyboard,
 * button and plain scrolling all land in exactly the same place.
 */
export function DeckNav({ total }: { total: number }) {
  const [current, setCurrent] = useState(0);

  const goTo = useCallback((index: number) => {
    const slides = document.querySelectorAll<HTMLElement>('.deck-slide');
    const target = slides[Math.max(0, Math.min(slides.length - 1, index))];
    target?.scrollIntoView({ block: 'start' });
  }, []);

  // Which slide is showing — whichever one covers the middle of the viewport. Tracking the
  // scroll (rather than only our own clicks) keeps the counter honest when the reader scrolls.
  useEffect(() => {
    const slides = [...document.querySelectorAll<HTMLElement>('.deck-slide')];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(slides.indexOf(entry.target as HTMLElement));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keys: Record<string, number> = {
        ArrowRight: current + 1,
        ArrowDown: current + 1,
        PageDown: current + 1,
        ' ': current + 1,
        ArrowLeft: current - 1,
        ArrowUp: current - 1,
        PageUp: current - 1,
        Home: 0,
        End: total - 1,
      };
      const next = keys[event.key];
      if (next === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      goTo(next);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [current, goTo, total]);

  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    <div className="deck-chrome fixed inset-x-0 bottom-0 z-10 flex items-center justify-center gap-3 px-6 pb-5 sm:justify-end sm:px-10">
      <button
        type="button"
        onClick={() => goTo(current - 1)}
        disabled={current === 0}
        aria-label="Previous slide"
        className="deck-surface grid size-9 place-items-center rounded-full transition disabled:opacity-30"
      >
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={() => goTo(current + 1)}
        disabled={current === total - 1}
        aria-label="Next slide"
        className="deck-surface grid size-9 place-items-center rounded-full transition disabled:opacity-30"
      >
        <ChevronRight size={16} strokeWidth={1.75} />
      </button>
      <p className="deck-muted w-16 text-right text-xs tabular-nums" aria-live="polite">
        <span className="deck-accent font-medium">{pad(current + 1)}</span> / {pad(total)}
      </p>
    </div>
  );
}
