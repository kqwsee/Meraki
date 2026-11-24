import { Icon, iconName } from "../components/Icon";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ErrorBox } from "../components/ui";
import { FormulaView, HtmlToolView, type CustomToolDto } from "../tools/custom";
import { formulaProblems } from "../tools/formula";
import AiPanel, { type Generated } from "./AiPanel";
import FormulaBuilder from "./FormulaBuilder";
import HtmlBuilder from "./HtmlBuilder";
import { blankDraft, draftOf, FORMULA_PRESETS, TOOL_ICON_LABELS, payloadOf, type Draft, type ToolKind } from "./toolDraft";

export type Mode = ToolKind | "ai";

const MODES: { key: Mode; label: string }[] = [
  { key: "formula", label: "∑ Формулы без кода" },
  { key: "html", label: "</> HTML и JavaScript" },
  { key: "ai", label: "ИИ по описанию" },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function ToolBuilder({ courseId, tool, mode: startMode, onClose, onSaved }: {
  courseId: number; tool: CustomToolDto | null; mode: Mode; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => (tool ? draftOf(tool) : blankDraft(startMode === "html" ? "html" : "formula")));
  const [mode, setMode] = useState<Mode>(startMode);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickIcon, setPickIcon] = useState(false);
  const [frameErrors, setFrameErrors] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const formulaIssues = useMemo(() => formulaProblems(draft.spec), [draft.spec]);
  const started = draft.spec.inputs.length > 0 || draft.spec.outputs.length > 0;
  // an empty calculator is not an error yet: the author has just opened the builder
  const problems = draft.kind === "formula" ? (started ? formulaIssues : []) : frameErrors;
  const hasContent = draft.kind === "formula" ? draft.spec.outputs.length > 0 : draft.code.trim().length > 0;
  const code = useDebounced(draft.code, 700);

  // a new page, a manual reload or another tool: forget the previous run's errors
  useEffect(() => setFrameErrors([]), [code, reload, draft.kind]);

  function switchMode(next: Mode) {
    setMode(next);
    if (next !== "ai") patch({ kind: next });
  }

  function applyGenerated(g: Generated, refined: boolean, prompt: string) {
    setDraft((d) => ({
      ...d, kind: g.kind, origin: "ai", prompt,
      // the author may have renamed the tool while refining: keep their name and icon then
      name: refined && d.name.trim() ? d.name : g.name, icon: refined ? d.icon : iconName(g.icon, g.kind === "formula" ? "calculator" : "puzzle"), description: g.description || d.description,
      spec: g.kind === "formula" ? { inputs: g.spec.inputs, outputs: g.spec.outputs, notes: g.spec.notes ?? "" } : d.spec,
      code: g.kind === "html" ? g.code : d.code, height: g.kind === "html" ? g.spec?.height ?? d.height : d.height,
    }));
    setFrameErrors([]);
  }

  async function save() {
    if (!draft.name.trim()) return setError("Дайте инструменту название");
    if (draft.kind === "formula" && formulaIssues.length) return setError(`Исправьте формулы: ${formulaIssues[0]}`);
    if (draft.kind === "html" && !draft.code.trim()) return setError("Напишите код инструмента или создайте его с ИИ");
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await api.patch(`/custom-tools/${draft.id}`, payloadOf(draft));
      else await api.post(`/courses/${courseId}/custom-tools`, payloadOf(draft));
      await onSaved();
    } catch (e: any) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className="card tb">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onClose}>← К инструментам</button>
        <h2 style={{ margin: 0, fontSize: 20 }}>{draft.id ? "Изменить инструмент" : "Новый инструмент"}</h2>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={saving} onClick={save}>{saving ? <span className="spinner" /> : "Сохранить инструмент"}</button>
      </div>
      <ErrorBox error={error} />

      <div className="tb-head">
        <div className="icon-pick">
          <button type="button" className="icon-big" onClick={() => setPickIcon((v) => !v)} aria-label="Выбрать значок" aria-expanded={pickIcon}><Icon name={draft.icon} /></button>
          {pickIcon && (
            <div className="icon-pop" role="group" aria-label="Доступные значки">
              {Object.entries(TOOL_ICON_LABELS).map(([name, label]) => (
                <button key={name} type="button" title={label} aria-label={label} aria-pressed={draft.icon === name}
                  onClick={() => { patch({ icon: name }); setPickIcon(false); }}><Icon name={name} /></button>
              ))}
            </div>
          )}
        </div>
        <label className="field" style={{ flex: "1 1 220px" }}>
          Название
          <input value={draft.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} placeholder="Например: Закон Ома" autoFocus={!tool} />
        </label>
        <label className="field" style={{ flex: "2 1 300px" }}>
          Что делает (для учеников и ИИ-наставника)
          <input value={draft.description} maxLength={1000} onChange={(e) => patch({ description: e.target.value })} placeholder="Считает ток и мощность по напряжению и сопротивлению" />
        </label>
      </div>

      <div className="tabs" style={{ margin: "16px 0" }}>
        {MODES.map((m) => (
          <button key={m.key} className={mode === m.key ? "active" : ""} onClick={() => switchMode(m.key)}>{m.label}</button>
        ))}
      </div>

      <div className="tb-grid">
        <div className="tb-edit">
          {mode === "formula" && (
            <FormulaBuilder spec={draft.spec} onChange={(spec) => patch({ spec })}
              onPreset={(p) => {
                if (draft.spec.outputs.length && !confirm("Заменить текущие формулы шаблоном?")) return;
                // the name, icon and description follow the template unless the author wrote their own
                setDraft((d) => {
                  const stock = !d.name.trim() || FORMULA_PRESETS.some((q) => q.name === d.name);
                  return { ...d, kind: "formula", spec: p.spec, name: stock ? p.name : d.name, icon: stock ? p.icon : d.icon, description: stock || !d.description ? p.description : d.description };
                });
              }} />
          )}
          {mode === "html" && <HtmlBuilder code={draft.code} height={draft.height} onCode={(v) => patch({ code: v })} onHeight={(v) => patch({ height: v })} />}
          {mode === "ai" && (
            <AiPanel courseId={courseId} draft={draft} hasResult={hasContent} problems={problems} onResult={applyGenerated}
              onPrompt={(prompt) => patch({ prompt })} openEditor={switchMode} onError={setError} />
          )}
        </div>

        <aside className="tb-preview">
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="eyebrow">Предпросмотр</div>
            <span className="spacer" />
            {draft.kind === "html" && hasContent && <button className="btn sm ghost" onClick={() => setReload((n) => n + 1)} title="Запустить страницу заново">↻ Перезапустить</button>}
          </div>
          <div className="tool-card tb-card">
            <div className="tool-head" style={{ cursor: "default" }}>
              <span className="ico"><Icon name={draft.icon} /></span>
              <span style={{ flex: 1 }}>{draft.name || "Без названия"}</span>
              <span className="badge accent">автор</span>
            </div>
            <div className="tool-body">
              {!hasContent ? (
                <div className="small muted">
                  {mode === "ai" ? "Здесь появится инструмент, когда ИИ его создаст." : mode === "formula" ? "Добавьте величины и формулы — калькулятор появится здесь." : "Напишите код или вставьте шаблон — страница появится здесь."}
                </div>
              ) : draft.kind === "formula" ? (
                <FormulaView spec={draft.spec} toolId="preview" name={draft.name || "Инструмент"} />
              ) : (
                <HtmlToolView key={reload} code={code} height={draft.height} toolId="preview" name={draft.name || "Инструмент"}
                  onError={(m) => setFrameErrors((l) => (l.includes(m) ? l : [...l, m].slice(0, 5)))} />
              )}
            </div>
          </div>
          {problems.length > 0 && (
            <div className="alert warning small tb-problems">
              <b>{draft.kind === "formula" ? "Нужно исправить" : "Ошибки в странице"}</b>
              <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              {mode !== "ai" && <div className="muted">ИИ может это исправить: вкладка «ИИ по описанию».</div>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
