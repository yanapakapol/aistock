'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';
import {
  DbBusinessContextBlock,
  DbEventsBlock,
  DbFutureEventsBlock,
  DbPricesBlock,
  GenericToolBlock,
  SearchNewsBlock,
  pickRenderer,
} from './tool-renderers';

// AI SDK v6 UI messages: `parts: [{type, text|input|output|toolName|state}]`.
interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'data';
  content?: string;
  parts?: Array<{
    type: string;
    text?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    input?: unknown;
    output?: unknown;
    state?: string;
  }>;
}

interface Props {
  messages: UIMessage[];
  streaming: boolean;
}

interface Chunk {
  kind: 'text' | 'tool';
  body?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  running?: boolean;
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

  return (
    <div className="relative">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        <div ref={topRef} />
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {streaming ? <StreamingDot /> : null}
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

function MessageBubble({ message }: { message: UIMessage }) {
  const role = message.role;
  const isUser = role === 'user';
  const isAssistant = role === 'assistant';

  const chunks: Chunk[] = [];
  if (message.parts && message.parts.length > 0) {
    for (const p of message.parts) {
      if (p.type === 'text' && p.text) {
        chunks.push({ kind: 'text', body: p.text });
      } else if (p.type === 'reasoning' && p.text) {
        chunks.push({ kind: 'text', body: `_thinking:_ ${p.text}` });
      } else if (p.type === 'step-start' || p.type === 'step-finish') {
        // ignore
      } else if (p.type?.startsWith('tool-')) {
        const toolName = p.toolName ?? p.type.replace(/^tool-/, '');
        const args = p.input ?? p.args;
        const result = p.output ?? p.result;
        chunks.push({
          kind: 'tool',
          toolName,
          toolArgs: args,
          toolResult: result,
          running: result == null,
        });
      }
    }
  } else if (message.content) {
    chunks.push({ kind: 'text', body: message.content });
  }

  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] space-y-2 rounded-lg bg-accent px-4 py-3 text-sm leading-relaxed text-foreground">
          {chunks.map((c, i) =>
            c.kind === 'text' ? (
              <div key={i} className="markdown-body">
                <Markdown source={c.body ?? ''} />
              </div>
            ) : null,
          )}
        </div>
      </div>
    );
  }

  // Assistant: split into Thinking/Process card (tool calls) + Answer card (text).
  const toolChunks = chunks.filter((c) => c.kind === 'tool');
  const textChunks = chunks.filter((c) => c.kind === 'text');
  const stillThinking = toolChunks.some((c) => c.running);

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[95%] space-y-2">
        {toolChunks.length > 0 ? (
          <ThinkingCard chunks={toolChunks} active={stillThinking} />
        ) : null}
        {textChunks.length > 0 ? (
          <AnswerCard chunks={textChunks} fullText={textChunks.map((c) => c.body ?? '').join('\n\n')} />
        ) : null}
      </div>
    </div>
  );
}

