import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { tracker } from "../telemetry/tracker";

type El = {
  id: string; type: string; isDeleted?: boolean; text?: string; containerId?: string | null;
  startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null;
};

/** Plain-text description of the drawing, so the AI can check canvas tasks (schemes, diagrams, graphs). */
export function describeScene(elements: readonly El[]): string {
  const live = elements.filter((e) => !e.isDeleted);
  const labelOf = (id: string) => {
    const t = live.find((e) => e.type === "text" && e.containerId === id) ?? live.find((e) => e.id === id && e.type === "text");
    return t?.text?.trim() || "";
  };
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  for (const e of live) counts[e.type] = (counts[e.type] ?? 0) + 1;
  lines.push("Элементы: " + Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", "));
  for (const e of live) {
    if (["rectangle", "ellipse", "diamond"].includes(e.type)) {
      const l = labelOf(e.id);
      lines.push(`- фигура ${e.type}${l ? ` «${l}»` : ""}`);
    } else if (e.type === "arrow" || e.type === "line") {
      const from = e.startBinding ? labelOf(e.startBinding.elementId) || "фигура" : "?";
      const to = e.endBinding ? labelOf(e.endBinding.elementId) || "фигура" : "?";
      const own = labelOf(e.id);
      lines.push(`- ${e.type === "arrow" ? "стрелка" : "линия"}: ${from} → ${to}${own ? ` (подпись «${own}»)` : ""}`);
    } else if (e.type === "text" && !e.containerId) {
      lines.push(`- текст «${e.text?.trim()}»`);
    }
  }
  return lines.join("\n");
}

export default function CanvasBoard({ nodeId, stage, onScene }: { nodeId: number; stage: string; onScene: (els: readonly El[]) => void }) {
  const [initial, setInitial] = useState<any>(undefined);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const logTimer = useRef<number | null>(null);
  const lastCount = useRef<{ live: number; ids: Set<string> }>({ live: 0, ids: new Set() });
  const lastJson = useRef("");

  useEffect(() => {
    api.get<{ scene: any }>(`/nodes/${nodeId}/canvas/${stage}`).then((r) => {
      const els = r.scene?.elements ?? [];
      setInitial({ elements: els, appState: { viewBackgroundColor: "#ffffff" }, scrollToContent: true });
      lastCount.current = { live: els.length, ids: new Set(els.map((e: El) => e.id)) };
      onScene(els);
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, stage]);

  function onChange(elements: readonly El[]) {
    const json = JSON.stringify(elements.map((e: any) => [e.id, e.version]));
    if (json === lastJson.current) return;
    lastJson.current = json;
    onScene(elements);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.put(`/nodes/${nodeId}/canvas/${stage}`, { scene: { elements: elements.filter((e) => !e.isDeleted) } }).catch(() => undefined);
    }, 1500);
    if (logTimer.current) window.clearTimeout(logTimer.current);
    logTimer.current = window.setTimeout(() => {
      const live = elements.filter((e) => !e.isDeleted);
      const ids = new Set(live.map((e) => e.id));
      const added = [...ids].filter((id) => !lastCount.current.ids.has(id)).length;
      const removed = [...lastCount.current.ids].filter((id) => !ids.has(id)).length;
      const types: Record<string, number> = {};
      live.forEach((e) => (types[e.type] = (types[e.type] ?? 0) + 1));
      tracker.log("canvas_change", `canvas:${stage}`, { added, removed, total: live.length, types });
      lastCount.current = { live: live.length, ids };
    }, 3000);
  }

  if (!loaded) return <div className="loading-block"><span className="spinner" /></div>;
  return (
    <div className="canvas-host" data-copy-source="workspace">
      <Excalidraw initialData={initial} onChange={(els) => onChange(els as unknown as readonly El[])} langCode="ru-RU"
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } }} />
    </div>
  );
}
