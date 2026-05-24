'use client';

import { useMemo, useRef, useState } from 'react';

export interface PricePoint {
  date: string;
  close: number;
}

interface Props {
  data: PricePoint[];
  height?: number;
}

const PAD = { top: 16, right: 16, bottom: 28, left: 48 };
const VBW = 800;

export function PriceChart({ data, height = 320 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const view = useMemo(() => {
    if (data.length === 0) return null;
    const closes = data.map((d) => d.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || max || 1;
    const margin = span * 0.08;
    const yMin = min - margin;
    const yMax = max + margin;
    const w = VBW - PAD.left - PAD.right;
    const h = height - PAD.top - PAD.bottom;
    const xAt = (i: number) =>
      PAD.left + (data.length === 1 ? w / 2 : (i * w) / (data.length - 1));
    const yAt = (v: number) => PAD.top + h - ((v - yMin) / (yMax - yMin)) * h;
    const path = data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(d.close).toFixed(2)}`)
      .join(' ');
    const ticks: number[] = [];
    for (let t = 0; t <= 4; t++) ticks.push(yMin + ((yMax - yMin) * t) / 4);
    const step = Math.max(1, Math.round(data.length / 6));
    const xTickIdx: number[] = [];
    for (let i = 0; i < data.length; i += step) xTickIdx.push(i);
    if (xTickIdx[xTickIdx.length - 1] !== data.length - 1) xTickIdx.push(data.length - 1);
    return { xAt, yAt, path, ticks, xTickIdx, w, h, yMin, yMax };
  }, [data, height]);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!view || data.length === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const xPx = ((e.clientX - rect.left) / rect.width) * VBW;
    const ratio = Math.max(0, Math.min(1, (xPx - PAD.left) / view.w));
    const i = Math.round(ratio * (data.length - 1));
    setHover({ i, x: view.xAt(i), y: view.yAt(data[i].close) });
  }

  if (!view) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-md border border-border bg-muted/20 text-xs text-muted-foreground"
        style={{ height }}
      >
        No price data yet
      </div>
    );
  }

  const fmtNum = (n: number) =>
    n >= 1000 ? n.toFixed(0) : n >= 100 ? n.toFixed(1) : n.toFixed(2);
  const hoverPt = hover ? data[hover.i] : null;
  const tooltipLeft = hover ? Math.min(Math.max(hover.x, 80), VBW - 80) : 0;
  const tooltipAbove = hover ? hover.y > height / 2 : true;

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${VBW} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {view.ticks.map((t, i) => {
          const y = view.yAt(t);
          return (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={VBW - PAD.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.08}
              />
              <text
                x={PAD.left - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
                opacity={0.6}
              >
                {fmtNum(t)}
              </text>
            </g>
          );
        })}
        {view.xTickIdx.map((i) => {
          const x = view.xAt(i);
          return (
            <text
              key={i}
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              opacity={0.6}
            >
              {data[i].date.slice(5)}
            </text>
          );
        })}
        <path d={view.path} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.85} />
        {hover ? (
          <g>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeDasharray="3,3"
            />
            <circle cx={hover.x} cy={hover.y} r={3.5} fill="currentColor" />
          </g>
        ) : null}
      </svg>
      {hover && hoverPt ? (
        <div
          className="pointer-events-none absolute rounded-md border border-border bg-background px-2 py-1 text-xs shadow-md"
          style={{
            left: `${(tooltipLeft / VBW) * 100}%`,
            top: tooltipAbove ? undefined : 8,
            bottom: tooltipAbove ? height - (hover.y / height) * height + 12 : undefined,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="font-medium">{hoverPt.date}</div>
          <div className="text-muted-foreground">close {fmtNum(hoverPt.close)}</div>
        </div>
      ) : null}
    </div>
  );
}
