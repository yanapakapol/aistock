'use client';

import { useState } from 'react';
import { ChevronRight, ExternalLink, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NewsResult {
  url: string;
  title: string;
  content?: string;
  published_date?: string | null;
  source?: string;
  score?: number | null;
}

interface SearchNewsOutput {
  query?: string;
  results?: NewsResult[];
  sources_used?: string[];
  errors?: string[];
}

/**
 * Renders a search_news tool result as a Perplexity-style stack of cards.
 * Each card shows favicon + title + source/date + 1-line snippet. Expandable
 * to the full content. Plus a "Sources used" pill row at the top.
 */
export function SearchNewsBlock({
  output,
  running,
}: {
  output: SearchNewsOutput | null;
  running: boolean;
}) {
  if (running) {
    return (
      <div className="rounded-md border border-blue-500/40 bg-blue-500/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 text-blue-400">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
          Searching news…
        </div>
      </div>
    );
  }
  if (!output) return null;
  const results = output.results ?? [];
  const sources = output.sources_used ?? [];
  return (
    <div className="space-y-2">
      {sources.length > 0 || output.query ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
          {output.query ? (
            <span className="rounded-full bg-muted/40 px-2 py-0.5 font-mono">
              q: {output.query}
            </span>
          ) : null}
          {sources.map((s) => (
            <span key={s} className="rounded-full border border-border px-2 py-0.5">
              {s}
            </span>
          ))}
        </div>
      ) : null}
      {results.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          No results.
        </div>
      ) : (
        <div className="space-y-1.5">
          {results.map((r, i) => (
            <NewsCard key={`${r.url}-${i}`} result={r} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewsCard({ result, index }: { result: NewsResult; index: number }) {
  const [open, setOpen] = useState(false);
  const host = (() => {
    try {
      return new URL(result.url).hostname.replace(/^www\./, '');
    } catch {
      return result.source ?? '';
    }
  })();
  return (
    <div className="rounded-md border border-border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="mt-0.5 inline-block min-w-[18px] rounded bg-background px-1 text-center text-[10px] tabular-nums text-muted-foreground">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{result.title || '(untitled)'}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Globe className="h-3 w-3" />
            <span className="truncate">{host}</span>
            {result.published_date ? (
              <>
                <span className="opacity-50">·</span>
                <span>{result.published_date}</span>
              </>
            ) : null}
            {result.source && result.source !== host ? (
              <>
                <span className="opacity-50">·</span>
                <span>{result.source}</span>
              </>
            ) : null}
          </div>
        </div>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed">
          <div className="mb-2 whitespace-pre-wrap break-words text-muted-foreground">
            {result.content ?? '(no excerpt)'}
          </div>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400"
          >
            Open source <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Generic compact tool block — name + small "expand" link to see raw args/result.
 * Used for tools that don't have a specialized renderer.
 */
export function GenericToolBlock({
  name,
  args,
  result,
  running,
}: {
  name: string;
  args: unknown;
  result: unknown;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        'rounded-md border text-[11px]',
        running ? 'border-blue-500/40 bg-blue-500/5' : 'border-border bg-muted/20',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-muted-foreground hover:bg-muted/40"
      >
        {running ? (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
        ) : (
          <ChevronRight
            className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
          />
        )}
        <span className="font-medium text-foreground">{name}</span>
        {running ? <span className="text-blue-400">running…</span> : null}
      </button>
      {open ? (
        <div className="space-y-1 border-t border-border px-3 py-2 font-mono">
          {args != null ? (
            <details>
              <summary className="cursor-pointer text-muted-foreground">args</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words">
                {safe(args)}
              </pre>
            </details>
          ) : null}
          {result != null ? (
            <details open>
              <summary className="cursor-pointer text-muted-foreground">result</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words">
                {safe(result)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function safe(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Returns true if the value looks like a search_news output. */
export function isSearchNewsOutput(v: unknown): v is SearchNewsOutput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.results) || Array.isArray(o.sources_used);
}

// ============================================================
// DB-row renderers: events / future_events / business_context
// ============================================================

interface EventRow {
  id?: number;
  event_date?: string;
  title?: string;
  summary_md?: string;
  source_url?: string;
  source_title?: string;
  sentiment_label?: string;
  sentiment_score?: number;
}

interface FutureEventRow {
  id?: number;
  expected_date?: string;
  title?: string;
  description_md?: string;
  probability_positive?: number;
  probability_negative?: number;
  expected_impact_pct?: number;
  source_urls?: string[];
}

interface BusinessContextRow {
  stock_id?: number;
  summary_md?: string;
  timeline_md?: string;
  future_outlook_md?: string;
  updated_at?: string;
}

interface PricesOutput {
  prices?: Array<{ date: string; open?: number; high?: number; low?: number; close: number; volume?: number }>;
  rows?: Array<{ date: string; close: number }>;
}

export function DbEventsBlock({
  output,
  running,
}: {
  output: { events?: EventRow[] } | null;
  running: boolean;
}) {
  if (running) return <Running label="Reading events from DB…" />;
  const rows = output?.events ?? [];
  return (
    <DbCardList
      title="DB · events"
      empty="No events in DB yet."
      count={rows.length}
      cards={rows.map((r) => ({
        key: String(r.id),
        index: r.id ? `#${r.id}` : '?',
        title: r.title ?? '(untitled)',
        meta: [r.event_date, r.sentiment_label].filter(Boolean).join(' · '),
        body: r.summary_md ?? '',
        href: r.source_url,
        hrefLabel: r.source_title ?? hostnameOf(r.source_url ?? ''),
      }))}
    />
  );
}

export function DbFutureEventsBlock({
  output,
  running,
}: {
  output: { future_events?: FutureEventRow[] } | null;
  running: boolean;
}) {
  if (running) return <Running label="Reading future events from DB…" />;
  const rows = output?.future_events ?? [];
  return (
    <DbCardList
      title="DB · future events"
      empty="No forward-looking events recorded."
      count={rows.length}
      cards={rows.map((r) => ({
        key: String(r.id),
        index: r.id ? `#${r.id}` : '?',
        title: r.title ?? '(untitled)',
        meta: [
          r.expected_date,
          r.probability_positive != null ? `P+${(r.probability_positive * 100).toFixed(0)}%` : null,
          r.expected_impact_pct != null ? `impact ${r.expected_impact_pct.toFixed(2)}%` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        body: r.description_md ?? '',
        href: r.source_urls?.[0],
        hrefLabel: r.source_urls?.[0] ? hostnameOf(r.source_urls[0]) : undefined,
      }))}
    />
  );
}

export function DbBusinessContextBlock({
  output,
  running,
}: {
  output: BusinessContextRow | null;
  running: boolean;
}) {
  if (running) return <Running label="Reading business context…" />;
  if (!output || (!output.summary_md && !output.timeline_md && !output.future_outlook_md)) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        DB · business context: (empty)
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        DB · business context{output.updated_at ? ` · ${output.updated_at.slice(0, 10)}` : ''}
      </div>
      {output.summary_md ? <Section label="Summary" md={output.summary_md} /> : null}
      {output.timeline_md ? <Section label="Timeline" md={output.timeline_md} /> : null}
      {output.future_outlook_md ? <Section label="Future outlook" md={output.future_outlook_md} /> : null}
    </div>
  );
}

export function DbPricesBlock({
  output,
  running,
}: {
  output: PricesOutput | null;
  running: boolean;
}) {
  if (running) return <Running label="Reading prices…" />;
  const rows = output?.prices ?? output?.rows ?? [];
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        DB · prices: (empty)
      </div>
    );
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const change = ((last.close - first.close) / first.close) * 100;
  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
      <div className="flex items-baseline gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          DB · prices
        </span>
        <span className="font-mono tabular-nums">{rows.length} bars</span>
        <span className="font-mono tabular-nums">
          {first.date} → {last.date}
        </span>
        <span
          className={cn('font-mono tabular-nums', change >= 0 ? 'text-green-500' : 'text-red-500')}
        >
          {change >= 0 ? '+' : ''}
          {change.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

function Section({ label, md }: { label: string; md: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </summary>
      <div className="mt-1 whitespace-pre-wrap break-words">{md}</div>
    </details>
  );
}

function Running({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-blue-500/40 bg-blue-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-blue-400">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
        {label}
      </div>
    </div>
  );
}

function DbCardList({
  title,
  empty,
  count,
  cards,
}: {
  title: string;
  empty: string;
  count: number;
  cards: Array<{
    key: string;
    index: string;
    title: string;
    meta: string;
    body: string;
    href?: string;
    hrefLabel?: string;
  }>;
}) {
  if (count === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {title}: {empty}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title} · {count}
      </div>
      {cards.map((c) => (
        <DbCard key={c.key} card={c} />
      ))}
    </div>
  );
}

function DbCard({
  card,
}: {
  card: {
    index: string;
    title: string;
    meta: string;
    body: string;
    href?: string;
    hrefLabel?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="mt-0.5 inline-block min-w-[28px] rounded bg-background px-1 text-center text-[10px] tabular-nums text-muted-foreground">
          {card.index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">{card.title}</div>
          {card.meta ? (
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{card.meta}</div>
          ) : null}
        </div>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2 text-[11px] leading-relaxed">
          <div className="mb-1 whitespace-pre-wrap break-words">{card.body || '(no body)'}</div>
          {card.href ? (
            <a
              href={card.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400"
            >
              {card.hrefLabel ?? 'source'} <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function pickRenderer(toolName: string): 'news' | 'events' | 'future' | 'context' | 'prices' | 'generic' {
  if (toolName === 'search_news') return 'news';
  if (toolName === 'get_events') return 'events';
  if (toolName === 'get_future_events') return 'future';
  if (toolName === 'get_business_context') return 'context';
  if (toolName === 'get_prices' || toolName === 'get_prices_intraday') return 'prices';
  return 'generic';
}
