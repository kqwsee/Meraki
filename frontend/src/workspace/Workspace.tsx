import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { tracker } from "../telemetry/tracker";
import { describeInstanceState, dropBag, MAX_INSTANCES, newInstance, type ToolInstance } from "../tools/instance";
import { ToolCatalogProvider, useToolCatalog } from "../tools/catalog";
import type { CustomToolDto } from "../tools/custom";
import ToolDock from "../tools/ToolDock";
import CanvasBoard, { describeScene } from "./CanvasBoard";
import CanvasWidgets from "./CanvasWidgets";
import CodeEditor from "./CodeEditor";
import { WsContext, type WsApi } from "./context";
import FileTree from "./FileTree";
import { formatSql, languageOf, runJavaScript, runPython, runSql, type OutKind } from "./runners";
import { clientToScene, viewport } from "./viewport";

const CANVAS = "__canvas__";

type Props = {
  courseId: number;
  nodeId: number;
  stage: "practice" | "exam";
  tools: string[];
  domain: string;
  taskPanel: ReactNode;
  helper?: ReactNode;
  /** Exam start and limit: the countdown lives in the task panel, so the bar repeats it when that panel is hidden. */
  deadline?: string;
  timeLimitMin?: number;
  /** Set when the active task wants the learner to reason before running code — disables "Запустить" and the code-running tools. */
  lockReason?: string | null;
  /** The course author's own tools. */
  customTools?: CustomToolDto[];
};

type Panes = { tasks: boolean; canvas: boolean; tools: boolean };
const PANES_KEY = "meraki_panes";

/** Narrow screens start with the tool dock closed so it doesn't cover the canvas. */
function initialPanes(): Panes {
  const narrow = typeof window !== "undefined" && window.innerWidth <= 1100;
  const fallback: Panes = { tasks: true, canvas: true, tools: !narrow };
  try {
    const raw = localStorage.getItem(PANES_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Panes>) } : fallback;
  } catch {
    return fallback;
  }
}

const FOCUS_KEY = "meraki_ws_focus";
const FILES_KEY = "meraki_ws_files_open";

