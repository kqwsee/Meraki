import dagre from "@dagrejs/dagre";
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
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
  pinned?: boolean;
};

type Data = GNode & { isNext: boolean; showStatus: boolean; editable: boolean };

function TopicNode({ data }: NodeProps) {
  const d = data as unknown as Data;
  const cls = [
    "gnode",
    d.showStatus ? (d.completed ? "completed" : d.unlocked ? "available" : "locked") : "available",
    d.isNext ? "next" : "",
    d.personal ? "bridge" : "",
    d.editable ? "editable" : "",
  ].join(" ");
  const mode = d.mode && MODE_LABELS[d.mode];
  return (
    <div className={cls} title={d.summary}>
      <Handle type="target" position={Position.Top} className="ghandle" isConnectable={d.editable} />
      {d.pinned && <span className="pin" title="Закреплена автором на своём месте в маршруте">📌</span>}
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
      <Handle type="source" position={Position.Bottom} className="ghandle" isConnectable={d.editable} />
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
  height = 600,
  editable = false,
  onConnect,
  onEdgeClick,
}: {
  nodes: GNode[];
  edges: { source: number; target: number }[];
  nextId?: number | null;
  showStatus?: boolean;
  onSelect?: (n: GNode) => void;
  height?: number;
  /** Author mode: drag from a topic's bottom dot to another topic to add a prerequisite. */
  editable?: boolean;
  onConnect?: (source: number, target: number) => void;
  onEdgeClick?: (source: number, target: number) => void;
}) {
  const { rfNodes, rfEdges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 64 });
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
          id: `h${n.id}`, source: String(n.id), target: String(ordered[i + 1].id), selectable: false,
          style: { strokeDasharray: "6 4", stroke: "#a79bd0" }, animated: true,
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
        data: { ...n, isNext: n.id === nextId, showStatus, editable } as unknown as Record<string, unknown>,
      };
    });
    const rfEdges: Edge[] = [
      ...edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: String(e.source),
        target: String(e.target),
        className: editable ? "gedge-editable" : undefined,
        interactionWidth: editable ? 18 : 0,
        markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(107, 173, 165, 0.7)", width: 16, height: 16 },
        style: { stroke: "rgba(107, 173, 165, 0.55)", strokeWidth: 1.5 },
      })),
      ...hints,
    ];
    return { rfNodes, rfEdges };
  }, [nodes, edges, nextId, showStatus, editable]);

  return (
    <div className={`graph-box ${editable ? "editing" : ""}`} style={{ height }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1.05, minZoom: 0.6 }}
        minZoom={0.25}
        panOnScroll
        nodesDraggable={false}
        nodesConnectable={editable}
        elementsSelectable={editable}
        connectionLineStyle={{ stroke: "#5ceac9", strokeWidth: 2 }}
        connectionRadius={40}
        onConnect={(c: Connection) => c.source && c.target && onConnect?.(Number(c.source), Number(c.target))}
        onEdgeClick={(_, e) => !e.id.startsWith("h") && onEdgeClick?.(Number(e.source), Number(e.target))}
        onNodeClick={(_, n) => onSelect?.(nodes.find((x) => String(x.id) === n.id)!)}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} color="rgba(255, 255, 255, 0.07)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
