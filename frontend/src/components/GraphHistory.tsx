import { Icon } from "./Icon";
import { useEffect, useState } from "react";
import { api } from "../api";
import { plural } from "../editor/types";
import GraphView, { type GEdge, type GNode } from "./GraphView";
import { ErrorBox, Loading, Modal } from "./ui";

type SnapNode = GNode & { key?: string; objectives?: string[]; concepts?: string[]; order_index?: number };
type Version = {
  id?: number; version: number; is_current: boolean; created_at: string | null;
  summary?: string; message?: string; reason: string; nodes: SnapNode[]; edges: GEdge[];
};
type VersionMeta = {
  id: number; version: number; created_at: string; summary?: string; message?: string; reason: string;
  topics: number; links: number;
};
type History = { current: Version; items: VersionMeta[] };
type Tab = "route" | "course";

const when = (iso: string) =>
  new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toLocaleString("ru-RU", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });

const counts = (topics: number, links: number) =>
  `${topics} ${plural(topics, "тема", "темы", "тем")} · ${links} ${plural(links, "связь", "связи", "связей")}`;

/** Past variants of the course graph and of the learner's own route. Only the live one is actual. */
export default function GraphHistory({ courseId, onClose }: { courseId: number; onClose: () => void }) {
  const [course, setCourse] = useState<History | null>(null);
  const [route, setRoute] = useState<History | null>(null);
  const [picked, setPicked] = useState<Version | null>(null);
  const [routePicked, setRoutePicked] = useState<Version | null>(null);
  const [tab, setTab] = useState<Tab>("course");
  const [loadingVersion, setLoadingVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<History>(`/courses/${courseId}/graph-versions`)
      .then((r) => {
        setCourse(r);
        setPicked(r.current);
      })
      .catch((e) => setError(e.message));
    // a learner's personal route: 404 for a course they are not enrolled in, which just hides the tab
    api.get<History>(`/courses/${courseId}/route-versions`)
      .then((r) => {
        setRoute(r);
        setRoutePicked(r.current);
        setTab("route");
      })
      .catch(() => undefined);
  }, [courseId]);

  function openCourse(v: VersionMeta) {
    setLoadingVersion(`course:${v.version}`);
    setError(null);
    api.get<Version>(`/courses/${courseId}/graph-versions/${v.version}`)
      .then(setPicked)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingVersion(null));
  }

  function openRoute(v: VersionMeta) {
    setLoadingVersion(`route:${v.version}`);
    setError(null);
    api.get<Version>(`/courses/${courseId}/route-versions/${v.version}`)
      .then(setRoutePicked)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingVersion(null));
  }

  const versionRow = (v: VersionMeta, selected: boolean, onPick: () => void, loading: boolean, label: string) => (
    <button key={v.id} type="button" className={`ver-item ${selected ? "selected" : ""}`} onClick={onPick}>
      <span className="badge">{label}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>Версия {v.version}</b>
        <span className="small muted" style={{ display: "block" }}>
          {counts(v.topics, v.links)} · заменена {when(v.created_at)}
        </span>
      </span>
      {loading && <span className="spinner" />}
    </button>
  );

  return (
    <Modal title="История графа" onClose={onClose} className="modal-graph-history"
      footer={<button className="btn" onClick={onClose}>Закрыть</button>}>
      <p className="small muted" style={{ marginTop: 0 }}>
        Прошлые варианты — только для просмотра: учёба, прогресс и лидерборд всегда идут по актуальной версии.
      </p>
      <ErrorBox error={error} />
      {!course && !route ? <Loading /> : (
        <>
          {route && (
            <div className="row mb" style={{ gap: 6 }}>
              <button type="button" className={`btn sm ${tab === "route" ? "primary" : "ghost"}`} onClick={() => setTab("route")}>
                <Icon name="route" /> Мой маршрут
              </button>
              <button type="button" className={`btn sm ${tab === "course" ? "primary" : "ghost"}`} onClick={() => setTab("course")}>
                <Icon name="graph" /> Граф курса
              </button>
              <span className="spacer" />
              <span className="small muted">актуальна только новая</span>
            </div>
          )}

          {tab === "route" && route ? (
            <>
              <div className="ver-list">
                <button type="button" className={`ver-item ${routePicked?.is_current ? "selected" : ""}`}
                  onClick={() => setRoutePicked(route.current)}>
                  <span className="badge accent">актуальный</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>Версия {route.current.version}</b>
                    <span className="small muted" style={{ display: "block" }}>
                      {counts(route.current.nodes.length, route.current.edges.length)} · сейчас
                    </span>
                  </span>
                  <span className="small muted">по нему вы идёте</span>
                </button>
                {route.items.map((v) => versionRow(v, !!routePicked && !routePicked.is_current && routePicked.version === v.version,
                  () => openRoute(v), loadingVersion === `route:${v.version}`, "прошлый"))}
              </div>
              {route.items.length === 0 && (
                <p className="small muted mt">
                  Прошлых маршрутов пока нет. Маршрут сохранится здесь, когда наставник перестроит его после пройденной темы.
                </p>
              )}
              {routePicked && (
                <div className="mt">
                  <div className="row mb" style={{ alignItems: "baseline" }}>
                    <b>{routePicked.is_current ? `Маршрут ${routePicked.version} — актуальный` : `Маршрут ${routePicked.version} — прошлый`}</b>
                    <span className="spacer" />
                    <span className="small muted">{counts(routePicked.nodes.length, routePicked.edges.length)}</span>
                  </div>
                  {routePicked.message && <div className="alert small mb">{routePicked.message}</div>}
                  {routePicked.nodes.length === 0 ? (
                    <div className="empty">В этой версии не было тем</div>
                  ) : (
                    <GraphView nodes={routePicked.nodes} edges={routePicked.edges} showStatus height={520} />
                  )}
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    {routePicked.is_current
                      ? "Это ваш маршрут сейчас: порядок тем, режимы и личные мостовые темы."
                      : "Так маршрут выглядел раньше: сохранён для истории и больше не действует."}
                  </p>
                </div>
              )}
            </>
          ) : course ? (
            <>
              <div className="ver-list">
                <button type="button" className={`ver-item ${picked?.is_current ? "selected" : ""}`}
                  onClick={() => setPicked(course.current)}>
                  <span className="badge accent">актуальная</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>Версия {course.current.version}</b>
                    <span className="small muted" style={{ display: "block" }}>
                      {counts(course.current.nodes.length, course.current.edges.length)} · сейчас
                    </span>
                  </span>
                  <span className="small muted">видят ученики</span>
                </button>
                {course.items.map((v) => versionRow(v, !!picked && !picked.is_current && picked.version === v.version,
                  () => openCourse(v), loadingVersion === `course:${v.version}`, "прошлая"))}
              </div>
              {course.items.length === 0 && (
                <p className="small muted mt">
                  Прошлых версий пока нет. Граф, который заменит следующая перестройка, появится здесь.
                </p>
              )}
              {picked && (
                <div className="mt">
                  <div className="row mb" style={{ alignItems: "baseline" }}>
                    <b>{picked.is_current ? `Версия ${picked.version} — актуальная` : `Версия ${picked.version} — прошлая`}</b>
                    <span className="spacer" />
                    <span className="small muted">{counts(picked.nodes.length, picked.edges.length)}</span>
                  </div>
                  {picked.summary && <p className="small muted" style={{ marginTop: 0 }}>{picked.summary}</p>}
                  {picked.nodes.length === 0 ? (
                    <div className="empty">В этой версии не было тем</div>
                  ) : (
                    <GraphView nodes={picked.nodes} edges={picked.edges} showStatus={false} height={520} />
                  )}
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    {picked.is_current
                      ? "Этот граф сейчас в работе: по нему учатся и считается прогресс."
                      : "Прошлая версия сохранена для истории: по ней уже не учатся и прогресс по ней не считается."}
                  </p>
                </div>
              )}
            </>
          ) : <Loading />}
        </>
      )}
    </Modal>
  );
}
