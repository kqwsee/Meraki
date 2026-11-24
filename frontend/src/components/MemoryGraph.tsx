import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "./Icon";

export type GraphNodeKind = "course" | "mastered" | "fact" | "strength" | "growth" | "note";
/** `cluster` only drives layout: nodes sharing a cluster key drift toward the same loose "cloud"
 * instead of everything converging on one hub. Leave it unset (or shared by everything) for a
 * single blob; give each course's nodes `course:<id>` and leave unaffiliated ones unset ("_misc")
 * to get separate, lightly-held-apart clouds. */
export type GraphNode = { id: string; label: string; kind: GraphNodeKind; cluster?: string; detail?: string };
export type GraphLink = { source: string; target: string };

type SimNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
type SimLink = { source: SimNode; target: SimNode };
type Pan = { x: number; y: number };

const STYLE: Record<GraphNodeKind, { fill: string; r: number }> = {
  course: { fill: "var(--accent)", r: 16 },
  mastered: { fill: "var(--success)", r: 9 },
  fact: { fill: "var(--bridge)", r: 8 },
  strength: { fill: "var(--success)", r: 8 },
  growth: { fill: "var(--warning)", r: 8 },
  note: { fill: "var(--muted)", r: 6 },
};

const LEGEND: { kind: GraphNodeKind; label: string }[] = [
  { kind: "course", label: "курс" },
  { kind: "mastered", label: "освоено / сильная сторона" },
  { kind: "fact", label: "факт из памяти" },
  { kind: "growth", label: "зона роста" },
  { kind: "note", label: "заметка" },
];

/** Force-directed map of courses, mastered concepts, memory facts, strengths, growth areas and notes.
 * Nodes keep their x/y across re-renders (mutated in place by d3-force) so the graph doesn't
 * reset or jump when the underlying data refreshes. */
