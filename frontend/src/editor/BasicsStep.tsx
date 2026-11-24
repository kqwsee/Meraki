import { Icon } from "../components/Icon";
import { useEffect, useState } from "react";
import { DOMAIN_ICONS } from "../components/ui";
import type { CourseFull, Meta } from "./types";

export default function BasicsStep({ meta, course, busy, onSave }: {
  meta: Meta;
  course: CourseFull | null;
  busy: boolean;
  onSave: (v: { title: string; description: string; domain: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState(course?.title ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [domain, setDomain] = useState(course?.domain ?? "it");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!course) return;
    setTitle(course.title);
    setDescription(course.description);
    setDomain(course.domain);
  }, [course?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !course || title !== course.title || description !== course.description || domain !== course.domain;
  useEffect(() => { if (dirty) setSaved(false); }, [dirty]);

  return (
    <div className="card">
      <h2>{course ? "Основа курса" : "С чего начнём?"}</h2>
      <p className="muted small" style={{ maxWidth: 640 }}>
        Название и область определяют, как ИИ-методист построит курс и какие инструменты появятся в практике.
        {!course && " Остальное (материалы, темы, обязательные задания) настраивается следующими шагами."}
      </p>
      <div className="col" style={{ maxWidth: 780 }}>
        <label className="field">
          Название курса
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Основы Python" autoFocus={!course} />
        </label>

        <div className="field">
          Область
          <div className="domain-grid">
            {Object.entries(meta.domains).map(([k, v]) => (
              <button key={k} type="button" className={`domain-pick ${domain === k ? "on" : ""}`} onClick={() => setDomain(k)} aria-pressed={domain === k}>
                <span className="ico"><Icon name={DOMAIN_ICONS[k] ?? "graduation"} /></span>
                <span>{v}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          Описание для ИИ-методиста
          <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder="Для кого курс, чему научится ученик, что важно подчеркнуть, чего в курсе быть не должно." />
          <span className="small faint">Чем конкретнее описание, тем точнее граф тем и задания.</span>
        </label>

        <div className="row">
          <button className="btn primary lg" disabled={busy || title.trim().length < 2 || (!!course && !dirty)}
            onClick={async () => { await onSave({ title, description, domain }); setSaved(true); }}>
            {busy ? <span className="spinner" /> : course ? "Сохранить" : "Создать курс и перейти к материалам →"}
          </button>
          {course && !dirty && saved && <span className="small" style={{ color: "var(--success)" }}>✓ Сохранено</span>}
          {course && dirty && <span className="small muted">Есть несохранённые изменения</span>}
        </div>
      </div>
    </div>
  );
}
