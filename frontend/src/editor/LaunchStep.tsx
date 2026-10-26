import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { plural, type CourseFull, type Excerpt, type StepKey } from "./types";

export default function LaunchStep({ course, excerpts, customTools, busy, run, load, goTo }: {
  course: CourseFull;
  excerpts: Excerpt[];
  customTools: number;
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  load: () => Promise<void>;
  goTo: (step: StepKey) => void;
}) {
  const nav = useNavigate();
  const topics = course.nodes.filter((n) => !n.personal).length;
  const ready = course.status === "ready";
  const unattached = excerpts.filter((e) => e.node_id == null).length;

  const checks: { ok: boolean; required: boolean; text: string; step: StepKey; note?: string }[] = [
    { ok: topics > 0 && ready, required: true, step: "topics", text: topics ? `Граф знаний: ${topics} ${plural(topics, "тема", "темы", "тем")}` : "Граф знаний не построен",
      note: topics ? undefined : "Без тем ученикам нечего проходить" },
    { ok: course.materials.length > 0, required: false, step: "materials",
      text: course.materials.length ? `Материалов: ${course.materials.length}` : "Материалов нет", note: course.materials.length ? undefined : "С ними лекции и задания точнее" },
    { ok: excerpts.some((e) => e.node_id != null), required: false, step: "pins",
      text: excerpts.length ? `Обязательных фрагментов: ${excerpts.length}` : "Обязательного содержания нет",
      note: unattached ? `${unattached} без темы: ИИ их не использует` : excerpts.length ? undefined : "По желанию: ИИ сам подберёт материал" },
    { ok: customTools > 0, required: false, step: "tools",
      text: customTools ? `Своих инструментов: ${customTools}` : "Своих инструментов нет", note: customTools ? undefined : "По желанию: встроенные инструменты уже подключены" },
  ];

  return (
    <>
      <div className="card">
        <h2>Готовность и публикация</h2>
        <div className="checklist">
          {checks.map((c) => (
            <button key={c.step} className={`check ${c.ok ? "ok" : c.required ? "bad" : ""}`} onClick={() => goTo(c.step)}>
              <span className="mark">{c.ok ? "✓" : c.required ? "!" : "○"}</span>
              <span style={{ flex: 1 }}>
                {c.text}
                {c.note && <span className="small muted" style={{ display: "block" }}>{c.note}</span>}
              </span>
              <span className="small muted">{c.required ? "обязательно" : "по желанию"} · открыть →</span>
            </button>
          ))}
        </div>
        <div className="row mt">
          <div>
            <b>{course.published ? "Курс опубликован" : "Черновик"}</b>
            <div className="small muted">{course.published ? "Он виден всем в каталоге." : "Виден только вам. Опубликуйте, когда будете готовы."}</div>
          </div>
          <span className="spacer" />
          <button className={`btn lg ${course.published ? "" : "success"}`} disabled={!ready || !!busy}
            onClick={() => run("pub", async () => { await api.post(`/courses/${course.id}/publish?published=${!course.published}`); await load(); })}>
            {course.published ? "Снять с публикации" : "Опубликовать"}
          </button>
        </div>
      </div>

      <div className="card row">
        <div>
          <h3 style={{ margin: 0 }}>Удалить курс</h3>
          <span className="small muted">Вместе с материалами, обязательными фрагментами, своими инструментами и прогрессом учеников. Это нельзя отменить.</span>
        </div>
        <span className="spacer" />
        <button className="btn danger" onClick={() => {
          if (confirm("Удалить курс со всеми материалами и прогрессом учеников?"))
            run("delc", async () => { await api.del(`/courses/${course.id}`); nav("/"); });
        }}>Удалить курс</button>
      </div>
    </>
  );
}
