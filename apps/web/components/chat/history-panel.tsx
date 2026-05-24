'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Trash2, Sparkles, X, FileText } from 'lucide-react';

interface ChatRow {
  id: number;
  tab: 'research' | 'analysis';
  stockId: number | null;
  model: string;
  createdAt: string;
  preview: string | null;
  msgCount: number;
}

interface LoadedMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  contentMd: string;
  parts?: Array<Record<string, unknown>> | null;
}

interface Props {
  tab: 'research' | 'analysis';
  stockId?: number | null;
  open: boolean;
  onClose: () => void;
  /** Called when user picks a chat — receives UI-message-shaped history.
   *  Parts may be the persisted full-fidelity payload (text, tool-*, reasoning)
   *  or a fallback `[{type:'text',text}]` for pre-parts rows. */
  onLoad: (
    chatId: number,
    messages: Array<{
      id: string;
      role: 'user' | 'assistant' | 'system';
      parts: Array<Record<string, unknown>>;
    }>,
  ) => void;
}

export function HistoryPanel({ tab, stockId, open, onClose, onLoad }: Props) {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ tab });
      if (stockId) qs.set('stockId', String(stockId));
      const r = await fetch(`/api/chats?${qs.toString()}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { chats: ChatRow[] };
      setChats(j.chats ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab, stockId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function remove(id: number) {
    if (!confirm('Delete this chat? Its messages will be removed from the database.')) return;
    const r = await fetch(`/api/chats/${id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    if (r.ok) setChats((prev) => prev.filter((c) => c.id !== id));
  }

  async function purgeSimulated() {
    if (
      !confirm(
        'Delete all chats with assistant messages that look like fabricated/simulated data (matches "simulated", "Simulated News", "If Tools Were Available", etc.)?',
      )
    ) {
      return;
    }
    setPurging(true);
    try {
      const r = await fetch('/api/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab, stockId: stockId ?? undefined }),
      });
      const j = (await r.json()) as { deleted?: number };
      alert(`Purged ${j.deleted ?? 0} chat${j.deleted === 1 ? '' : 's'}.`);
      void refresh();
    } finally {
      setPurging(false);
    }
  }

  async function load(id: number) {
    // Stash the chat-id in sessionStorage and add ?loadChat=<id> to the URL,
    // then hard-navigate. The chat client looks for ?loadChat on mount and
    // fetches + applies the messages there — bypasses all persistence races.
    try {
      sessionStorage.setItem('aistock:pendingLoadChat', String(id));
    } catch {
      /* ignore */
    }
    onClose();
    const url = new URL(window.location.href);
    url.searchParams.set('loadChat', String(id));
    // Try to keep the active stock URL param right (use the chat's own stock
    // when present so the chat lands in its proper scope).
    try {
      const meta = await fetch(`/api/chats/${id}`).then((r) => r.json());
      const sid = meta?.chat?.stockId;
      if (sid != null && tab === 'research') {
        url.searchParams.set('stock', String(sid));
      }
    } catch {
      /* ignore — load will still fire on mount */
    }
    window.location.href = url.toString();
  }

  const [summaryFor, setSummaryFor] = useState<number | null>(null);
  const [summaryText, setSummaryText] = useState<string>('');
  const [summarizing, setSummarizing] = useState(false);

  async function viewSummary(id: number) {
    setSummaryFor(id);
    setSummaryText('Loading…');
    const r = await fetch(`/api/chats/${id}/summarize`);
    const j = (await r.json()) as { summary?: { summaryMd: string } | null };
    setSummaryText(j.summary?.summaryMd ?? '(no summary yet — click Generate)');
  }

  async function generateSummary(id: number) {
    setSummarizing(true);
    setSummaryText('Generating…');
    try {
      const r = await fetch(`/api/chats/${id}/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = (await r.json()) as { summary?: { summaryMd: string }; error?: string };
      setSummaryText(j.summary?.summaryMd ?? j.error ?? 'Summary failed.');
    } finally {
      setSummarizing(false);
    }
  }

  if (!open) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-full flex-col border-l border-border bg-background shadow-lg sm:w-96">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-semibold">Chat history</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close history"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          Refresh
        </Button>
        <Button size="sm" variant="outline" onClick={purgeSimulated} disabled={purging}>
          <Sparkles className="h-3.5 w-3.5" />
          Purge simulated
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
        ) : err ? (
          <div className="px-3 py-3 text-xs text-red-500">{err}</div>
        ) : chats.length === 0 ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">No chats yet for this tab.</div>
        ) : (
          <ul>
            {chats.map((c) => (
              <li
                key={c.id}
                className={cn(
                  'group flex items-start gap-2 border-b border-border/60 px-3 py-2 hover:bg-accent/50',
                )}
              >
                <button
                  type="button"
                  onClick={() => void load(c.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="truncate text-xs font-medium">
                    {c.preview?.trim() || '(empty)'}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {new Date(c.createdAt).toLocaleString()} · {c.model} · {c.msgCount} msg
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void viewSummary(c.id)}
                  className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground group-hover:opacity-100"
                  aria-label="View summary"
                  title="View / generate AI summary"
                >
                  <FileText className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(c.id)}
                  className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-background hover:text-red-500 group-hover:opacity-100"
                  aria-label="Delete chat"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {summaryFor != null ? (
        <div className="absolute inset-0 z-40 flex flex-col bg-background">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="text-sm font-semibold">Chat #{summaryFor} — summary</div>
            <button
              type="button"
              onClick={() => setSummaryFor(null)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close summary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Button size="sm" onClick={() => void generateSummary(summaryFor!)} disabled={summarizing}>
              {summarizing ? 'Generating…' : 'Generate fresh summary'}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              Stored separately from raw history.
            </span>
          </div>
          <div className="flex-1 overflow-auto px-3 py-3">
            <pre className="whitespace-pre-wrap break-words text-xs">{summaryText}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