function ThinkingCard({ chunks, active }: { chunks: Chunk[]; active: boolean }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // The latest still-running chunk drives the live progress bar + caption.
  const running = chunks.find((c) => c.running);
  return (
    <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide">
        {active ? (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        ) : (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        )}
        <span className={active ? 'text-blue-400' : 'text-muted-foreground'}>
          {active ? 'thinking…' : `process · ${chunks.length} step${chunks.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {running ? (
        <div className="mb-2">
          <div className="mb-1 truncate text-[11px] text-blue-300">
            {describeRunning(running)}
          </div>
          <div className="indeterminate-bar h-1 w-full rounded-full" />
        </div>
      ) : null}
      <div className="thin-scroll flex max-w-full gap-1.5 overflow-x-auto pb-1">
        {chunks.map((c, i) => {
          const name = c.toolName ?? 'tool';
          const running = c.running ?? false;
          const isOpen = openIdx === i;
          const label = chipLabel(c);
          return (
            <button
              key={i}
              type="button"
              onClick={() => setOpenIdx(isOpen ? null : i)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors',
                running
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                  : isOpen
                    ? 'border-foreground/30 bg-accent text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
              )}
              title={label}
            >
              {running ? (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
              ) : (
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/40" />
              )}
              <span className="max-w-[180px] truncate">{name}</span>
            </button>
          );
        })}
      </div>
      {openIdx != null && chunks[openIdx] ? (
        <div className="mt-2 border-t border-border pt-2">
          {(() => {
            const c = chunks[openIdx]!;
            const renderer = pickRenderer(c.toolName ?? '');
            const running = c.running ?? false;
            switch (renderer) {
              case 'news':
                return <SearchNewsBlock output={(c.toolResult as never) ?? null} running={running} />;
              case 'events':
                return <DbEventsBlock output={(c.toolResult as never) ?? null} running={running} />;
              case 'future':
                return <DbFutureEventsBlock output={(c.toolResult as never) ?? null} running={running} />;
              case 'context':
                return <DbBusinessContextBlock output={(c.toolResult as never) ?? null} running={running} />;
              case 'prices':
                return <DbPricesBlock output={(c.toolResult as never) ?? null} running={running} />;
              default:
                return (
                  <GenericToolBlock
                    name={c.toolName ?? 'tool'}
                    args={c.toolArgs}
                    result={c.toolResult}
                    running={running}
                  />
                );
            }
          })()}
        </div>
      ) : null}
    </div>
  );
}

/** Friendly human caption shown above the indeterminate bar while a tool is in flight. */
function describeRunning(c: Chunk): string {
  const name = c.toolName ?? 'tool';
  const args = (c.toolArgs ?? {}) as Record<string, unknown>;
  const q = typeof args.query === 'string' ? (args.query as string) : null;
  const title = typeof args.title === 'string' ? (args.title as string) : null;
  switch (name) {
    case 'search_news':
      return q ? `Searching news for "${truncate(q, 80)}"…` : 'Searching news…';
    case 'search_stocks':
      return q ? `Looking up "${truncate(q, 40)}"…` : 'Looking up stock symbol…';
    case 'upsert_event':
      return title ? `Saving event "${truncate(title, 60)}" to DB…` : 'Saving event to DB…';
    case 'upsert_future_event':
      return title
        ? `Saving future event "${truncate(title, 60)}" to DB…`
        : 'Saving future event to DB…';
    case 'upsert_business_context':
      return 'Updating business context in DB…';
    case 'consolidate_events':
      return 'Consolidating duplicates in DB…';
    case 'get_events':
      return 'Reading events from DB…';
    case 'get_future_events':
      return 'Reading future events from DB…';
    case 'get_business_context':
      return 'Reading business context from DB…';
    case 'get_prices':
    case 'get_prices_intraday':
      return 'Reading prices from DB…';
    case 'get_fundamentals':
      return 'Reading fundamentals from DB…';
    case 'correlate_event_price':
      return 'Computing event-vs-price correlation…';
    case 'create_routine':
      return 'Scheduling routine…';
    case 'get_current_datetime':
      return 'Checking current date…';
    default:
      return `Running ${name}…`;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function chipLabel(c: Chunk): string {
  if (!c.toolResult) return `${c.toolName} (running)`;
  const out = c.toolResult as Record<string, unknown>;
  if (Array.isArray((out as { results?: unknown[] }).results)) {
    return `${c.toolName} → ${(out as { results: unknown[] }).results.length} results`;
  }
  if (Array.isArray((out as { events?: unknown[] }).events)) {
    return `${c.toolName} → ${(out as { events: unknown[] }).events.length} events`;
  }
  if ((out as { id?: number }).id != null) {
    return `${c.toolName} → #${(out as { id: number }).id}`;
  }
  return c.toolName ?? 'tool';
}

function AnswerCard({ chunks, fullText }: { chunks: Chunk[]; fullText: string }) {
  return (
    <div className="rounded-lg border border-border bg-transparent px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        answer
      </div>
      {chunks.map((c, i) => (
        <div key={i} className="markdown-body">
          <Markdown source={c.body ?? ''} />
        </div>
      ))}
      <MessageActions text={fullText} />
    </div>
  );
}

function MessageActions({ text }: { text: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  }
  async function exportAs(format: 'md' | 'docx' | 'pdf') {
    try {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format, filename: `aistock-answer.${format}`, content: text }),
      });
      if (!r.ok) {
        alert(`Export failed: HTTP ${r.status}`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aistock-answer.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Export error: ${(err as Error).message}`);
    }
  }
  function followUp() {
    const ta = document.querySelector<HTMLTextAreaElement>('form textarea');
    if (ta) {
      ta.focus();
      ta.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
      <button type="button" onClick={copy} className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground">
        Copy
      </button>
      <button type="button" onClick={followUp} className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground">
        Follow-up
      </button>
      <span className="opacity-30">·</span>
      <button type="button" onClick={() => void exportAs('md')} className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground">
        .md
      </button>
      <button type="button" onClick={() => void exportAs('docx')} className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground">
        .docx
      </button>
      <button type="button" onClick={() => void exportAs('pdf')} className="rounded px-2 py-0.5 hover:bg-accent hover:text-foreground">
        .pdf
      </button>
    </div>
  );
}

function StreamingDot() {
  return (
    <div className="flex justify-start">
      <div className="h-2 w-2 animate-pulse rounded-full bg-foreground/50" />
    </div>
  );
}
