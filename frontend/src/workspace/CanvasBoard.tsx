import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { tracker } from "../telemetry/tracker";
import { seedBags, setDirtyListener, snapshotInstances, type ToolInstance } from "../tools/instance";
import { setCanvasApi, setViewport } from "./viewport";

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

type Props = {
  nodeId: number;
  stage: "practice" | "exam";
  onScene: (els: readonly El[]) => void;
  /** Tool widgets living on this canvas; persisted next to the scene elements. */
  instances: readonly ToolInstance[];
  onLoaded: (instances: ToolInstance[]) => void;
};

function CanvasBoard({ nodeId, stage, onScene, instances, onLoaded }: Props) {
  const [initial, setInitial] = useState<any>(undefined);
  const [loaded, setLoaded] = useState(false);
  const elsRef = useRef<readonly El[]>([]);
  const instancesRef = useRef<readonly ToolInstance[]>(instances);
  instancesRef.current = instances;
  const hydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const logTimer = useRef<number | null>(null);
  const lastCount = useRef<{ live: number; ids: Set<string> }>({ live: 0, ids: new Set() });
  const lastJson = useRef("");

  /** Single debounced save for both the drawing and the tool widgets on it. */
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.put(`/nodes/${nodeId}/canvas/${stage}`, {
        scene: {
          elements: elsRef.current.filter((e) => !e.isDeleted),
          toolInstances: snapshotInstances(instancesRef.current),
        },
      }).catch(() => undefined);
    }, 1500);
  }, [nodeId, stage]);

  // widgets write into their state bags outside React, so they schedule the save through this hook
  useEffect(() => {
    setDirtyListener(scheduleSave);
    return () => setDirtyListener(null);
  }, [scheduleSave]);

  useEffect(() => {
    setCanvasApi(null);
    hydrated.current = false;
    api.get<{ scene: any }>(`/nodes/${nodeId}/canvas/${stage}`).then((r) => {
      const els: readonly El[] = r.scene?.elements ?? [];
      const insts: ToolInstance[] = Array.isArray(r.scene?.toolInstances) ? r.scene.toolInstances : [];
      seedBags(insts);
      elsRef.current = els;
      setInitial({ elements: els, appState: { viewBackgroundColor: "#ffffff" }, scrollToContent: true });
      lastCount.current = { live: els.length, ids: new Set(els.map((e) => e.id)) };
      onScene(els);
      onLoaded(insts);
      setLoaded(true);
    });
    return () => setCanvasApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, stage]);

  // geometry changes (create / move / resize / close) are saved through the same debounce
  useEffect(() => {
    if (!loaded) return;
    if (!hydrated.current) {
      hydrated.current = true; // the list restored from the scene is not a change worth saving back
      return;
    }
    scheduleSave();
  }, [instances, loaded, scheduleSave]);

  useEffect(() => () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); }, []);

  const onChange = useCallback((elements: readonly El[]) => {
    const json = JSON.stringify(elements.map((e: any) => [e.id, e.version]));
    if (json === lastJson.current) return;
    lastJson.current = json;
    elsRef.current = elements;
    onScene(elements);
    scheduleSave();
    if (logTimer.current) window.clearTimeout(logTimer.current);
    logTimer.current = window.setTimeout(() => {
      const live = elements.filter((e) => !e.isDeleted);
      const ids = new Set(live.map((e) => e.id));
      const added = [...ids].filter((id) => !lastCount.current.ids.has(id)).length;
      const removed = [...lastCount.current.ids].filter((id) => !ids.has(id)).length;
      const types: Record<string, number> = {};
      live.forEach((e) => (types[e.type] = (types[e.type] ?? 0) + 1));
      tracker.log("canvas_change", `canvas:${stage}`, { added, removed, total: live.length, types, widgets: instancesRef.current.length });
      lastCount.current = { live: live.length, ids };
    }, 3000);
  }, [onScene, scheduleSave, stage]);

  const onApi = useCallback((instance: any) => {
    setCanvasApi(instance);
    const appState = instance?.getAppState?.();
    if (appState?.zoom) setViewport({ scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value ?? 1 });
  }, []);

  // pan/zoom does not fire onChange in Excalidraw 0.18, hence the dedicated callback
  const onScroll = useCallback((scrollX: number, scrollY: number, zoom: { value: number }) => {
    setViewport({ scrollX, scrollY, zoom: zoom?.value ?? 1 });
  }, []);

  if (!loaded) return <div className="loading-block"><span className="spinner" /></div>;
  return (
    <div className="canvas-host" data-copy-source="workspace">
      <Excalidraw initialData={initial} onChange={(els) => onChange(els as unknown as readonly El[])} langCode="ru-RU"
        excalidrawAPI={onApi} onScrollChange={onScroll}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } }} />
    </div>
  );
}

export default memo(CanvasBoard);
