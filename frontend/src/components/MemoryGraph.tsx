import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type GraphNodeKind = "course" | "mastered" | "fact" | "strength" | "growth" | "note";
/** `cluster` only drives layout: nodes sharing a cluster key drift toward the same loose "cloud"
 * instead of everything converging on one hub. Leave it unset (or shared by everything) for a
 * single blob; give each course's nodes `course:<id>` and leave unaffiliated ones unset ("_misc")
 * to get separate, lightly-held-apart clouds. */
export type GraphNode = { id: string; label: string; kind: GraphNodeKind; cluster?: string; detail?: string };
export type GraphLink = { source: string; target: string };

type SimNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
type SimLink = { source: SimNode; target: SimNode };

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

/** Force-directed map of everything the mentor remembers about the learner — courses, mastered
 * concepts, memory facts, strengths/growth areas and notes, radiating from a center "you" node.
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

    // each distinct cluster gets its own anchor point, arranged around the canvas, so unrelated
    // knowledge settles into separate "clouds" instead of all drifting to one shared center
    const cx = size.w / 2;
    const cy = size.h / 2;
    const clusterIds = Array.from(new Set(simNodes.map((n) => n.cluster ?? "_misc")));
    const anchor = new Map<string, { x: number; y: number }>();
    if (clusterIds.length <= 1) {
      clusterIds.forEach((k) => anchor.set(k, { x: cx, y: cy }));
    } else {
      const radius = Math.min(size.w, size.h) * 0.34;
      clusterIds.forEach((k, i) => {
        const angle = (2 * Math.PI * i) / clusterIds.length - Math.PI / 2;
        anchor.set(k, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      });
    }
    const anchorOf = (d: SimNode) => anchor.get(d.cluster ?? "_misc") ?? { x: cx, y: cy };

    const sim = forceSimulation(simNodes)
      .force("charge", forceManyBody().strength(-170))
      .force("link", forceLink<SimNode, SimLink>(simLinks).distance((l) => (l.source.kind === "course" || l.target.kind === "course" ? 70 : 56)).strength(0.55))
      .force("center", forceCenter(cx, cy))
      .force("x", forceX<SimNode>((d) => anchorOf(d).x).strength(0.07))
      .force("y", forceY<SimNode>((d) => anchorOf(d).y).strength(0.07))
      .force("collide", forceCollide<SimNode>().radius((d) => STYLE[d.kind].r + 16))
      .on("tick", () => bump((t) => (t + 1) % 1_000_000));
    simRef.current = sim;
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, size.w, size.h]);

  function startDrag(n: SimNode, e: ReactPointerEvent<SVGGElement>) {
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement;
    const sim = simRef.current;
    if (!svg || !sim) return;
    sim.alphaTarget(0.3).restart();
    setDragging(n.id);
    const move = (ev: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      n.fx = ev.clientX - rect.left;
      n.fy = ev.clientY - rect.top;
    };
    const up = () => {
      sim.alphaTarget(0);
      n.fx = null;
      n.fy = null;
      setDragging(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className={`mem-graph ${fill ? "fill" : ""}`}>
      <div className="mem-graph-canvas" ref={hostRef} style={fill ? undefined : { height: size.h }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${size.w} ${size.h}`}>
          <g>
            {linksRef.current.map((l, i) => (
              <line key={i} className="mem-link" x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} />
            ))}
          </g>
          <g>
            {nodesRef.current.map((n) => (
              <g key={n.id} transform={`translate(${n.x ?? 0}, ${n.y ?? 0})`}
                className={`mem-node ${n.kind} ${dragging === n.id ? "dragging" : ""}`}
                onPointerDown={(e) => startDrag(n, e)}
                onClick={() => onNodeClick?.(n)}>
                <title>{n.detail ?? n.label}</title>
                <circle r={STYLE[n.kind].r} fill={STYLE[n.kind].fill} />
                <text x={STYLE[n.kind].r + 5} y={4}>{n.label}</text>
              </g>
            ))}
          </g>
        </svg>
      </div>
      <div className="mem-graph-legend">
        {LEGEND.map((l) => (
          <span key={l.kind}><span className="dot" style={{ background: STYLE[l.kind].fill }} />{l.label}</span>
        ))}
      </div>
    </div>
  );
}
