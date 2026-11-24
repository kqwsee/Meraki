import { Icon } from "../components/Icon";
import { Suspense, useMemo, useRef, useState } from "react";
import { tracker } from "../telemetry/tracker";
import { useWorkspace } from "../workspace/context";
import { useToolCatalog } from "./catalog";
import { TOOLS, type ToolDef } from "./registry";

/** Distance that separates a click (expand the card) from a drag (drop a widget on the canvas). */
const DRAG_THRESHOLD = 5;

type Props = {
  tools: string[];
  domain: string;
  courseId: number;
  nodeId: number;
  /** Places a widget in the middle of the visible canvas (no dragging needed). */
  onAddToCanvas: (toolId: string) => void;
  /** Places a widget where it was dropped, keeping the pointer's grip on its title bar. */
  onDropOnCanvas: (toolId: string, clientX: number, clientY: number, grabX: number, grabY: number) => void;
  editorRef: React.RefObject<HTMLDivElement | null>;
};

export default function ToolDock({ tools, domain, courseId, nodeId, onAddToCanvas, onDropOnCanvas, editorRef }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [ghost, setGhost] = useState<{ toolId: string; x: number; y: number } | null>(null);
  const drag = useRef<{ toolId: string; startX: number; startY: number; grabX: number; grabY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const ws = useWorkspace();
  const catalog = useToolCatalog();

  const course = useMemo(() => {
    const ids = tools.length ? tools : TOOLS.filter((t) => t.domains.includes(domain) || t.domains.includes("general")).map((t) => t.id);
    // the author's own tools always come first
    return [...new Set([...catalog.customIds, ...ids, ...extra])].map((id) => catalog.byId[id]).filter(Boolean) as ToolDef[];
  }, [tools, domain, extra, catalog]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog.all.filter((t) => `${t.name} ${t.keywords} ${t.id}`.toLowerCase().includes(q));
  }, [query, catalog]);

  function toggle(t: ToolDef) {
    if (suppressClick.current) {
      suppressClick.current = false; // the pointerup ended a drag, not a click
      return;
    }
    setOpen((o) => {
      const next = !o[t.id];
      if (next) tracker.log("tool_open", t.id);
      return { ...o, [t.id]: next };
    });
  }

  // Dragging uses pointer events rather than HTML5 drag-and-drop: Excalidraw listens for `drop`
  // on its own container and reads `text/plain`, which would race with us. Touch keeps using the
  // “＋” button so that swiping the tool list still scrolls.
  function startDrag(e: React.PointerEvent, t: ToolDef) {
    if (e.button !== 0 || e.pointerType === "touch") return;
    if ((e.target as HTMLElement).closest("button")) return; // “＋” keeps its own click
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone (or synthetic) — the element handlers still receive the moves */
    }
    drag.current = {
      toolId: t.id, startX: e.clientX, startY: e.clientY,
      grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, moved: false,
    };
  }

  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.moved = true;
      suppressClick.current = true;
      ws?.showCanvas(); // make sure the target is in front of the learner
      tracker.log("tool_open", d.toolId, { via: "drag" });
    }
    setGhost({ toolId: d.toolId, x: e.clientX, y: e.clientY });
  }

  function endDrag(e: React.PointerEvent) {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d?.moved) return;
    const box = editorRef.current?.getBoundingClientRect();
    if (!box) return;
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (inside) onDropOnCanvas(d.toolId, e.clientX, e.clientY, d.grabX, d.grabY);
  }

  const head = (t: ToolDef) => (
    <div
      className="tool-head"
      onClick={() => toggle(t)}
      onPointerDown={(e) => startDrag(e, t)}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title="Клик — развернуть здесь, перетаскивание — положить на холст"
    >
      <span className="ico"><Icon name={t.icon} /></span>
      <span style={{ flex: 1 }}>{t.name}</span>
      {t.custom && <span className="badge accent" title="Инструмент от автора курса">автор</span>}
      <button className="icon-btn" title="Положить на холст"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onAddToCanvas(t.id); }}>
        ＋
      </button>
      <span className="muted">{open[t.id] ? "▾" : "▸"}</span>
    </div>
  );

  const card = (t: ToolDef) => (
    <div key={t.id} className="tool-card">
      {head(t)}
      {open[t.id] && (
        <div className="tool-body">
          <Suspense fallback={<span className="spinner" />}>
            <t.component courseId={courseId} nodeId={nodeId} />
          </Suspense>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="ws-section-title" style={{ padding: "12px 14px 0" }}>Инструменты</div>
      <div className="ws-scroll" style={{ padding: "8px 12px" }}>
        <div className="tool-list">{course.map(card)}</div>
      </div>
      <div className="tool-search">
        {results.length > 0 && (
          <div className="tool-list" style={{ maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
            {results.map((t) => (
              <div key={t.id} className="tool-head" style={{ border: "1px solid var(--border)", borderRadius: 8 }}
                onClick={() => {
                  setExtra((e) => (e.includes(t.id) ? e : [...e, t.id]));
                  setOpen((o) => ({ ...o, [t.id]: true }));
                  tracker.log("tool_open", t.id, { via: "search" });
                  setQuery("");
                }}>
                <span className="ico"><Icon name={t.icon} /></span>
                <span style={{ flex: 1 }}>{t.name}</span>
                {course.some((c) => c.id === t.id) ? <span className="badge">есть</span> : <span className="badge accent">+ добавить</span>}
              </div>
            ))}
          </div>
        )}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти инструмент" aria-label="Найти инструмент" />
      </div>
      {ghost && catalog.byId[ghost.toolId] && (
        <div className="tool-ghost" style={{ left: ghost.x + 12, top: ghost.y + 10 }}>
          <span className="ico"><Icon name={catalog.byId[ghost.toolId].icon} /></span> {catalog.byId[ghost.toolId].name}
        </div>
      )}
    </>
  );
}
