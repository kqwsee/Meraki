import { useState } from "react";
import { api } from "../api";
import type { CustomToolDto } from "../tools/custom";
import ToolBuilder, { type Mode } from "./ToolBuilder";
import type { CourseFull, Meta } from "./types";

const CHOICES: { mode: Mode; icon: string; title: string; text: string }[] = [
  { mode: "formula", icon: "∑", title: "Формулы без кода", text: "Задайте величины и формулы — получится калькулятор. Для физики, химии, финансов, любых расчётов." },
  { mode: "html", icon: "</>", title: "HTML и JavaScript", text: "Напишите свою страницу: симулятор, график, тренажёр. Она работает в безопасной песочнице." },
  { mode: "ai", icon: "✨", title: "ИИ по описанию", text: "Опишите, что нужно, — ИИ соберёт инструмент, а вы проверите и поправите словами." },
];

const KIND_LABEL: Record<string, string> = { formula: "∑ формулы", html: "</> HTML/JS" };

export default function ToolsStep({ meta, course, setCourse, tools, max, reload, onError }: {
  meta: Meta;
  course: CourseFull;
  setCourse: (c: CourseFull) => void;
  tools: CustomToolDto[];
  max: number;
  reload: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState<{ tool: CustomToolDto | null; mode: Mode } | null>(null);

  if (editing) {
    return (
      <ToolBuilder courseId={course.id} tool={editing.tool} mode={editing.mode} onClose={() => setEditing(null)}
        onSaved={async () => { await reload(); setEditing(null); }} />
    );
  }

  const full = tools.length >= max;
  const run = async (fn: () => Promise<unknown>) => {
    onError(null);
    try { await fn(); await reload(); } catch (e: any) { onError(e.message); }
  };

  return (
    <>
      <div className="card">
        <div className="row">
          <div>
            <h2 style={{ margin: 0 }}>Свои инструменты</h2>
            <div className="small muted">Калькуляторы, симуляторы и тренажёры для вашего курса. Они появятся у учеников первыми в списке инструментов практики и экзамена.</div>
          </div>
          <span className="spacer" />
          {tools.length > 0 && <button className="btn primary" disabled={full} onClick={() => setEditing({ tool: null, mode: "formula" })}>＋ Создать инструмент</button>}
        </div>

        {tools.length === 0 ? (
          <div className="choice-grid mt">
            {CHOICES.map((c) => (
              <button key={c.mode} className="choice" onClick={() => setEditing({ tool: null, mode: c.mode })}>
                <span className="ico mono">{c.icon}</span>
                <b>{c.title}</b>
                <span className="small muted">{c.text}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mat-list mt">
            {tools.map((t) => (
              <div key={t.id} className={`mat-row ${t.enabled ? "" : "off"}`}>
                <span className="mat-ico">{t.icon}</span>
                <div className="mat-name">
                  <div className="t">{t.name}</div>
                  <div className="small muted" style={{ whiteSpace: "normal" }}>{t.description || "Без описания"}</div>
                </div>
                <span className="badge">{KIND_LABEL[t.kind] ?? t.kind}</span>
                {t.origin === "ai" && <span className="badge accent" title="Создан ИИ по описанию">✨ ИИ</span>}
                <label className="checkbox small" title="Скрытый инструмент не показывается ученикам, но остаётся в курсе">
                  <input type="checkbox" checked={t.enabled} onChange={(e) => run(() => api.patch(`/custom-tools/${t.id}`, { enabled: e.target.checked }))} />
                  у учеников
                </label>
                <button className="btn sm" onClick={() => setEditing({ tool: t, mode: t.kind })}>✎ Изменить</button>
                <button className="icon-btn" title="Удалить инструмент" aria-label="Удалить инструмент"
                  onClick={() => { if (confirm(`Удалить инструмент «${t.name}»? Из рабочих мест учеников он тоже пропадёт.`)) run(() => api.del(`/custom-tools/${t.id}`)); }}>✕</button>
              </div>
            ))}
          </div>
        )}
        {full && <div className="small muted mt">Достигнут предел: {max} своих инструментов в курсе.</div>}
      </div>

      <div className="card">
        <h2>Встроенные инструменты</h2>
        <p className="small muted">Отмеченные появятся справа в рабочем пространстве ученика, остальные доступны через поиск.</p>
        <div className="grid grid-3" style={{ gap: 6 }}>
          {Object.entries(meta.tools).map(([k, v]) => (
            <label key={k} className="checkbox">
              <input type="checkbox" checked={course.tools.includes(k)}
                onChange={(e) => {
                  const next = e.target.checked ? [...course.tools, k] : course.tools.filter((t) => t !== k);
                  setCourse({ ...course, tools: next });
                  api.patch(`/courses/${course.id}`, { tools: next }).catch((err) => onError(err.message));
                }} />
              {v}
            </label>
          ))}
        </div>
      </div>
    </>
  );
}
