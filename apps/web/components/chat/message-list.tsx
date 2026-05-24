'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageBubble, type UIMessage } from './message-bubble';

interface Props {
  messages: UIMessage[];
  streaming: boolean;
}

export function MessageList({ messages, streaming }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const prevLenRef = useRef<number>(0);
  // IntersectionObserver-based sticky detection: endRef visible == we're at
  // (or near) the bottom. Updated by the browser, no scroll listener needed.
  const stickyRef = useRef<boolean>(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = endRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e) return;
        stickyRef.current = e.isIntersecting;
        setPinned(e.isIntersecting);
      },
      { root: null, rootMargin: '0px 0px 120px 0px', threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const prev = prevLenRef.current;
    const next = messages.length;
    prevLenRef.current = next;
    // Bulk history load → jump to top.
    if (next - prev > 1) {
      topRef.current?.scrollIntoView({ block: 'start' });
      return;
    }
    // Incremental growth → only auto-scroll if user is currently pinned to bottom.
    if (stickyRef.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, streaming]);

  function scrollToBottom() {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  const last = messages[messages.length - 1];
  const lastIsUser = last?.role === 'user';
  const lastIdx = messages.length - 1;

  return (
    <div className="relative">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        <div ref={topRef} />
        {messages.map((m, idx) => (
          <MessageBubble
            key={m.id}
            message={m}
            streaming={streaming}
            isLatest={idx === lastIdx}
          />
        ))}
        {/* Optimistic placeholder: while `streaming` is true and the latest
            message in the list is the user's just-sent turn (no assistant turn
            yet), render a visible "Sending…" bubble so the UI is never frozen
            between Enter-press and first LLM byte. As soon as the assistant
            message lands in `messages`, this disappears and the real bubble
            takes over — keyed off `lastIsUser` so there's no flicker. */}
        {streaming && lastIsUser ? <PendingAssistantBubble /> : null}
        <div ref={endRef} />
      </div>
      {!pinned && (streaming || messages.length > 0) ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="pointer-events-auto fixed bottom-36 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] text-foreground shadow-sm backdrop-blur hover:bg-accent sm:bottom-28"
        >
          ↓ jump to latest
        </button>
      ) : null}
    </div>
  );
}

/**
 * Optimistic assistant bubble shown the instant the user submits, before the
 * server's first byte arrives. Once a real assistant message lands in the
 * `messages` array this is unmounted (see `lastIsUser` check above). Three
 * staggered dots give the user immediate "yes, your input was received"
 * feedback — much clearer than a single pulsing dot for tool-using models
 * that can take 5–30s before emitting their first token.
 */
function PendingAssistantBubble() {
  return (
    <div className="flex w-full justify-start" aria-live="polite">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/60 [animation-delay:-0.3s]" />
          <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/60 [animation-delay:-0.15s]" />
          <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-foreground/60" />
        </span>
        <span>Sending…</span>
      </div>
    </div>
  );
}
