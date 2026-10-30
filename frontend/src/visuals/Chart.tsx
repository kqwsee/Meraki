/**
 * Data charts of lecture visuals: grouped columns, lines, pie. Hand-drawn SVG measured to the real width, so the
 * mark specs hold in pixels: columns <= 24px with a 4px rounded data end, 2px lines, 8px end dots with a surface ring,
 * hairline grid, a legend for 2+ series, a hover readout and a table view.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";

export type ChartData = {
  type: "bar" | "line" | "pie";
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
  x_label?: string; y_label?: string; unit?: string;
};

// categorical slots, fixed order, validated on the app surface #1a1917 (dark): see the dataviz palette check
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];
const SURFACE = "var(--surface)";
const H = 260;
const MAX_PIE = 6;

const fmt = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(v / 1e3).toFixed(1)}K`;
  return String(+v.toFixed(Math.abs(v) < 10 ? 2 : 1));
};
const full = (v: number | null, unit = "") => (v == null ? "—" : `${v.toLocaleString("ru-RU")}${unit ? ` ${unit}` : ""}`);

function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (hi - lo < 1e-12) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(260, Math.floor(el.clientWidth))));
    ro.observe(el);
    setW(Math.max(260, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function column(x: number, w: number, base: number, top: number): string {
  const r = Math.min(4, w / 2, Math.abs(base - top));
  if (top <= base) return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
  return `M${x},${base}V${top - r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top - r}V${base}Z`;
}

type Tip = { x: number; y: number; title: string; rows: { color: string; name: string; value: string }[] } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 4), width - 200);
  return (
    <div className="chart-tip" style={{ left, top: Math.max(4, tip.y - 12) }} role="status">
      <div className="chart-tip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.name} className="chart-tip-row">
          <span className="chart-key" style={{ background: r.color }} />
          <b>{r.value}</b>
          {r.name && <span className="muted">{r.name}</span>}
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s) => <span key={s.name}><span className="chart-key" style={{ background: s.color }} />{s.name}</span>)}
    </div>
  );
}

function TableView({ data }: { data: ChartData }) {
  return (
    <details className="chart-table">
      <summary className="small muted">Таблица данных</summary>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>{data.x_label || ""}</th>{data.series.map((s, i) => <th key={i}>{s.name || data.y_label || "Значение"}</th>)}</tr></thead>
          <tbody>
            {data.labels.map((l, i) => (
              <tr key={i}><td>{l}</td>{data.series.map((s, k) => <td key={k}>{full(s.values[i], data.unit)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function XYChart({ data, width }: { data: ChartData; width: number }) {
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<number | null>(null);
  const isBar = data.type === "bar";
  const series = data.series.map((s, i) => ({ ...s, color: SERIES[i % SERIES.length] }));
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  let lo = Math.min(...all), hi = Math.max(...all);
  if (isBar) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  else { const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad; }
  const ticks = niceTicks(lo, hi);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];

  const n = data.labels.length;
  const lastVals = series.map((s) => [...s.values].reverse().find((v) => v != null) ?? null);
  const endLabels = !isBar && series.length <= 4;
  const left = 14 + Math.max(...ticks.map((t) => fmt(t).length)) * 7.2;
  const right = endLabels ? 18 + Math.max(...lastVals.map((v) => (v == null ? 0 : fmt(v).length))) * 7.4 : 14;
  const top = 12, bottom = 26 + (data.x_label ? 18 : 0);
  const pw = Math.max(40, width - left - right), ph = H - top - bottom;
  const sy = (v: number) => top + ph - ((v - y0) / (y1 - y0)) * ph;
  const band = pw / n;
  const cx = (i: number) => left + band * i + band / 2;
  const base = sy(isBar ? 0 : y0);

  // columns: <= 24px each, 2px surface gap between neighbours of a group, the rest of the band is air
  const sCount = series.length;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - (sCount - 1) * 2) / sCount));
  const groupW = barW * sCount + (sCount - 1) * 2;

  // x labels: every k-th one so they do not collide; full text stays in the tooltip and the table
  const avgChars = Math.max(...data.labels.map((l) => l.length));
  const every = Math.max(1, Math.ceil(((Math.min(avgChars, 16) * 7) + 10) / band));
  const shortLabel = (l: string) => {
    const max = Math.max(3, Math.floor((band * every - 8) / 7));
    return l.length > max ? `${l.slice(0, max - 1)}…` : l;
  };

  function show(i: number, x: number, y: number) {
    setHover(i);
    setTip({
      x, y, title: data.labels[i],
      rows: series.map((s) => ({ color: s.color, name: sCount > 1 ? s.name : "", value: full(s.values[i], data.unit) })),
    });
  }

  return (
    <div className="chart-wrap" onPointerLeave={() => { setTip(null); setHover(null); }}>
      <svg width={width} height={H} role="img" aria-label={`${isBar ? "Столбчатая" : "Линейная"} диаграмма: ${series.map((s) => s.name).join(", ")}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + pw} y1={sy(t)} y2={sy(t)} className={t === 0 && isBar ? "chart-base" : "chart-grid"} />
            <text x={left - 8} y={sy(t)} dy="0.32em" textAnchor="end" className="chart-tick">{fmt(t)}</text>
          </g>
        ))}
        {data.labels.map((l, i) => i % every === 0 && (
          <text key={i} x={cx(i)} y={top + ph + 17} textAnchor="middle" className="chart-tick">{shortLabel(l)}</text>
        ))}
        {data.x_label && <text x={left + pw / 2} y={H - 4} textAnchor="middle" className="chart-axis-label">{data.x_label}</text>}
        {data.y_label && <text x={left} y={top - 2} className="chart-axis-label" dy="-0.1em">{data.y_label}</text>}

        {isBar && series.map((s, k) => s.values.map((v, i) => v == null ? null : (
          <path key={`${k}-${i}`} d={column(cx(i) - groupW / 2 + k * (barW + 2), barW, base, sy(v))} fill={s.color}
            opacity={hover == null || hover === i ? 1 : 0.45} />
        )))}
        {isBar && data.labels.map((_, i) => (
          <rect key={i} x={left + band * i} y={top} width={band} height={ph} fill="transparent"
            onPointerMove={(e) => show(i, (e.nativeEvent as PointerEvent).offsetX, (e.nativeEvent as PointerEvent).offsetY)}
            onFocus={() => show(i, cx(i), top + 10)} tabIndex={0} aria-label={`${data.labels[i]}: ${series.map((s) => full(s.values[i], data.unit)).join(", ")}`} />
        ))}

        {!isBar && series.map((s, k) => {
          let d = "", pen = false;
          s.values.forEach((v, i) => {
            if (v == null) { pen = false; return; }
            d += `${pen ? "L" : "M"}${cx(i)},${sy(v)}`;
            pen = true;
          });
          const lastI = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null);
          const lv = s.values[lastI];
          return (
            <g key={k}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {lv != null && <circle cx={cx(lastI)} cy={sy(lv)} r={4} fill={s.color} style={{ stroke: SURFACE }} strokeWidth={2} />}
              {endLabels && lv != null && <text x={cx(lastI) + 9} y={sy(lv)} dy="0.32em" className="chart-value">{fmt(lv)}</text>}
            </g>
          );
        })}
        {!isBar && hover != null && (
          <g pointerEvents="none">
            <line x1={cx(hover)} x2={cx(hover)} y1={top} y2={top + ph} className="chart-cross" />
            {series.map((s, k) => s.values[hover] != null && (
              <circle key={k} cx={cx(hover)} cy={sy(s.values[hover]!)} r={4} fill={s.color} style={{ stroke: SURFACE }} strokeWidth={2} />
            ))}
          </g>
        )}
        {!isBar && (
          <rect x={left} y={top} width={pw} height={ph} fill="transparent"
            onPointerMove={(e) => {
              const x = (e.nativeEvent as PointerEvent).offsetX;
              const i = Math.max(0, Math.min(n - 1, Math.round((x - left - band / 2) / band)));
              show(i, x, (e.nativeEvent as PointerEvent).offsetY);
            }} />
        )}
      </svg>
      <Tooltip tip={tip} width={width} />
      <Legend series={series} />
    </div>
  );
}

function PieChart({ data, width }: { data: ChartData; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const slices = useMemo(() => {
    const raw = data.labels.map((l, i) => ({ label: l, value: Math.max(0, data.series[0]?.values[i] ?? 0) })).filter((s) => s.value > 0);
    if (raw.length <= MAX_PIE) return raw;
    const keep = raw.slice(0, MAX_PIE - 1);
    return [...keep, { label: "Другое", value: raw.slice(MAX_PIE - 1).reduce((a, s) => a + s.value, 0) }];
  }, [data]);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const size = Math.min(220, width - 20);
  const R = size / 2 - 4, r = R * 0.58, c = size / 2;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const a0 = angle, a1 = angle + (s.value / total) * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${c + rad * Math.cos(a)},${c + rad * Math.sin(a)}`;
    const d = slices.length === 1
      ? `M${c - R},${c}A${R},${R} 0 1 1 ${c + R},${c}A${R},${R} 0 1 1 ${c - R},${c}M${c - r},${c}A${r},${r} 0 1 0 ${c + r},${c}A${r},${r} 0 1 0 ${c - r},${c}Z`
      : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
    return { ...s, d, color: SERIES[i % SERIES.length] };
  });
  const focus = hover != null ? arcs[hover] : null;
  return (
    <div className="chart-pie">
      <svg width={size} height={size} role="img" aria-label={`Круговая диаграмма: ${arcs.map((a) => `${a.label} ${Math.round((a.value / total) * 100)}%`).join(", ")}`}>
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.color} style={{ stroke: SURFACE }} strokeWidth={2} opacity={hover == null || hover === i ? 1 : 0.45}
            onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
        ))}
        <text x={c} y={c - 6} textAnchor="middle" className="chart-pie-value">{focus ? `${Math.round((focus.value / total) * 100)}%` : fmt(total)}</text>
        <text x={c} y={c + 14} textAnchor="middle" className="chart-tick">{focus ? (focus.label.length > 16 ? `${focus.label.slice(0, 15)}…` : focus.label) : data.unit || "всего"}</text>
      </svg>
      <div className="chart-pie-legend">
        {arcs.map((a, i) => (
          <div key={i} className={`chart-pie-row ${hover === i ? "on" : ""}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <span className="chart-key" style={{ background: a.color }} />
            <span className="t">{a.label}</span>
            <b>{full(a.value, data.unit)}</b>
            <span className="muted">{Math.round((a.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Chart({ data }: { data: ChartData }) {
  const [ref, width] = useWidth();
  if (!data?.labels?.length || !data.series?.length) return <div className="alert error small">В диаграмме нет данных</div>;
  return (
    <div ref={ref} className="chart">
      {data.type === "pie" ? <PieChart data={data} width={width} /> : <XYChart data={data} width={width} />}
      <TableView data={data} />
    </div>
  );
}
