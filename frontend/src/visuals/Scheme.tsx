/**
 * Scheme templates of lecture visuals: the AI only fills in the content, the layout is ours, so they always look
 * tidy. flow — steps in order; cycle — a closed loop; timeline — events in time; compare — 2–4 options point by
 * point; hierarchy — a classification tree.
 */
import { useLayoutEffect, useRef, useState } from "react";

type Item = { title: string; text?: string; when?: string; points?: string[]; children?: Item[] };
export type SchemeData = { template: "flow" | "cycle" | "timeline" | "compare" | "hierarchy"; items: Item[] };

function Flow({ items }: { items: Item[] }) {
  return (
    <ol className="sch-flow">
      {items.map((it, i) => (
        <li key={i} className="sch-card">
          <span className="sch-num">{i + 1}</span>
          <b>{it.title}</b>
          {it.text && <span className="small muted">{it.text}</span>}
        </li>
      ))}
    </ol>
  );
}

function Cycle({ items }: { items: Item[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // one full-width wrapper for both layouts: the ring has a fixed size and would never report a narrower column,
  // and the observer must keep watching the same element when the layout switches
  return <div ref={ref}>{w < 460 ? <CycleAsList items={items} /> : <Ring items={items} w={w} />}</div>;
}

function CycleAsList({ items }: { items: Item[] }) {
  return (
    <>
      <Flow items={items} />
      <div className="small muted sch-loop">↻ после шага {items.length} — снова шаг 1</div>
    </>
  );
}

function Ring({ items, w }: { items: Item[]; w: number }) {
  const card = 156, size = Math.min(w, 600), height = Math.min(540, size * 0.86);
  const cx = size / 2, cy = height / 2, rx = size / 2 - card / 2 - 6, ry = height / 2 - 62;
  const pos = items.map((_, i) => {
    const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), a };
  });
  // arrows run along the ellipse between neighbouring cards and stop short of them, so the heads stay visible
  const gap = Math.min(Math.PI / items.length - 0.08, Math.max(0.4, (card / 2 + 18) / rx));
  const arc = (i: number) => {
    const a0 = pos[i].a + gap, a1 = pos[(i + 1) % items.length].a - gap + (i === items.length - 1 ? Math.PI * 2 : 0);
    const pts = Array.from({ length: 13 }, (_, k) => {
      const a = a0 + ((a1 - a0) * k) / 12;
      return `${cx + rx * 0.86 * Math.cos(a)},${cy + ry * 0.86 * Math.sin(a)}`;
    });
    return `M${pts.join("L")}`;
  };
  return (
    <div className="sch-cycle" style={{ width: size, height }}>
      <svg width={size} height={height} aria-hidden="true">
        <defs>
          <marker id="sch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0L10,5L0,10z" className="sch-arrow-head" />
          </marker>
        </defs>
        {items.map((_, i) => <path key={i} d={arc(i)} className="sch-arrow" markerEnd="url(#sch-arrow)" />)}
      </svg>
      {items.map((it, i) => (
        <div key={i} className="sch-card sch-cycle-card" style={{ left: pos[i].x - card / 2, top: pos[i].y, width: card }}>
          <span className="sch-num">{i + 1}</span>
          <b>{it.title}</b>
          {it.text && <span className="small muted">{it.text}</span>}
        </div>
      ))}
    </div>
  );
}

function Timeline({ items }: { items: Item[] }) {
  return (
    <ol className="sch-timeline">
      {items.map((it, i) => (
        <li key={i}>
          <span className="sch-when">{it.when}</span>
          <b>{it.title}</b>
          {it.text && <span className="small muted">{it.text}</span>}
        </li>
      ))}
    </ol>
  );
}

function Compare({ items }: { items: Item[] }) {
  const rows = Math.max(...items.map((it) => it.points?.length ?? 0));
  return (
    <div className="sch-compare" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(140px, 1fr))` }}>
      {items.map((it, i) => <div key={`h${i}`} className="sch-compare-head"><b>{it.title}</b>{it.text && <span className="small muted">{it.text}</span>}</div>)}
      {Array.from({ length: rows }, (_, r) => items.map((it, i) => (
        <div key={`${r}-${i}`} className="sch-compare-cell">{it.points?.[r] ?? ""}</div>
      )))}
    </div>
  );
}

function Branch({ item, depth }: { item: Item; depth: number }) {
  return (
    <li>
      <div className={`sch-node d${Math.min(depth, 3)}`}><b>{item.title}</b>{item.text && <span className="small muted">{item.text}</span>}</div>
      {!!item.children?.length && <ul>{item.children.map((c, i) => <Branch key={i} item={c} depth={depth + 1} />)}</ul>}
    </li>
  );
}

function Hierarchy({ items }: { items: Item[] }) {
  // one root: it heads the scheme and its children form the columns; several: they are the columns
  const root = items.length === 1 ? items[0] : null;
  const cols = root ? root.children ?? [] : items;
  return (
    <div className="sch-tree">
      {root && <div className="sch-node d0 sch-root"><b>{root.title}</b>{root.text && <span className="small muted">{root.text}</span>}</div>}
      <ul className="sch-cols">{cols.map((c, i) => <Branch key={i} item={c} depth={1} />)}</ul>
    </div>
  );
}

export default function Scheme({ data }: { data: SchemeData }) {
  const items = data?.items ?? [];
  if (!items.length) return <div className="alert error small">В схеме нет элементов</div>;
  switch (data.template) {
    case "flow": return <Flow items={items} />;
    case "cycle": return <Cycle items={items} />;
    case "timeline": return <Timeline items={items} />;
    case "compare": return <div style={{ overflowX: "auto" }}><Compare items={items} /></div>;
    case "hierarchy": return <Hierarchy items={items} />;
    default: return <div className="alert error small">Неизвестный шаблон схемы</div>;
  }
}
