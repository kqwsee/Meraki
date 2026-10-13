import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { tracker } from "../telemetry/tracker";
import ToolDock from "../tools/ToolDock";
import CanvasBoard, { describeScene } from "./CanvasBoard";
import CodeEditor from "./CodeEditor";
import { WsContext, type WsApi } from "./context";
import FileTree from "./FileTree";
import { formatSql, languageOf, runJavaScript, runPython, runSql, type OutKind } from "./runners";

const CANVAS = "__canvas__";

type Props = {
  courseId: number;
  nodeId: number;
  stage: "practice" | "exam";
  tools: string[];
  domain: string;
  taskPanel: ReactNode;
  helper?: ReactNode;
};

export default function Workspace({ courseId, nodeId, stage, tools, domain, taskPanel, helper }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [tabs, setTabs] = useState<string[]>([CANVAS]);
  const [active, setActive] = useState<string>(CANVAS);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState<{ kind: OutKind; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [stdin, setStdin] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [leftTab, setLeftTab] = useState<"tasks" | "helper">("tasks");
  const sceneRef = useRef<readonly any[]>([]);
  const saveTimers = useRef<Record<string, number>>({});

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
    if (active === CANVAS) return;
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
    canvasSummary: () => (sceneRef.current.length ? describeScene(sceneRef.current) : ""),
    showCanvas: () => setActive(CANVAS),
  };

  const lang = active !== CANVAS ? languageOf(active) : null;

  return (
    <WsContext.Provider value={ws}>
      <div className={`ws ${showTools ? "show-tools" : ""}`}>
        <aside className="ws-left">
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
              <div className="ws-scroll" style={{ flex: 3 }}>{taskPanel}</div>
              <div className="ws-section" style={{ borderTop: "1px solid var(--border)", flex: 2, overflowY: "auto", minHeight: 120 }}>
                <div className="ws-section-title">🗂 Пространство</div>
                <FileTree courseId={courseId} files={files} active={active === CANVAS ? null : active} onOpen={openFile} onChanged={refreshFiles} />
              </div>
            </>
          )}
        </aside>

        <section className="ws-center">
          <div className="ws-tabs">
            {tabs.map((t) => (
              <button key={t} className={`ws-tab ${active === t ? "active" : ""}`} onClick={() => setActive(t)}>
                {t === CANVAS ? "🖌 Холст" : `${t.split("/").pop()}${dirty[t] ? " •" : ""}`}
                {t !== CANVAS && (
                  <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(t); }}>✕</span>
                )}
              </button>
            ))}
            <span className="spacer" />
            <button className="ws-tab" onClick={() => setShowTools((s) => !s)} title="Инструменты">🧰</button>
          </div>
          {active !== CANVAS && (
            <div className="ws-editor-bar">
              <span className="muted">{active}</span>
              <span className="spacer" />
              {lang === "python" && (
                <input style={{ width: 180, height: 28, padding: "2px 8px", fontSize: 12 }} placeholder="stdin для input()" value={stdin} onChange={(e) => setStdin(e.target.value)} />
              )}
              {lang && (
                <button className="btn sm primary" onClick={runActive} disabled={running}>
                  {running ? <span className="spinner" /> : "▶ Запустить"}
                </button>
              )}
              <button className="btn sm ghost" onClick={() => setShowOutput((s) => !s)}>Вывод</button>
            </div>
          )}
          <div className="ws-editor">
            {/* keep the canvas mounted so the scene and its telemetry survive tab switches */}
            <div style={{ position: "absolute", inset: 0, visibility: active === CANVAS ? "visible" : "hidden" }}>
              <CanvasBoard nodeId={nodeId} stage={stage} onScene={(els) => (sceneRef.current = els)} />
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

        <aside className="ws-right">
          <ToolDock tools={tools} domain={domain} courseId={courseId} nodeId={nodeId} />
        </aside>
      </div>
    </WsContext.Provider>
  );
}
