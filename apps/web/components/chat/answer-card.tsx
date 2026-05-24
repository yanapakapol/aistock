'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, Download, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';

interface AnswerCardProps {
  /** Concatenated markdown body — what the LLM returned for this turn. */
  text: string;
  /** True while this assistant turn is still streaming text from the server. */
  streaming: boolean;
  /** True if this is the most recent assistant turn in the list. Used to
   * auto-expand exactly once when streaming flips off, so the user sees the
   * fresh answer without an extra click — but older turns stay collapsed. */
  isLatest: boolean;
}

/**
 * Lower content card. Default collapsed (preview-only). Auto-expands once on
 * the freshest turn when streaming completes. User can toggle freely after.
 *
 * Preview = first ~2 lines of the cleaned markdown text (stripped of code
 * fences, headings, list markers — just plain prose). Long previews are
 * truncated to keep the collapsed card a constant compact height.
 */
export function AnswerCard({ text, streaming, isLatest }: AnswerCardProps) {
  const [expanded, setExpanded] = useState<boolean>(false);
  // Track whether we've already auto-expanded for THIS mount, so toggling
  // the user's manual collapse doesn't immediately get overridden by an effect.
  const autoExpandedRef = useRef(false);
  // While streaming, the latest turn should display the live text expanded so
  // the user can watch tokens arrive. As soon as it lands, stay expanded for
  // the freshest turn; collapse-by-default applies retroactively only to older turns.
  useEffect(() => {
    if (streaming && isLatest) {
      setExpanded(true);
      autoExpandedRef.current = true;
      return;
    }
    if (!streaming && isLatest && !autoExpandedRef.current) {
      setExpanded(true);
      autoExpandedRef.current = true;
    }
  }, [streaming, isLatest]);

  const preview = previewOf(text, 200);
  const hasMore = text.trim().length > preview.length;

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
    <div
      className={cn(
        'rounded-lg border bg-transparent transition-colors',
        expanded ? 'border-border' : 'border-border/60',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/20"
        aria-expanded={expanded}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
          Answer
        </span>
        {!expanded && preview ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {preview}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          {expanded ? (
            <>
              Hide <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              {hasMore ? 'Show answer' : 'Open'} <ChevronDown className="h-3 w-3" />
            </>
          )}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border/60 px-4 py-3">
          <div className="markdown-body">
            <Markdown source={text} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
            <button
              type="button"
              onClick={followUp}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <MessageSquare className="h-3 w-3" /> Follow-up
            </button>
            <span className="opacity-30">·</span>
            <button
              type="button"
              onClick={() => void exportAs('md')}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" /> .md
            </button>
            <button
              type="button"
              onClick={() => void exportAs('docx')}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" /> .docx
            </button>
            <button
              type="button"
              onClick={() => void exportAs('pdf')}
              className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
            >
              <Download className="h-3 w-3" /> .pdf
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Plain-text preview of markdown — strips fences, headings, list markers, link
 * brackets, emphasis markers — leaving the prose for a 1-line teaser. Limits
 * to `max` chars with an ellipsis.
 */
function previewOf(md: string, max: number): string {
  // Drop fenced code blocks entirely.
  const noCode = md.replace(/```[\s\S]*?```/g, ' ');
  // Strip the SAVED marker our chat route injects.
  const noMarker = noCode.replace(/\[\[SAVED:[^\]]*\]\]/g, ' ');
  // Strip headings, list bullets, blockquote markers.
  const noMarks = noMarker
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, '')
    .replace(/^\s*>\s+/gm, '');
  // Strip link/image syntax but keep label text.
  const noLinks = noMarks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Strip emphasis markers but keep inner text.
  const noEmph = noLinks.replace(/[*_`]/g, '');
  // Collapse whitespace.
  const flat = noEmph.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + '…';
}
