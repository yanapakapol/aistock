'use client';

import { Fragment } from 'react';

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function TableBlock({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            {header.map((h, i) => (
              <th key={i} className="px-2 py-1.5 text-left font-semibold">
                {renderInline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1.5 align-top">
                  {renderInline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ChartSpec {
  type?: 'line' | 'bar';
  title?: string;
  xLabel?: string;
  yLabel?: string;
  data?: Array<{ x: string | number; y: number; label?: string }>;
}

function ChartBlock({ json }: { json: string }) {
  let spec: ChartSpec | null = null;
  try {
    spec = JSON.parse(json) as ChartSpec;
  } catch {
    return (
      <pre className="my-2 overflow-x-auto rounded-md border border-red-500/40 bg-red-500/5 p-2 text-[11px] text-red-400">
        invalid chart JSON
        {'\n'}
        {json}
      </pre>
    );
  }
  const data = spec.data ?? [];
  if (data.length === 0) return null;
  const W = 480;
  const H = 200;
  const pad = { l: 36, r: 12, t: spec.title ? 26 : 12, b: 22 };
  const ys = data.map((d) => d.y);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const yRange = yMax - yMin || 1;
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const yScale = (v: number) => pad.t + innerH - ((v - yMin) / yRange) * innerH;
  const type = spec.type ?? 'line';

  // 4 gridlines
  const gridYs = [0, 0.25, 0.5, 0.75, 1].map((p) => pad.t + p * innerH);

  return (
    <div className="my-2 rounded-md border border-border bg-muted/20 p-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block">
        {spec.title ? (
          <text x={W / 2} y={16} textAnchor="middle" className="fill-foreground" fontSize={12}>
            {spec.title}
          </text>
        ) : null}
        {/* gridlines */}
        {gridYs.map((y, i) => (
          <line
            key={i}
            x1={pad.l}
            x2={W - pad.r}
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeOpacity={0.1}
          />
        ))}
        {/* y labels (min/max) */}
        <text x={4} y={pad.t + 4} fontSize={9} className="fill-muted-foreground">
          {yMax.toFixed(2)}
        </text>
        <text x={4} y={H - pad.b} fontSize={9} className="fill-muted-foreground">
          {yMin.toFixed(2)}
        </text>
        {/* x labels (first/last) */}
        <text x={pad.l} y={H - 6} fontSize={9} className="fill-muted-foreground">
          {String(data[0]!.x)}
        </text>
        <text
          x={W - pad.r}
          y={H - 6}
          textAnchor="end"
          fontSize={9}
          className="fill-muted-foreground"
        >
          {String(data[data.length - 1]!.x)}
        </text>
        {/* series */}
        {type === 'bar'
          ? data.map((d, i) => {
              const x = pad.l + i * xStep;
              const y = yScale(d.y);
              const w = Math.max(2, xStep * 0.7);
              return (
                <rect
                  key={i}
                  x={x - w / 2}
                  y={y}
                  width={w}
                  height={pad.t + innerH - y}
                  className="fill-blue-500/70"
                />
              );
            })
          : (() => {
              const path = data
                .map(
                  (d, i) =>
                    `${i === 0 ? 'M' : 'L'}${(pad.l + i * xStep).toFixed(1)} ${yScale(d.y).toFixed(1)}`,
                )
                .join(' ');
              return (
                <>
                  <path d={path} fill="none" stroke="rgb(59 130 246)" strokeWidth={1.5} />
                  {data.map((d, i) => (
                    <circle
                      key={i}
                      cx={pad.l + i * xStep}
                      cy={yScale(d.y)}
                      r={1.5}
                      className="fill-blue-400"
                    />
                  ))}
                </>
              );
            })()}
      </svg>
      {spec.xLabel || spec.yLabel ? (
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{spec.xLabel ?? ''}</span>
          <span>{spec.yLabel ?? ''}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Match the AI's `[[SAVED:E=4,F=1,C=1]]` marker — see chat route preamble. */
const SAVED_MARKER_RE = /\[\[SAVED:E=(\d+),F=(\d+),C=(\d+)\]\]/g;

function SavedBadge({ e, f, c }: { e: number; f: number; c: number }) {
  const total = e + f + c;
  const ok = total > 0;
  return (
    <span
      title={`Saved to DB: ${e} event(s), ${f} future_event(s), ${c} business_context update(s)`}
      className={
        ok
          ? 'inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-400'
          : 'inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground'
      }
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {ok ? `saved · ${e}e · ${f}f · ${c}c` : 'no DB writes'}
    </span>
  );
}

/**
 * Minimal markdown renderer — no external deps. Handles:
 *   - `# … ######` headings
 *   - `**bold**`, `*italic*`, `` `code` ``
 *   - `[label](url)` links (auto-target=_blank)
 *   - bare URLs auto-linkified
 *   - `- ` / `* ` / `1. ` lists
 *   - fenced code blocks
 *   - blank-line paragraphs
 *
 * Deliberately strips leading `**`/`__` and any `==`/`---`/`***`/`//` rules so
 * the assistant's chatty ornaments don't render as raw `**` / `##` to the user.
 */
export function Markdown({ source }: { source: string }) {
  // Strip + capture SAVED markers; render them as small badges appended at the end.
  const badges: Array<{ e: number; f: number; c: number }> = [];
  const cleaned = source.replace(SAVED_MARKER_RE, (_, e, f, c) => {
    badges.push({ e: Number(e), f: Number(f), c: Number(c) });
    return '';
  });
  return (
    <>
      {renderBlocks(cleaned)}
      {badges.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {badges.map((b, i) => (
            <SavedBadge key={i} e={b.e} f={b.f} c={b.c} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function renderBlocks(src: string): React.ReactNode[] {
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip ornamental rules.
    if (/^(?:-{3,}|\*{3,}|_{3,}|={3,}|\/{2,})$/.test(trimmed)) {
      i++;
      continue;
    }
    // Skip pure blank line.
    if (trimmed === '') {
      i++;
      continue;
    }

    // Fenced code block (or chart).
    if (/^```/.test(trimmed)) {
      const lang = trimmed.replace(/^```/, '').trim().toLowerCase();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!.trim())) {
        buf.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const body = buf.join('\n');
      if (lang === 'chart') {
        out.push(<ChartBlock key={key++} json={body} />);
      } else {
        out.push(
          <pre
            key={key++}
            className="my-2 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] font-mono"
          >
            {body}
          </pre>,
        );
      }
      continue;
    }

    // GFM pipe table: header row, then `|---|---|`, then body rows.
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())
    ) {
      const header = splitRow(trimmed);
      i += 2; // skip separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(splitRow(lines[i]!.trim()));
        i++;
      }
      out.push(<TableBlock key={key++} header={header} rows={rows} />);
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (h) {
      const level = h[1]!.length;
      const txt = h[2]!;
      const cls =
        level <= 2
          ? 'mt-3 mb-1 text-base font-semibold'
          : level === 3
            ? 'mt-2 mb-1 text-sm font-semibold'
            : 'mt-2 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground';
      out.push(
        <div key={key++} className={cls}>
          {renderInline(txt)}
        </div>,
      );
      i++;
      continue;
    }

    // Unordered or ordered list.
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      const ordered = /^\d+\.\s+/.test(trimmed);
      while (i < lines.length) {
        const t = lines[i]!.trim();
        if (ordered ? /^\d+\.\s+/.test(t) : /^[-*]\s+/.test(t)) {
          items.push(t.replace(/^(?:\d+\.|[-*])\s+/, ''));
          i++;
        } else if (t === '') {
          // peek: if next non-empty is still a list item, continue
          let j = i + 1;
          while (j < lines.length && lines[j]!.trim() === '') j++;
          if (
            j < lines.length &&
            (ordered
              ? /^\d+\.\s+/.test(lines[j]!.trim())
              : /^[-*]\s+/.test(lines[j]!.trim()))
          ) {
            i = j;
            continue;
          }
          break;
        } else {
          break;
        }
      }
      const ListTag = ordered ? 'ol' : 'ul';
      out.push(
        <ListTag
          key={key++}
          className={
            ordered
              ? 'my-2 ml-2 list-decimal space-y-1.5 pl-5 leading-relaxed marker:text-muted-foreground'
              : 'my-2 ml-2 list-disc space-y-1.5 pl-5 leading-relaxed marker:text-muted-foreground'
          }
        >
          {items.map((it, idx) => (
            <li key={idx} className="pl-1">
              {renderInline(it)}
            </li>
          ))}
        </ListTag>,
      );
      continue;
    }

    // Paragraph: collect contiguous non-empty lines.
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      const t = lines[i]!.trim();
      if (/^(?:#{1,6}\s|[-*]\s|\d+\.\s|```)/.test(t)) break;
      buf.push(lines[i]!);
      i++;
    }
    if (buf.length > 0) {
      out.push(
        <p key={key++} className="my-2 leading-relaxed">
          {renderInline(buf.join(' '))}
        </p>,
      );
    }
  }
  return out;
}

const URL_RE = /\bhttps?:\/\/[^\s)\]]+/g;

function renderInline(text: string): React.ReactNode {
  // Strip stray surrounding bold/heading markers the LLM might have left.
  const clean = text.replace(/\s*#{1,6}\s*$/, '').trim();

  // Tokenize on `[label](url)` first so we don't double-process URLs.
  const out: React.ReactNode[] = [];
  let i = 0;
  const re = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(clean)) !== null) {
    if (m.index > lastIndex) {
      out.push(<Fragment key={i++}>{renderInlineNoLinks(clean.slice(lastIndex, m.index))}</Fragment>);
    }
    out.push(
      <a
        key={i++}
        href={m[2]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400"
      >
        {m[1]}
      </a>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < clean.length) {
    out.push(<Fragment key={i++}>{renderInlineNoLinks(clean.slice(lastIndex))}</Fragment>);
  }
  return out;
}

function renderInlineNoLinks(text: string): React.ReactNode {
  // Auto-linkify bare URLs.
  const parts: React.ReactNode[] = [];
  let i = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(<Fragment key={i++}>{renderEmphasis(text.slice(lastIndex, m.index))}</Fragment>);
    }
    parts.push(
      <a
        key={i++}
        href={m[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400"
      >
        {m[0]}
      </a>,
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(<Fragment key={i++}>{renderEmphasis(text.slice(lastIndex))}</Fragment>);
  }
  return parts;
}

function renderEmphasis(text: string): React.ReactNode {
  // Order matters: bold (**...**) → italic (*...*) → inline code (`...`).
  const segs: Array<{ kind: 'text' | 'b' | 'i' | 'code'; body: string }> = [];
  let rest = text;
  while (rest.length > 0) {
    const codeIdx = rest.indexOf('`');
    const boldIdx = rest.indexOf('**');
    const italicIdx = (() => {
      // single * not part of **
      const m = /(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/.exec(rest);
      return m ? rest.indexOf(m[0]) + (m[1] ? m[1].length : 0) : -1;
    })();
    // Pick the nearest valid marker.
    const candidates = [
      { kind: 'code' as const, idx: codeIdx },
      { kind: 'b' as const, idx: boldIdx },
      { kind: 'i' as const, idx: italicIdx },
    ]
      .filter((c) => c.idx >= 0)
      .sort((a, b) => a.idx - b.idx);
    if (candidates.length === 0) {
      segs.push({ kind: 'text', body: rest });
      break;
    }
    const first = candidates[0]!;
    if (first.idx > 0) segs.push({ kind: 'text', body: rest.slice(0, first.idx) });
    if (first.kind === 'b') {
      const close = rest.indexOf('**', first.idx + 2);
      if (close < 0) {
        segs.push({ kind: 'text', body: rest.slice(first.idx) });
        break;
      }
      segs.push({ kind: 'b', body: rest.slice(first.idx + 2, close) });
      rest = rest.slice(close + 2);
    } else if (first.kind === 'i') {
      const m = /(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/.exec(rest.slice(first.idx));
      if (!m) {
        segs.push({ kind: 'text', body: rest.slice(first.idx) });
        break;
      }
      const innerStart = first.idx + (m[1] ? m[1].length : 0) + 1;
      const inner = m[2]!;
      segs.push({ kind: 'i', body: inner });
      rest = rest.slice(innerStart + inner.length + 1);
    } else {
      const close = rest.indexOf('`', first.idx + 1);
      if (close < 0) {
        segs.push({ kind: 'text', body: rest.slice(first.idx) });
        break;
      }
      segs.push({ kind: 'code', body: rest.slice(first.idx + 1, close) });
      rest = rest.slice(close + 1);
    }
  }
  return segs.map((s, idx) =>
    s.kind === 'text' ? (
      <Fragment key={idx}>{s.body}</Fragment>
    ) : s.kind === 'b' ? (
      <strong key={idx} className="font-semibold text-foreground">
        {s.body}
      </strong>
    ) : s.kind === 'i' ? (
      <em key={idx} className="italic">
        {s.body}
      </em>
    ) : (
      <code key={idx} className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">
        {s.body}
      </code>
    ),
  );
}
