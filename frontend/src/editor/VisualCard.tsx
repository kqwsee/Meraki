/**
 * One lecture visual in the course editor: the preview exactly as learners will see it, plus review actions —
 * approve, edit by hand, redo with the AI (with the author's remarks or the render error), delete.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import VisualView from "../visuals/VisualView";
import { KIND_META, type VisualDto, type VisualKind } from "../visuals/types";

const HtmlCodeEditor = lazy(() => import("./HtmlCodeEditor"));

/** What a new visual of each kind starts from when the author makes it by hand. */
export const SAMPLES: Record<Exclude<VisualKind, "image">, { code: string; data: any }> = {
  mermaid: { code: 'flowchart TD\n  A["Начало"] --> B{"Условие выполнено?"}\n  B -- да --> C["Действие"]\n  B -- нет --> D["Конец"]\n  C --> D', data: {} },
  svg: {
    code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240">\n  <rect width="100%" height="100%" fill="#ffffff"/>\n  <circle cx="120" cy="120" r="60" fill="none" stroke="#1f2937" stroke-width="3"/>\n  <line x1="120" y1="120" x2="180" y2="120" stroke="#2a78d6" stroke-width="3"/>\n  <text x="150" y="110" font-family="sans-serif" font-size="16" fill="#1f2937">r</text>\n  <text x="240" y="125" font-family="sans-serif" font-size="16" fill="#1f2937">S = πr²</text>\n</svg>',
    data: {},
  },
  chart: { code: "", data: { type: "bar", labels: ["A", "B", "C"], series: [{ name: "Значение", values: [3, 5, 2] }], x_label: "", y_label: "", unit: "" } },
  scheme: { code: "", data: { template: "flow", items: [{ title: "Шаг 1", text: "" }, { title: "Шаг 2", text: "" }, { title: "Шаг 3", text: "" }] } },
  html: {
    code: '<!doctype html>\n<html><body>\n  <label>Параметр: <input id="k" type="range" min="1" max="10" value="3"></label>\n  <p>Результат: <b id="out"></b></p>\n  <script>\n    const k = document.getElementById("k"), out = document.getElementById("out");\n    const draw = () => { out.textContent = (k.value * k.value).toString(); };\n    k.oninput = draw; draw();\n  </script>\n</body></html>',
    data: { height: 260 },
  },
  tool: { code: "", data: { tool_id: "plotter", state: { fns: "sin(x)\nx^2/10", range: { x0: -10, x1: 10 } } } },
};

const usesCode = (k: VisualKind) => k === "mermaid" || k === "svg" || k === "html";
const usesData = (k: VisualKind) => k !== "mermaid" && k !== "svg" && k !== "image";

type Draft = { kind: VisualKind; title: string; description: string; code: string; dataText: string };

function draftOf(v: VisualDto): Draft {
  const data = v.kind === "html" ? { height: v.data?.height ?? 360 } : v.data ?? {};
  return { kind: v.kind, title: v.title, description: v.description, code: v.code, dataText: JSON.stringify(data, null, 2) };
}