/** Full-screen workspace: hides the site header and the topic header, remembered between visits. */
function useFocusMode() {
  const [focus, setFocus] = useState(() => {
    try {
      return localStorage.getItem(FOCUS_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("ws-focus", focus);
    try {
      localStorage.setItem(FOCUS_KEY, focus ? "1" : "0");
    } catch {
      /* storage may be unavailable */
    }
    return () => document.documentElement.classList.remove("ws-focus");
  }, [focus]);
  return [focus, setFocus] as const;
}

const WIDTHS_KEY = "meraki_ws_widths";
type Widths = { left: number; right: number };

/** Column widths set by dragging the borders, remembered between visits. */
function useColumnWidths() {
  const [widths, setWidths] = useState<Widths>(() => {
    const clamp = (v: unknown, d: number) => (typeof v === "number" && v >= 220 && v <= 2000 ? v : d);
    try {
      const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as Partial<Widths>;
      return { left: clamp(saved.left, 320), right: clamp(saved.right, 330) };
    } catch {
      return { left: 320, right: 330 };
    }
  });
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);

  function startDrag(side: "left" | "right", e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = widths[side];
    // the canvas keeps at least 320px, a side panel stays between 220px and 60% of the window
    const max = Math.max(260, Math.min(window.innerWidth * 0.6, window.innerWidth - widths[side === "left" ? "right" : "left"] - 320));
    let latest = widths;
    setDragging(side);
    document.documentElement.classList.add("ws-resizing");
    const move = (ev: PointerEvent) => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      latest = { ...latest, [side]: Math.round(Math.min(max, Math.max(220, start + delta))) };
      setWidths(latest);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.documentElement.classList.remove("ws-resizing");
      setDragging(null);
      try {
        localStorage.setItem(WIDTHS_KEY, JSON.stringify(latest));
      } catch {
        /* storage may be unavailable */
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function reset(side: "left" | "right") {
    const next = { ...widths, [side]: side === "left" ? 320 : 330 };
    setWidths(next);
    try {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable */
    }
  }

  return { widths, dragging, startDrag, reset };
}

function mmss(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export default function Workspace(props: Props) {
  return (
    <ToolCatalogProvider custom={props.customTools ?? []}>
      <WorkspaceBody {...props} />
    </ToolCatalogProvider>
  );
}

function WorkspaceBody({ courseId, nodeId, stage, tools, domain, taskPanel, helper, deadline, timeLimitMin, lockReason }: Props) {
  const catalog = useToolCatalog();
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const [focus, setFocus] = useFocusMode();
  const cols = useColumnWidths();
  const [filesOpen, setFilesOpen] = useState(() => {
    try {
      return localStorage.getItem(FILES_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [files, setFiles] = useState<string[]>([]);
  const [tabs, setTabs] = useState<string[]>([CANVAS]);
  const [active, setActive] = useState<string>(CANVAS);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState<{ kind: OutKind; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [stdin, setStdin] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [panes, setPanes] = useState<Panes>(initialPanes);
  const [clock, setClock] = useState(() => Date.now());
  const [leftTab, setLeftTab] = useState<"tasks" | "helper">("tasks");
  const [instances, setInstances] = useState<ToolInstance[]>([]);
  const sceneRef = useRef<readonly any[]>([]);
  const saveTimers = useRef<Record<string, number>>({});
  const editorRef = useRef<HTMLDivElement | null>(null);
  const zTop = useRef(1);
  const instancesRef = useRef<ToolInstance[]>([]);
  instancesRef.current = instances;

  // stable identities: CanvasBoard is memoised and Excalidraw re-renders on every prop change
  const onScene = useCallback((els: readonly any[]) => {
    sceneRef.current = els;
  }, []);
  const onLoaded = useCallback((list: ToolInstance[]) => {
    setInstances(list);
    zTop.current = list.reduce((max, i) => Math.max(max, i.z), 1);
  }, []);

  const addInstance = useCallback((toolId: string, x: number, y: number) => {
    if (catalogRef.current.byId[toolId] === undefined) return;
    if (instancesRef.current.length >= MAX_INSTANCES) {
      console.warn(`на холсте уже ${MAX_INSTANCES} инструментов — больше не помещаю`);
      return;
    }
    zTop.current += 1;
    const inst = newInstance(toolId, x, y, zTop.current);
    setInstances((l) => (l.length >= MAX_INSTANCES ? l : [...l, inst]));
    tracker.log("tool_open", toolId, { via: "canvas" });
  }, []);

  // a new topic or stage starts with its own canvas: don't show the previous set of widgets over it
  useEffect(() => {
    setInstances([]);
  }, [nodeId, stage]);

  const updateInstance = useCallback((id: string, patch: Partial<ToolInstance>) => {
    setInstances((l) => l.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const removeInstance = useCallback((id: string) => {
    dropBag(id);
    setInstances((l) => l.filter((i) => i.id !== id));
  }, []);

  const focusInstance = useCallback((id: string) => {
    setInstances((l) => {
      const top = l.reduce((max, i) => Math.max(max, i.z), 0);
      const cur = l.find((i) => i.id === id);
      if (!cur || cur.z === top) return l; // already on top — don't re-render on every click
      zTop.current = top + 1;
      return l.map((i) => (i.id === id ? { ...i, z: zTop.current } : i));
    });
  }, []);

  /** Drops a tool at a point in client coordinates (drag from the dock, or the “＋” button). */
  const placeTool = useCallback(
    (toolId: string, clientX: number, clientY: number, grabX = 0, grabY = 0) => {
      const point = clientToScene(clientX, clientY);
      if (!point) return;
      const zoom = viewport.zoom || 1;
      addInstance(toolId, point.x - grabX / zoom, point.y - grabY / zoom);
    },
    [addInstance],
  );

  const panesRef = useRef(panes);
  panesRef.current = panes;

  useEffect(() => {
    try {
      localStorage.setItem(PANES_KEY, JSON.stringify(panes));
    } catch {
      /* private mode — layout just won't be remembered */
    }
  }, [panes]);

  /** Panels are independent: hiding the canvas hands its width to the tasks, hiding everything shows the bar alone. */
  const togglePane = useCallback((key: keyof Panes) => {
    setPanes((p) => ({ ...p, [key]: !p[key] }));
  }, []);

  const toggleFiles = useCallback(() => {
    setFilesOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(FILES_KEY, next ? "1" : "0");
      } catch {
        /* private mode — not remembered */
      }
      return next;
    });
  }, []);

  const showCanvasPane = useCallback(() => {
    setActive(CANVAS);
    setPanes((p) => (p.canvas ? p : { ...p, canvas: true }));
  }, []);

  const addAtCenter = useCallback(
    (toolId: string) => {
      const place = () => {
        const rect = editorRef.current?.getBoundingClientRect();
        if (!rect || rect.width < 40) return; // canvas still collapsed — nothing sensible to measure
        const step = (instancesRef.current.length % 6) * 28; // cascade, so widgets don't land exactly on each other
        placeTool(toolId, rect.left + rect.width / 2 - 60 + step, rect.top + 80 + step);
      };
      if (!panesRef.current.canvas) {
        setPanes((p) => ({ ...p, canvas: true }));
        requestAnimationFrame(place); // wait for the pane to be laid out before measuring it
      } else {
        place();
      }
    },
    [placeTool],
  );

  // the exam countdown sits inside the task panel, so keep ticking while that panel is hidden
  useEffect(() => {
    if (panes.tasks || !deadline) return;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [panes.tasks, deadline]);
  const examLeft = deadline ? new Date(deadline).getTime() + (timeLimitMin ?? 0) * 60000 - clock : null;

  const refreshFiles = useCallback(async () => {
    const list = await api.get<{ path: string }[]>(`/courses/${courseId}/files`);
    setFiles(list.map((f) => f.path));
  }, [courseId]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const readFile = useCallback(
    async (path: string) => {
      if (contents[path] !== undefined) return contents[path];
      const f = await api.get<{ content: string }>(`/courses/${courseId}/file?path=${encodeURIComponent(path)}`);
      setContents((c) => ({ ...c, [path]: f.content }));
      return f.content;
    },
    [contents, courseId],
  );

  const writeFile = useCallback(
    async (path: string, content: string) => {
      setContents((c) => ({ ...c, [path]: content }));
      await api.put(`/courses/${courseId}/file`, { path, content });
      if (!files.includes(path)) await refreshFiles();
    },
    [courseId, files, refreshFiles],
  );

  const openFile = useCallback(
    async (path: string) => {
      await readFile(path).catch(() => undefined);
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setActive(path);
      tracker.log("file_open", path);
    },
    [readFile],
  );

  function edit(path: string, value: string) {
    setContents((c) => ({ ...c, [path]: value }));
    setDirty((d) => ({ ...d, [path]: true }));
    window.clearTimeout(saveTimers.current[path]);
    saveTimers.current[path] = window.setTimeout(async () => {
      await api.put(`/courses/${courseId}/file`, { path, content: value }).catch(() => undefined);
      setDirty((d) => ({ ...d, [path]: false }));
      tracker.log("file_save", path, { chars: value.length });
    }, 1200);
  }

  function closeTab(path: string) {
    setTabs((t) => t.filter((x) => x !== path));
    if (active === path) setActive(CANVAS);
  }

  const print = (kind: OutKind, text: string) => setOutput((o) => [...o, { kind, text }]);

  async function runActive() {
    if (active === CANVAS || lockReason) return;
    const lang = languageOf(active);
    if (!lang) return;
    setRunning(true);
    setShowOutput(true);
    setOutput([{ kind: "sys", text: `▶ ${active}\n` }]);
    const started = performance.now();
    let errors = 0;
    const out = (k: OutKind, t: string) => {
      if (k === "err") errors++;
      print(k, t);
    };
    try {
      if (lang === "python") {
        const all: Record<string, string> = {};
        for (const p of files.filter((f) => f.endsWith(".py") || f.endsWith(".txt") || f.endsWith(".csv") || f.endsWith(".json"))) {
          all[p] = contents[p] ?? (await readFile(p));
        }
        all[active] = contents[active] ?? "";
        await runPython({ files: all, entry: active, stdin }, out);
      } else if (lang === "javascript") {
        await runJavaScript(contents[active] ?? "", out);
      } else {
        try {
          out("out", formatSql(await runSql(contents[active] ?? "")));
        } catch (e: any) {
          out("err", String(e.message ?? e) + "\n");
        }
      }
    } finally {
      const ms = Math.round(performance.now() - started);
      print("sys", `\n■ готово за ${ms} мс\n`);
      tracker.log("code_run", active, { language: lang, ok: errors === 0, ms, chars: (contents[active] ?? "").length });
      setRunning(false);
    }
  }

  const ws: WsApi = {
    courseId, nodeId, stage, files, activePath: active === CANVAS ? null : active,
    openFile, readFile, writeFile, refreshFiles,
    canvasSummary: () => {
      const parts: string[] = [];
      if (sceneRef.current.length) parts.push(describeScene(sceneRef.current));
      if (instancesRef.current.length) {
        parts.push(
          "Инструменты на холсте:\n" +
            instancesRef.current
              .map((i) => `- ${describeInstanceState(i, catalogRef.current.byId[i.toolId]?.name ?? i.toolId)}`)
              .join("\n"),
        );
      }
      return parts.join("\n");
    },
    showCanvas: showCanvasPane,
    lockReason: lockReason ?? null,
  };

  const lang = active !== CANVAS ? languageOf(active) : null;

  return (
    <WsContext.Provider value={ws}>
      <div className="ws">
        <div className="ws-bar">
          <button className={`ws-bar-btn ${panes.tasks ? "on" : ""}`} aria-pressed={panes.tasks} onClick={() => togglePane("tasks")}
            title={panes.tasks ? "Скрыть панель заданий" : "Показать панель заданий (задания, помощник, файлы)"}>
            ☰ Задания
          </button>
          <button className={`ws-bar-btn ${panes.canvas ? "on" : ""}`} aria-pressed={panes.canvas} onClick={() => togglePane("canvas")}
            title={panes.canvas ? "Скрыть холст — задания займут весь экран" : "Показать холст"}>
            🖌 Холст
          </button>
          <button className={`ws-bar-btn ${panes.tools ? "on" : ""}`} aria-pressed={panes.tools} onClick={() => togglePane("tools")}
            title={panes.tools ? "Скрыть инструменты" : "Показать инструменты"}>
            🧰 Инструменты
          </button>
          <span className="spacer" />
          {examLeft !== null && (!panes.tasks || focus) && (
            <span className={`exam-timer ${examLeft < 5 * 60000 ? "low" : ""}`} title="Время до конца экзамена">{mmss(examLeft)}</span>
          )}
          {!panes.tasks && !panes.canvas && !panes.tools && (
            <span className="small muted">Все панели скрыты — включите нужную выше</span>
          )}
          <button className={`ws-bar-btn ${focus ? "on" : ""}`} aria-pressed={focus} onClick={() => setFocus(!focus)}
            title={focus ? "Вернуть верхние панели сайта и темы" : "Свернуть верхние панели: больше места для холста"}>
            {focus ? "⤓ Показать шапку" : "⤒ Свернуть шапку"}
          </button>
        </div>

        <div className={`ws-cols ${panes.canvas ? "" : "no-canvas"} ${panes.tasks ? "" : "no-tasks"} ${panes.tools ? "" : "no-tools"}`}
          style={{ "--ws-left": `${cols.widths.left}px`, "--ws-right": `${cols.widths.right}px` } as CSSProperties}>
          <aside className={`ws-left ${panes.tasks ? "" : "pane-hidden"}`}>
            {helper && (
              <div className="tabs" style={{ padding: "0 8px" }}>
                <button className={leftTab === "tasks" ? "active" : ""} onClick={() => setLeftTab("tasks")}>Задания</button>
                <button className={leftTab === "helper" ? "active" : ""} onClick={() => setLeftTab("helper")}>Помощник</button>
              </div>
            )}
            {leftTab === "helper" && helper ? (
              <div style={{ flex: 1, minHeight: 0 }}>{helper}</div>
            ) : (
              <>
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{taskPanel}</div>
                <div className="ws-filetree" style={{ borderTop: "1px solid var(--border)" }}>
                  <button className="ws-filetree-head" onClick={toggleFiles} aria-expanded={filesOpen}>
                    <span className={`chev ${filesOpen ? "open" : ""}`}>▸</span>
                    <span className="ws-section-title" style={{ margin: 0 }}>🗂 Пространство</span>
                    <span className="small muted">{files.length}</span>
                  </button>
                  {filesOpen && (
                    <div className="ws-filetree-body">
                      <FileTree courseId={courseId} files={files} active={active === CANVAS ? null : active} onOpen={openFile} onChanged={refreshFiles} />
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>

          {panes.tasks && panes.canvas && (
            <div className={`ws-split left ${cols.dragging === "left" ? "dragging" : ""}`} onPointerDown={(e) => cols.startDrag("left", e)}
              onDoubleClick={() => cols.reset("left")} title="Потяни, чтобы изменить ширину. Двойной клик — исходная ширина" />
          )}

          <section className={`ws-center ${panes.canvas ? "" : "pane-hidden"}`}>
            <div className="ws-tabs">
              {tabs.map((t) => (
                <button key={t} className={`ws-tab ${active === t ? "active" : ""}`} onClick={() => setActive(t)}>
                  {t === CANVAS ? "🖌 Холст" : `${t.split("/").pop()}${dirty[t] ? " •" : ""}`}
                  {t !== CANVAS && (
                    <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(t); }}>✕</span>
                  )}
                </button>
              ))}
            </div>
            {active !== CANVAS && (
              <div className="ws-editor-bar">
                <span className="muted">{active}</span>
                <span className="spacer" />
                {lang === "python" && (
                  <input style={{ width: 180, height: 28, padding: "2px 8px", fontSize: 12 }} placeholder="stdin для input()" value={stdin} onChange={(e) => setStdin(e.target.value)} />
                )}
                {lockReason && <span className="lock-note" title={lockReason}>🔒 сначала ответь</span>}
                {lang && (
                  <button className="btn sm primary" onClick={runActive} disabled={running || !!lockReason}
                    title={lockReason ?? undefined}>
                    {running ? <span className="spinner" /> : lockReason ? "🔒 Запустить" : "▶ Запустить"}
                  </button>
                )}
                <button className="btn sm ghost" onClick={() => setShowOutput((s) => !s)}>Вывод</button>
              </div>
            )}
            <div className="ws-editor" ref={editorRef}>
              {/* keep the canvas mounted so the scene and its telemetry survive tab switches */}
              <div style={{ position: "absolute", inset: 0, visibility: active === CANVAS ? "visible" : "hidden" }}>
                {/* key: Excalidraw only reads initialData on mount, so a new topic must rebuild the board */}
                <CanvasBoard key={`${nodeId}:${stage}`} nodeId={nodeId} stage={stage} onScene={onScene} instances={instances} onLoaded={onLoaded} />
                <CanvasWidgets
                  instances={instances} courseId={courseId} nodeId={nodeId}
                  onUpdate={updateInstance} onClose={removeInstance} onFocus={focusInstance}
                />
              </div>
              {active !== CANVAS && (
                <div style={{ position: "absolute", inset: 0 }} data-copy-source="workspace">
                  <CodeEditor key={active} path={active} value={contents[active] ?? ""} onChange={(v) => edit(active, v)} />
                </div>
              )}
            </div>
            {showOutput && active !== CANVAS && (
              <div className="ws-output">
                {output.length ? output.map((o, i) => <span key={i} className={o.kind === "out" ? "" : o.kind}>{o.text}</span>) : <span className="sys">Нажми «Запустить», чтобы выполнить файл в браузере.</span>}
              </div>
            )}
          </section>

          {panes.tools && panes.canvas && (
            <div className={`ws-split right ${cols.dragging === "right" ? "dragging" : ""}`} onPointerDown={(e) => cols.startDrag("right", e)}
              onDoubleClick={() => cols.reset("right")} title="Потяни, чтобы изменить ширину. Двойной клик — исходная ширина" />
          )}

          <aside className={`ws-right ${panes.tools ? "" : "pane-hidden"}`}>
            <ToolDock tools={tools} domain={domain} courseId={courseId} nodeId={nodeId}
              onAddToCanvas={addAtCenter} onDropOnCanvas={placeTool} editorRef={editorRef} />
          </aside>
        </div>
      </div>
    </WsContext.Provider>
  );
}
