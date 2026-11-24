import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Loading } from "../components/ui";
import BasicsStep from "../editor/BasicsStep";
import LaunchStep from "../editor/LaunchStep";
import MaterialsStep from "../editor/MaterialsStep";
import PinsStep from "../editor/PinsStep";
import ToolsStep from "../editor/ToolsStep";
import VisualsStep, { type VisualsState } from "../editor/VisualsStep";
import TopicsStep from "../editor/TopicsStep";
import type { CustomToolDto } from "../tools/custom";
import { studyOrder, type CourseFull, type Excerpt, type ExcerptLimits, type Meta, type StepKey } from "../editor/types";

const DEFAULT_LIMITS: ExcerptLimits = { topic_chars: 30000, task_chars: 6000, theory_budget: 20000 };
const STEP_KEYS: StepKey[] = ["basics", "materials", "topics", "pins", "visuals", "tools", "launch"];
const NO_VISUALS: VisualsState = { items: [], job: null, image_queries: {}, covers: {} };

export default function CourseEditor() {
  const { id } = useParams();
  return <CourseEditorForm key={id ?? "new"} id={id} />;
}

function CourseEditorForm({ id }: { id?: string }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [course, setCourse] = useState<CourseFull | null>(null);
  const [excerpts, setExcerpts] = useState<Excerpt[]>([]);
  const [limits, setLimits] = useState<ExcerptLimits>(DEFAULT_LIMITS);
  const [customTools, setCustomTools] = useState<CustomToolDto[]>([]);
  const [toolsMax, setToolsMax] = useState(20);
  const [visuals, setVisuals] = useState<VisualsState>(NO_VISUALS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const isOwner = course?.is_author === true;

  useEffect(() => {
    if (id && !isOwner) return;
    api.get<Meta>("/meta").then(setMeta).catch((e) => setError(e.message));
  }, [id, isOwner]);

  const load = useCallback(async () => {
    if (!id) return;
    setCourse(await api.get<CourseFull>(`/courses/${id}`));
  }, [id]);

  const loadExcerpts = useCallback(async () => {
    if (!id) return;
    const r = await api.get<{ items: Excerpt[]; limits: ExcerptLimits }>(`/courses/${id}/excerpts`);
    setExcerpts(r.items);
    setLimits(r.limits);
  }, [id]);

  const loadTools = useCallback(async () => {
    if (!id) return;
    const r = await api.get<{ items: CustomToolDto[]; max: number }>(`/courses/${id}/custom-tools`);
    setCustomTools(r.items);
    setToolsMax(r.max);
  }, [id]);

  const loadVisuals = useCallback(async () => {
    if (!id) return;
    setVisuals(await api.get<VisualsState>(`/courses/${id}/visuals`));
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (!isOwner) return;
    loadExcerpts().catch((e) => setError(e.message));
    loadTools().catch((e) => setError(e.message));
    loadVisuals().catch((e) => setError(e.message));
  }, [isOwner, loadExcerpts, loadTools, loadVisuals]);

  // poll while the AI builds the graph
  useEffect(() => {
    if (!isOwner || course?.status !== "processing") return;
    const t = setInterval(() => {
      load().then(() => loadExcerpts()).catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [isOwner, course?.status, load, loadExcerpts]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const order = useMemo(() => (course?.is_author ? studyOrder(course.nodes, course.edges) : []), [course]);

  // ----- steps -----
  const wanted = params.get("step") as StepKey | null;
  const fallback: StepKey = course ? (course.nodes.length || course.materials.length ? "topics" : "materials") : "basics";
  const step: StepKey = !course ? "basics" : wanted && STEP_KEYS.includes(wanted) ? wanted : fallback;
  const focus = useMemo(
    () => ({ materialId: Number(params.get("material")) || undefined, nodeId: Number(params.get("node")) || undefined }),
    [params],
  );

  function go(next: StepKey, extra: Record<string, string | number> = {}) {
    const p: Record<string, string> = { step: next };
    for (const [k, v] of Object.entries(extra)) p[k] = String(v);
    setParams(p, { replace: false });
    window.scrollTo({ top: 0 });
  }

  if (course && !isOwner) {
    return (
      <section className="card">
        <header className="page-head">
          <h1>Нет доступа к редактору</h1>
          <p>Редактировать курс может только его владелец.</p>
        </header>
        <Link className="btn" to={`/courses/${course.id}`}>К курсу</Link>
      </section>
    );
  }

  if (!meta || (id && !course)) return error ? <ErrorBox error={error} /> : <Loading />;

  const topicsCount = course ? course.nodes.filter((n) => !n.personal).length : 0;
  const shown = visuals.items.filter((v) => v.node_id != null);
  const visualStats = { approved: shown.filter((v) => v.status === "approved").length, drafts: shown.filter((v) => v.status !== "approved").length };
  const steps: { key: StepKey; label: string; badge?: string; done: boolean }[] = [
    { key: "basics", label: "Основа", done: !!course },
    { key: "materials", label: "Материалы", badge: course?.materials.length ? String(course.materials.length) : undefined, done: !!course?.materials.length },
    { key: "topics", label: "Темы", badge: topicsCount ? String(topicsCount) : undefined, done: topicsCount > 0 },
    { key: "pins", label: "Обязательное", badge: excerpts.length ? String(excerpts.length) : undefined, done: excerpts.some((e) => e.node_id != null) },
    { key: "visuals", label: "Наглядность", badge: shown.length ? String(shown.length) : undefined, done: visualStats.approved > 0 },
    { key: "tools", label: "Инструменты", badge: customTools.length ? String(customTools.length) : undefined, done: customTools.length > 0 },
    { key: "launch", label: "Запуск", done: !!course?.published },
  ];
  const idx = steps.findIndex((s) => s.key === step);
  const prev = steps[idx - 1], next = steps[idx + 1];

  async function saveBasics(v: { title: string; description: string; domain: string }) {
    await run("save", async () => {
      if (!course) {
        const c = await api.post<{ id: number }>("/courses", v);
        nav(`/courses/${c.id}/edit?step=materials`, { replace: true });
      } else {
        await api.patch(`/courses/${course.id}`, v);
        await load();
      }
    });
  }

  const status = !course ? null : course.published ? { text: "опубликован", cls: "accent" } : course.status === "processing"
    ? { text: "граф строится…", cls: "warning" } : { text: "черновик", cls: "warning" };

  return (
    <div className="editor">
      <div className="row" style={{ marginBottom: 18, alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Link to="/courses" className="small muted">← Все курсы</Link>
          <h1 style={{ margin: "6px 0 0" }}>{course ? course.title : "Новый курс"}</h1>
        </div>
        {status && <span className={`badge ${status.cls}`} style={{ marginTop: 28 }}>{status.text}</span>}
        {course && <Link className="btn" style={{ marginTop: 22 }} to={`/courses/${course.id}`}>Открыть как ученик →</Link>}
      </div>

      <nav className="stepper ed-stepper" aria-label="Шаги создания курса">
        {steps.map((s, i) => {
          const locked = !course && s.key !== "basics";
          return (
            <button key={s.key} type="button" disabled={locked} title={locked ? "Сначала создайте курс" : undefined}
              className={`step ${s.done ? "done" : ""} ${s.key === step ? "current" : ""} ${locked ? "locked" : ""}`} onClick={() => go(s.key)}>
              <span className="num">{s.done && s.key !== step ? "✓" : i + 1}</span>
              {s.label}
              {s.badge && <span className="step-badge">{s.badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="ed-body">
        <ErrorBox error={error} />

        {step === "basics" && <BasicsStep meta={meta} course={course} busy={busy === "save"} onSave={saveBasics} />}

        {course && step === "materials" && (
          <MaterialsStep course={course} excerpts={excerpts} reload={async () => { await load(); await loadExcerpts(); }} onError={setError}
            openInPins={(materialId) => go("pins", { material: materialId })} />
        )}

        {course && step === "topics" && (
          <TopicsStep course={course} setCourse={setCourse} order={order} excerpts={excerpts} busy={busy} run={run}
            load={async () => { await load(); await loadExcerpts(); }} onError={setError} openPins={(nodeId) => go("pins", { node: nodeId })} />
        )}

        {course && step === "pins" && (
          <PinsStep course={course} order={order} excerpts={excerpts} limits={limits} focus={focus} onError={setError}
            reload={loadExcerpts} reloadCourse={load} goTo={(s) => go(s)} />
        )}

        {course && step === "visuals" && (
          <VisualsStep course={course} order={order} state={visuals} setState={setVisuals} reload={loadVisuals} focusNodeId={focus.nodeId} onError={setError} />
        )}

        {course && step === "tools" && (
          <ToolsStep meta={meta} course={course} setCourse={setCourse} tools={customTools} max={toolsMax} reload={loadTools} onError={setError} />
        )}

        {course && step === "launch" && (
          <LaunchStep course={course} excerpts={excerpts} customTools={customTools.length} visuals={visualStats} busy={busy} run={run} load={load} goTo={(s) => go(s)} />
        )}
      </div>

      {course && (
        <div className="ed-nav">
          {prev ? <button className="btn" onClick={() => go(prev.key)}>← {prev.label}</button> : <span />}
          {next && <button className="btn primary" onClick={() => go(next.key)}>Далее: {next.label} →</button>}
        </div>
      )}
    </div>
  );
}
