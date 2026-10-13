import dagre from "@dagrejs/dagre";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { MODE_LABELS, STAGE_NAMES } from "./ui";

export type GNode = {
  id: number;
  title: string;
  summary: string;
  completed?: boolean;
  unlocked?: boolean;
  stage?: string | null;
  personal?: boolean;
  rank?: number | null;
  mode?: string;
};

type Data = GNode & { isNext: boolean; showStatus: boolean };

function TopicNode({ data }: NodeProps) {
  const d = data as unknown as Data;
  const cls = [
    "gnode",
    d.completed ? "completed" : d.unlocked ? "available" : "locked",
    d.isNext ? "next" : "",
    d.personal ? "bridge" : "",
  ].join(" ");
  const mode = d.mode && MODE_LABELS[d.mode];
  return (
    <div className={cls} title={d.summary}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {d.showStatus && d.rank != null && <span className="rank">#{d.rank + 1}</span>}
      <div className="gtitle">{d.title}</div>
      {d.showStatus && (
        <div className="gmeta">
          {d.completed ? (
            <span className="badge success">✓ пройдено</span>
          ) : d.stage ? (
            <span className="badge accent">{STAGE_NAMES[d.stage] ?? d.stage}</span>
          ) : d.unlocked ? (
            <span className="badge accent">доступно</span>
          ) : (
            <span className="badge">🔒 закрыто</span>
          )}
          {d.isNext && <span className="badge accent">→ дальше</span>}
          {mode && <span className={`badge ${mode.cls}`}>{mode.label}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { topic: TopicNode };

export default function GraphView({
  nodes,
  edges,
  nextId,
  showStatus = true,
  onSelect,
  height = 520,
}: {
  nodes: GNode[];
  edges: { source: number; target: number }[];
  nextId?: number | null;
  showStatus?: boolean;
  onSelect?: (n: GNode) => void;
  height?: number;
}) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 60 });
    g.setDefaultEdgeLabel(() => ({}));
    nodes.forEach((n) => g.setNode(String(n.id), { width: 214, height: showStatus ? 96 : 64 }));
    edges.forEach((e) => g.setEdge(String(e.source), String(e.target)));
    // personal bridge nodes have no hard edges: draw a dashed hint to the next topic in the route
    const hints: Edge[] = [];
    const ordered = [...nodes].filter((n) => n.rank != null).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    ordered.forEach((n, i) => {
      if (n.personal && ordered[i + 1]) {
        g.setEdge(String(n.id), String(ordered[i + 1].id));
        hints.push({
          id: `h${n.id}`, source: String(n.id), target: String(ordered[i + 1].id),
          style: { strokeDasharray: "6 4", stroke: "#9333ea" }, animated: true,
        });
      }
    });
    dagre.layout(g);
    const rfNodes: Node[] = nodes.map((n) => {
      const p = g.node(String(n.id));
      return {
        id: String(n.id),
        type: "topic",
        position: { x: p.x - 107, y: p.y - 40 },
        data: { ...n, isNext: n.id === nextId, showStatus } as unknown as Record<string, unknown>,
      };
    });
    const rfEdges: Edge[] = [
      ...edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: String(e.source),
        target: String(e.target),
        style: { stroke: "#a5b4fc", strokeWidth: 2 },
      })),
      ...hints,
    ];
    return { rfNodes, rfEdges };
  }, [nodes, edges, nextId, showStatus]);

  return (
    <div className="graph-box" style={{ height }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1.1 }}
        minZoom={0.3}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, n) => onSelect?.(nodes.find((x) => String(x.id) === n.id)!)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#e5e7f0" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
