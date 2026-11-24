import { Icon } from "../components/Icon";
import { useState } from "react";
import { api } from "../api";
import type { CustomToolDto } from "../tools/custom";
import { AI_EXAMPLES, type Draft, type ToolKind } from "./toolDraft";

export type Generated = Pick<CustomToolDto, "kind" | "name" | "icon" | "description" | "spec" | "code">;

/** "AI by description": the author says what the tool should do, the AI builds it, the author checks and refines it. */
export default function AiPanel({ courseId, draft, hasResult, problems, onResult, onPrompt, openEditor, onError }: {
  courseId: number;
  draft: Draft;
  /** The draft already holds something the AI made (or the author edited): further requests refine it. */
  hasResult: boolean;
  /** Errors the preview or the formula check found; the AI can be asked to fix them. */
  problems: string[];
  onResult: (g: Generated, refined: boolean, prompt: string) => void;
  onPrompt: (prompt: string) => void;
  openEditor: (kind: ToolKind) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const prompt = draft.prompt;

  async function run(refine: boolean, fb: string) {
    setBusy(true);
    onError(null);
    try {
      const previous = refine
        ? { kind: draft.kind, name: draft.name, description: draft.description, spec: draft.kind === "formula" ? draft.spec : { height: draft.height }, code: draft.code }
        : undefined;
      const g = await api.post<Generated>(`/courses/${courseId}/custom-tools/generate`, { prompt, previous, feedback: fb });
      onResult(g, refine, prompt);
      setFeedback("");
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <label className="field">
        Опишите, какой инструмент нужен
        <textarea rows={hasResult ? 3 : 6} value={prompt} onChange={(e) => onPrompt(e.target.value)} disabled={busy}
          placeholder="Например: калькулятор дозы лекарства. Ученик вводит массу тела и дозу на килограмм, инструмент показывает разовую и суточную дозу." />
      </label>

      {!hasResult && !prompt.trim() && (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>Или начните с примера:</div>
          <div className="col" style={{ gap: 6 }}>
            {AI_EXAMPLES.map((ex) => <button key={ex} type="button" className="example" onClick={() => onPrompt(ex)}>{ex}</button>)}
          </div>
        </div>
      )}

      {!hasResult ? (
        <div className="row">
          <button className="btn primary lg" disabled={busy || prompt.trim().length < 5} onClick={() => run(false, "")}>
            {busy ? <><span className="spinner" /> ИИ создаёт инструмент…</> : "Создать инструмент"}
          </button>
          {busy && <span className="small muted">Обычно до минуты</span>}
        </div>
      ) : (
        <>
          <div className="alert small">
            Готово — {draft.kind === "formula" ? "калькулятор по формулам" : "HTML-страница"}. Проверьте инструмент справа: поменяйте значения и понажимайте.
            Если что-то не так, опишите правку словами — ИИ изменит инструмент, не пересоздавая его.
          </div>
          <label className="field">
            Что изменить?
            <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} disabled={busy}
              placeholder="Например: добавь поле для температуры, результат показывай в двух единицах, сделай кнопки крупнее" />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy || !feedback.trim()} onClick={() => run(true, feedback)}>
              {busy ? <><span className="spinner" /> ИИ дорабатывает…</> : "Доработать"}
            </button>
            {problems.length > 0 && (
              <button className="btn" disabled={busy}
                onClick={() => run(true, `Исправь ошибки инструмента:\n${problems.map((p) => `- ${p}`).join("\n")}`)}>
                <Icon name="tools" /> Исправить ошибки ({problems.length})
              </button>
            )}
            <span className="spacer" />
            <button className="btn ghost" onClick={() => openEditor(draft.kind)}>
              {draft.kind === "formula" ? "Править формулы вручную →" : "Править код вручную →"}
            </button>
          </div>
          <details className="small">
            <summary className="muted" style={{ cursor: "pointer" }}>Начать заново</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" disabled={busy || prompt.trim().length < 5} onClick={() => run(false, "")}>Создать заново по описанию выше</button>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