/** Manual editing with a live preview (debounced, so typing a diagram does not re-render it on every key). */
export function VisualForm({ visual, courseId, onSaved, onCancel, onPickImage }: {
  visual: VisualDto;
  courseId: number;
  onSaved: (v: VisualDto) => void;
  onCancel: () => void;
  onPickImage?: () => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(visual));
  const [preview, setPreview] = useState<VisualDto>(visual);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = visual.id < 0;

  useEffect(() => {
    const t = setTimeout(() => {
      let data: any = {};
      if (usesData(d.kind)) {
        try {
          data = JSON.parse(d.dataText || "{}");
          setJsonError(null);
        } catch (e: any) {
          setJsonError(`JSON: ${e.message}`);
          return;
        }
      }
      setPreview({ ...visual, kind: d.kind, title: d.title, description: d.description, code: d.code, data });
    }, 500);
    return () => clearTimeout(t);
  }, [d, visual]);

  function changeKind(kind: VisualKind) {
    if (kind === "image") return;
    const sample = SAMPLES[kind];
    setD({ ...d, kind, code: usesCode(kind) ? sample.code : "", dataText: JSON.stringify(sample.data, null, 2) });
  }

  async function save(approve: boolean) {
    setError(null);
    let data: any = {};
    if (usesData(d.kind)) {
      try { data = JSON.parse(d.dataText || "{}"); } catch (e: any) { setError(`Данные не в формате JSON: ${e.message}`); return; }
    }
    setBusy(true);
    try {
      const body = { kind: d.kind, title: d.title, description: d.description, code: d.code, data, ...(visual.asset_id ? { asset_id: visual.asset_id } : {}) };
      const saved = isNew
        ? await api.post<VisualDto>(`/courses/${courseId}/visuals`, { ...body, node_id: visual.node_id, approve })
        : await api.patch<VisualDto>(`/visuals/${visual.id}`, { ...body, status: approve ? "approved" : "draft" });
      onSaved(saved);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vis-form">
      <div className="vis-form-grid">
        <div className="col" style={{ gap: 10, minWidth: 0 }}>
          {isNew && d.kind !== "image" && (
            <label className="field">Вид
              <select value={d.kind} onChange={(e) => changeKind(e.target.value as VisualKind)}>
                {(Object.keys(SAMPLES) as VisualKind[]).map((k) => <option key={k} value={k}>{KIND_META[k].icon} {KIND_META[k].name} — {KIND_META[k].hint}</option>)}
              </select>
            </label>
          )}
          <label className="field">Подпись (видят ученики)
            <input value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Например: «Как устроен цикл for»" />
          </label>
          <label className="field">
            {d.kind === "image" ? "Что на картинке и когда её показать (видит только наставник) *" : "Для наставника: что показано и когда показать"}
            <textarea rows={3} value={d.description} maxLength={2000} onChange={(e) => setD({ ...d, description: e.target.value })}
              placeholder={d.kind === "image" ? "ИИ не смотрит на картинки: он узнает о ней только из вашего описания. Опишите, что изображено и к какой мысли лекции её показать." : "Например: показать, когда объясняешь порядок проверки условия"} />
          </label>
          {d.kind === "image" && onPickImage && <button type="button" className="btn sm" onClick={onPickImage}>🖼 Заменить картинку</button>}
          {d.kind === "mermaid" && (
            <label className="field">Код Mermaid
              <textarea className="mono" rows={12} spellCheck={false} value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} />
              <span className="small faint">Справка по синтаксису: <a href="https://mermaid.js.org/intro/" target="_blank" rel="noopener noreferrer">mermaid.js.org</a></span>
            </label>
          )}
          {(d.kind === "svg" || d.kind === "html") && (
            <div className="field">{d.kind === "svg" ? "Код SVG" : "HTML-страница"}
              <Suspense fallback={<div className="vis-loading"><span className="spinner" /></div>}>
                <HtmlCodeEditor value={d.code} onChange={(code) => setD((prev) => ({ ...prev, code }))} />
              </Suspense>
            </div>
          )}
          {usesData(d.kind) && (
            <label className="field">{d.kind === "html" ? "Параметры (height — высота в пикселях)" : d.kind === "tool" ? "Инструмент и пример (tool_id, state)" : "Данные (JSON)"}
              <textarea className="mono" rows={d.kind === "html" ? 3 : 12} spellCheck={false} value={d.dataText} onChange={(e) => setD({ ...d, dataText: e.target.value })} />
              {jsonError && <span className="small warn-text">{jsonError}</span>}
            </label>
          )}
        </div>
        <div className="vis-form-preview">
          <div className="small muted" style={{ marginBottom: 6 }}>Предпросмотр — так увидит ученик</div>
          <VisualView key={`${preview.kind}:${preview.code.length}:${JSON.stringify(preview.data).length}`} visual={preview} />
        </div>
      </div>
      {error && <div className="alert error small mt">{error}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Отмена</button>
        <button className="btn" onClick={() => save(false)} disabled={busy}>Сохранить черновик</button>
        <button className="btn primary" onClick={() => save(true)} disabled={busy}>{busy ? <span className="spinner" /> : "Сохранить и одобрить"}</button>
      </div>
    </div>
  );
}

export default function VisualCard({ visual, courseId, first, last, autoEdit, onChange, onDelete, onMove, onPickImage }: {
  visual: VisualDto;
  courseId: number;
  first: boolean;
  last: boolean;
  autoEdit?: boolean;
  onChange: (v: VisualDto) => void;
  onDelete: (id: number) => void;
  onMove: (id: number, dir: -1 | 1) => void;
  onPickImage: (v: VisualDto) => void;
}) {
  const v = visual;
  const [mode, setMode] = useState<"view" | "edit" | "redo">(autoEdit ? "edit" : "view");
  const [feedback, setFeedback] = useState("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(false);
  const meta = KIND_META[v.kind];
  const approved = v.status === "approved";
  const needsDescription = v.kind === "image" && v.description.trim().length < 10;
  const version = useMemo(() => `${v.kind}:${v.code}:${JSON.stringify(v.data)}:${v.asset_id}`, [v]);

  useEffect(() => { setRenderError(null); reported.current = false; }, [version]);
  useEffect(() => {
    if (!autoEdit) return;
    setMode("edit"); // a picture just added: the author describes it right away
    setTimeout(() => document.getElementById(`visual-${v.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [autoEdit, v.id]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  const setStatus = (status: "draft" | "approved") => act(status, async () => onChange(await api.patch<VisualDto>(`/visuals/${v.id}`, { status })));
  const redo = (text: string) => act("redo", async () => {
    onChange(await api.post<VisualDto>(`/visuals/${v.id}/regenerate`, { feedback: text }));
    setMode("view");
    setFeedback("");
  });

  return (
    <div className={`vis-card ${approved ? "approved" : "draft"}`} id={`visual-${v.id}`}>
      <div className="vis-card-head">
        <span className="vis-kind">{meta.icon} {meta.name}</span>
        <span className={`badge ${approved ? "success" : "warning"}`}>{approved ? "✓ одобрено" : "черновик · ученики не видят"}</span>
        {v.origin === "ai" && <span className="badge" title="Подготовил ИИ">ИИ</span>}
        <span className="spacer" />
        <button className="btn sm ghost" disabled={first} onClick={() => onMove(v.id, -1)} title="Выше" aria-label="Выше">↑</button>
        <button className="btn sm ghost" disabled={last} onClick={() => onMove(v.id, 1)} title="Ниже" aria-label="Ниже">↓</button>
      </div>

      {mode === "edit" ? (
        <VisualForm visual={v} courseId={courseId} onCancel={() => setMode("view")} onPickImage={() => onPickImage(v)}
          onSaved={(saved) => { onChange(saved); setMode("view"); }} />
      ) : (
        <>
          <VisualView visual={v} courseId={courseId} onError={(m) => { if (!reported.current) { reported.current = true; setRenderError(m); } }} />
          <div className="vis-desc small">
            <span className="faint">Для наставника: </span>
            {v.description ? v.description : <span className="warn-text">нет описания</span>}
          </div>
          {needsDescription && (
            <div className="alert warning small">Опишите картинку: наставник не видит изображений и узнает о ней только из вашего описания. Без него её нельзя одобрить.</div>
          )}
          {renderError && (
            <div className="alert error small row" style={{ gap: 8 }}>
              <span style={{ flex: 1, minWidth: 200 }}>Не отображается: {renderError}</span>
              {v.kind !== "image" && (
                <button className="btn sm" disabled={!!busy} onClick={() => redo(`Материал не отображается, исправь ошибку: ${renderError}`)}>
                  {busy === "redo" ? <span className="spinner" /> : "🛠 Исправить с ИИ"}
                </button>
              )}
            </div>
          )}
          {mode === "redo" && (
            <div className="vis-redo">
              <textarea rows={3} value={feedback} autoFocus onChange={(e) => setFeedback(e.target.value)} maxLength={4000}
                placeholder="Что изменить? Например: «добавь шаг проверки условия», «сделай столбчатую диаграмму вместо круговой», «подписи крупнее»" />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn ghost sm" onClick={() => setMode("view")} disabled={!!busy}>Отмена</button>
                <button className="btn primary sm" onClick={() => redo(feedback)} disabled={!!busy}>{busy === "redo" ? <><span className="spinner" /> ИИ переделывает…</> : "↻ Переделать"}</button>
              </div>
            </div>
          )}
          {error && <div className="alert error small">{error}</div>}
          {mode === "view" && (
            <div className="row vis-actions">
              {approved ? (
                <button className="btn sm" disabled={!!busy} onClick={() => setStatus("draft")}>Вернуть в черновики</button>
              ) : (
                <button className="btn sm success" disabled={!!busy || needsDescription} onClick={() => setStatus("approved")}
                  title={needsDescription ? "Сначала опишите картинку" : "Ученики увидят его на лекции"}>
                  {busy === "approved" ? <span className="spinner" /> : "✓ Одобрить"}
                </button>
              )}
              <button className="btn sm" onClick={() => setMode("edit")} disabled={!!busy}>✎ Изменить</button>
              {v.kind !== "image" && <button className="btn sm" onClick={() => setMode("redo")} disabled={!!busy}>↻ Переделать с ИИ</button>}
              <span className="spacer" />
              <button className="btn sm danger" disabled={!!busy} onClick={() => confirm("Удалить этот материал?") && act("del", async () => {
                await api.del(`/visuals/${v.id}`);
                onDelete(v.id);
              })}>Удалить</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