export default function MemoryGraph({ nodes, links, onNodeClick, fill }: {
  nodes: GraphNode[]; links: GraphLink[]; onNodeClick?: (n: GraphNode) => void;
  /** Stretch to fill the parent's box (give the parent a real height) instead of sizing from width alone. */
  fill?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const [, bump] = useState(0);
  const [size, setSize] = useState({ w: 640, h: 320 });
  const [dragging, setDragging] = useState<string | null>(null);
  // view offset applied to the whole scene; kept in a ref too so pointer handlers read the latest
  // value without being re-created on every move frame
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const panRef = useRef<Pan>(pan);
  const [panning, setPanning] = useState(false);
  // a pointerup that ends a real node drag is still followed by a click on that node; remember to
  // swallow it so dragging a course never navigates to its page
  const suppressClickRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const showLabels = nodes.length <= 6;
  const MIN_ZOOM = 0.35;
  const MAX_ZOOM = 3;

  /** Zoom to `next` while keeping the screen point (cx, cy) — relative to the SVG box — pinned to
   * the same spot of the map. Pan is in screen pixels, so screen = pan + zoom * graph. */
  const applyZoom = useCallback((next: number, cx: number, cy: number) => {
    const from = zoomRef.current;
    const to = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (to === from) return;
    const p = panRef.current;
    const nextPan = { x: cx - ((cx - p.x) * to) / from, y: cy - ((cy - p.y) * to) / from };
    zoomRef.current = to;
    panRef.current = nextPan;
    setZoom(to);
    setPan(nextPan);
  }, []);

  // native (non-passive) wheel listener: React's onWheel is passive, so preventDefault there
  // wouldn't stop the page from scrolling while zooming the map
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!fill) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      applyZoom(zoomRef.current * Math.exp(-delta * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [applyZoom, fill]);

  function zoomBy(factor: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    applyZoom(zoomRef.current * factor, (rect?.width ?? size.w) / 2, (rect?.height ?? size.h) / 2);
  }

  function resetView() {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      if (w > 0 && (fill ? h > 0 : true)) {
        setSize(fill ? { w, h } : { w, h: Math.max(240, Math.min(420, Math.round(w * 0.42))) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  useEffect(() => {
    const simNodes: SimNode[] = nodes.map((n) => {
      const prev = nodesRef.current.find((p) => p.id === n.id);
      return { ...n, x: prev?.x ?? size.w / 2 + (Math.random() - 0.5) * 40, y: prev?.y ?? size.h / 2 + (Math.random() - 0.5) * 40 };
    });
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks = links.map((l) => ({ source: byId.get(l.source)!, target: byId.get(l.target)! })).filter((l) => l.source && l.target) as SimLink[];
    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    // Separate clusters within the canvas, using the wider axis when there are only two.
    const cx = size.w / 2;
    const cy = size.h / 2;
    const clusterIds = Array.from(new Set(simNodes.map((n) => n.cluster ?? "_misc")));
    const anchor = new Map<string, { x: number; y: number }>();
    if (clusterIds.length <= 1) {
      clusterIds.forEach((k) => anchor.set(k, { x: cx, y: cy }));
    } else {
      const radiusX = Math.min(size.w * 0.26, size.h * 0.45);
      const radiusY = size.h * 0.22;
      const startAngle = clusterIds.length === 2 ? Math.PI : -Math.PI / 2;
      clusterIds.forEach((k, i) => {
        const angle = startAngle + (2 * Math.PI * i) / clusterIds.length;
        anchor.set(k, { x: cx + radiusX * Math.cos(angle), y: cy + radiusY * Math.sin(angle) });
      });
    }
    const anchorOf = (d: SimNode) => anchor.get(d.cluster ?? "_misc") ?? { x: cx, y: cy };

    const sim = forceSimulation(simNodes)
      .force("charge", forceManyBody().strength(-170))
      .force("link", forceLink<SimNode, SimLink>(simLinks).distance((l) =>
        l.source.kind === "course" || l.target.kind === "course" ? (showLabels ? 104 : 70) : 56,
      ).strength(0.55))
      .force("center", forceCenter(cx, cy))
      .force("x", forceX<SimNode>((d) => anchorOf(d).x).strength(0.07))
      .force("y", forceY<SimNode>((d) => anchorOf(d).y).strength(0.07))
      .force("collide", forceCollide<SimNode>().radius((d) => STYLE[d.kind].r + (showLabels ? 28 : 16)))
      .on("tick", () => bump((t) => (t + 1) % 1_000_000));
    simRef.current = sim;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sim.stop().tick(220);
      bump((t) => t + 1);
    }
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, size.w, size.h, showLabels]);

  function startDrag(n: SimNode, e: ReactPointerEvent<SVGGElement>) {
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement;
    const sim = simRef.current;
    if (!svg || !sim) return;
    sim.alphaTarget(0.3).restart();
    setDragging(n.id);
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      // a few pixels of slack so a normal click with a shaky hand still counts as a click
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) moved = true;
      const rect = svg.getBoundingClientRect();
      const z = zoomRef.current;
      n.fx = (ev.clientX - rect.left - panRef.current.x) / z;
      n.fy = (ev.clientY - rect.top - panRef.current.y) / z;
    };
    const up = () => {
      sim.alphaTarget(0);
      n.fx = null;
      n.fy = null;
      setDragging(null);
      suppressClickRef.current = moved;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Grab the empty canvas to slide the whole map around. Node drags stop propagation, so this
   * only ever starts on background (or a link line), never while moving a node. */
  function startPan(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const origin = panRef.current;
    const start = { x: e.clientX, y: e.clientY };
    setPanning(true);
    const move = (ev: PointerEvent) => {
      const next = { x: origin.x + ev.clientX - start.x, y: origin.y + ev.clientY - start.y };
      panRef.current = next;
      setPan(next);
    };
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  return (
    <div className={`mem-graph ${fill ? "fill" : ""}`}>
      <div className={`mem-graph-canvas ${panning ? "panning" : ""}`} ref={hostRef} style={fill ? undefined : { height: size.h }}>
        <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${size.w} ${size.h}`} onPointerDown={startPan}>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`} className={showLabels ? "mem-labels-visible" : undefined}>
            {linksRef.current.map((l, i) => (
              <line key={i} className="mem-link" x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} />
            ))}
            {nodesRef.current.map((n) => {
              const isLink = n.kind === "course" && onNodeClick != null;
              const focusable = isLink || fill;
              const description = n.detail && !n.detail.startsWith(n.label) ? `${n.label}\n${n.detail}` : n.detail ?? n.label;
              const label = !fill && n.label.length > 32 ? `${n.label.slice(0, 31).trimEnd()}…` : n.label;
              return (
                <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}
                  className={`mem-node ${n.kind} ${dragging === n.id ? "dragging" : ""}`}
                  tabIndex={focusable ? 0 : undefined}
                  role={isLink ? "link" : focusable ? "img" : undefined}
                  aria-label={isLink ? n.label : focusable ? description : undefined}
                  onPointerDown={(e) => startDrag(n, e)}
                  onKeyDown={isLink ? (e) => { if (e.key === "Enter") onNodeClick(n); } : undefined}
                  onClick={() => {
                    if (!suppressClickRef.current && isLink) onNodeClick(n);
                    suppressClickRef.current = false;
                  }}>
                  <title>{description}</title>
                  <circle r={STYLE[n.kind].r} fill={STYLE[n.kind].fill} />
                  <text textAnchor="middle" y={STYLE[n.kind].r + 16}>{label}</text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="mem-graph-zoom">
          <button className="btn sm ghost" title="Отдалить" aria-label="Отдалить" onClick={() => zoomBy(1 / 1.25)}><Icon name="minus" /></button>
          <span className="small muted" title="Масштаб">{Math.round(zoom * 100)}%</span>
          <button className="btn sm ghost" title="Приблизить" aria-label="Приблизить" onClick={() => zoomBy(1.25)}><Icon name="plus" /></button>
          <button className="btn sm ghost" title="Сбросить вид" aria-label="Сбросить вид" onClick={resetView}><Icon name="refresh" /></button>
        </div>
      </div>
      <div className="mem-graph-legend">
        {LEGEND.map((l) => (
          <span key={l.kind}><span className="dot" style={{ background: STYLE[l.kind].fill }} />{l.label}</span>
        ))}
      </div>
    </div>
  );
}
