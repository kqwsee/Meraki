/**
 * Tool widgets floating over the Excalidraw canvas.
 *
 * Each widget is a DOM overlay anchored to a scene coordinate: it looks and behaves like a panel
 * (inputs stay crisp and interactive), but pans and zooms with the drawing. Positions are applied
 * imperatively from the shared viewport (`./viewport`) so panning never re-renders React.
 *
 * The layer sits at z-index 3: above Excalidraw's drawing canvases (canvas:1, interactiveCanvas:2)
 * and below its toolbar/menu (layerUI:4) — see the zIndex tokens in @excalidraw/excalidraw's CSS.
 * It is `pointer-events: none` so gestures pass through to the canvas; only the frames are clickable.
 */
import { Suspense, useCallback, useEffect, useRef } from "react";
import { useToolCatalog } from "../tools/catalog";
import { ToolInstanceProvider, type ToolInstance } from "../tools/instance";
import { registerViewportSync, viewport } from "./viewport";

type Props = {
  instances: readonly ToolInstance[];
  courseId: number;
  nodeId: number;
  onUpdate: (id: string, patch: Partial<ToolInstance>) => void;
  onClose: (id: string) => void;
  onFocus: (id: string) => void;
};

const MIN_W = 220;
const MAX_W = 720;

export default function CanvasWidgets({ instances, courseId, nodeId, onUpdate, onClose, onFocus }: Props) {
  const catalog = useToolCatalog();
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const listRef = useRef(instances);
  listRef.current = instances;
  const dragRef = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; origX: number; origY: number; origW: number; x: number; y: number; w: number } | null>(null);

  /** Rewrites every widget transform from the current viewport. No React state involved. */
  const apply = useCallback(() => {
    const zoom = viewport.zoom || 1;
    for (const inst of listRef.current) {
      const el = nodes.current.get(inst.id);
      if (!el) continue;
      const next = `translate3d(${(inst.x + viewport.scrollX) * zoom}px, ${(inst.y + viewport.scrollY) * zoom}px, 0)`;
      if (el.style.transform !== next) el.style.transform = next;
    }
  }, []);

  useEffect(() => {
    registerViewportSync(apply);
    return () => registerViewportSync(null);
  }, [apply]);

  useEffect(() => {
    apply();
  }, [apply, instances]);

  function startDrag(e: React.PointerEvent, inst: ToolInstance, mode: "move" | "resize") {
    if (e.button !== 0) return;
    // pointer capture retargets the following click to the captured element, which would swallow the
    // title-bar buttons — let those handle their own clicks
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* the pointer may already be gone (or synthetic) — dragging still works via the element handler */
    }
    dragRef.current = {
      id: inst.id, mode, startX: e.clientX, startY: e.clientY,
      origX: inst.x, origY: inst.y, origW: inst.w, x: inst.x, y: inst.y, w: inst.w,
    };
    onFocus(inst.id);
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const el = nodes.current.get(d.id);
    const zoom = viewport.zoom || 1;
    if (d.mode === "move") {
      d.x = d.origX + (e.clientX - d.startX) / zoom;
      d.y = d.origY + (e.clientY - d.startY) / zoom;
      if (el) el.style.transform = `translate3d(${(d.x + viewport.scrollX) * zoom}px, ${(d.y + viewport.scrollY) * zoom}px, 0)`;
    } else {
      d.w = Math.min(MAX_W, Math.max(MIN_W, d.origW + (e.clientX - d.startX)));
      if (el) el.style.width = `${d.w}px`;
    }
  }

  function endDrag() {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.mode === "move") {
      if (Math.round(d.x) !== d.origX || Math.round(d.y) !== d.origY) onUpdate(d.id, { x: Math.round(d.x), y: Math.round(d.y) });
    } else if (Math.round(d.w) !== d.origW) {
      onUpdate(d.id, { w: Math.round(d.w) });
    }
  }

  return (
    <div className="cw-layer">
      {instances.map((inst) => {
        const def = catalog.byId[inst.toolId];
        const Tool = def?.component;
        return (
          <div
            key={inst.id}
            className={`cw-frame ${inst.collapsed ? "collapsed" : ""}`}
            data-tool={inst.toolId}
            style={{ width: inst.w, zIndex: inst.z }}
            ref={(el) => {
              if (el) nodes.current.set(inst.id, el);
              else nodes.current.delete(inst.id);
            }}
            onPointerDownCapture={() => onFocus(inst.id)}
          >
            <div
              className="cw-head"
              title={def ? "Перетащить по холсту" : undefined}
              onPointerDown={(e) => startDrag(e, inst, "move")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span className="cw-ico">{def?.icon ?? "❓"}</span>
              <span className="cw-name">{def?.name ?? `Инструмент «${inst.toolId}» недоступен`}</span>
              <button className="cw-btn" title={inst.collapsed ? "Развернуть" : "Свернуть"}
                onClick={() => onUpdate(inst.id, { collapsed: !inst.collapsed })}>
                {inst.collapsed ? "▸" : "▾"}
              </button>
              <button className="cw-btn" title="Убрать с холста" onClick={() => onClose(inst.id)}>✕</button>
            </div>
            {!inst.collapsed && (
              <div className="cw-body">
                {Tool ? (
                  <Suspense fallback={<span className="spinner" />}>
                    <ToolInstanceProvider id={inst.id}>
                      <Tool courseId={courseId} nodeId={nodeId} />
                    </ToolInstanceProvider>
                  </Suspense>
                ) : (
                  <span className="small muted">Инструмент больше не входит в набор — данные сохранены.</span>
                )}
              </div>
            )}
            {!inst.collapsed && (
              <span
                className="cw-grip"
                title="Изменить ширину"
                onPointerDown={(e) => startDrag(e, inst, "resize")}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
