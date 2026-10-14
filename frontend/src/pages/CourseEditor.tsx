import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import GraphView, { type GNode } from "../components/GraphView";
import { DOMAIN_ICONS, ErrorBox, Loading, Modal } from "../components/ui";

type Meta = { domains: Record<string, string>; tools: Record<string, string> };
type Material = { id: number; filename: string; kind: string; chars: number };
type RouteSettings = { reorder: boolean; modes: boolean; bridges: boolean };
type TopicNode = GNode & { key: string; objectives: string[]; concepts: string[]; order_index: number };
type CourseFull = {
  id: number; title: string; description: string; domain: string; status: string; status_detail: string; summary: string;
  tools: string[]; published: boolean; enrolled: boolean; materials: Material[]; route_settings: RouteSettings;
  nodes: TopicNode[];
  edges: { source: number; target: number }[];
};

const KIND_NAMES: Record<string, string> = { textbook: "учебник/теория", tasks: "задания", other: "другое" };

const ROUTE_OPTIONS: { key: keyof RouteSettings; label: string; hint: string }[] = [
  { key: "reorder", label: "ИИ может менять порядок тем", hint: "Под знания и интересы ученика. Стрелки-пререквизиты и закреплённые темы не нарушаются." },
  { key: "modes", label: "ИИ может назначать режим темы", hint: "«Ускоренно» для знакомого материала, «углублённо» для слабых мест." },
  { key: "bridges", label: "ИИ может добавлять мостовые темы", hint: "Личная короткая тема, если ученику не хватает базы для следующей." },
];

/** Author topics in study order: the author's order wherever the prerequisite arrows allow it. */
function studyOrder(nodes: TopicNode[], edges: { source: number; target: number }[]): TopicNode[] {
  const remaining = nodes.filter((n) => !n.personal).sort((a, b) => a.order_index - b.order_index || a.id - b.id);
  const result: TopicNode[] = [];
  while (remaining.length) {
    const left = new Set(remaining.map((n) => n.id));
    const i = Math.max(0, remaining.findIndex((n) => !edges.some((e) => e.target === n.id && left.has(e.source))));
    result.push(...remaining.splice(i, 1));
  }
  return result;
}

export default function CourseEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [course, setCourse] = useState<CourseFull | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("it");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState("textbook");
  const [url, setUrl] = useState("");
  const [textModal, setTextModal] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [editNode, setEditNode] = useState<TopicNode | null>(null);
  const [newNode, setNewNode] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<Meta>("/meta").then(setMeta);
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    const c = await api.get<CourseFull>(`/courses/${id}`);
    setCourse(c);
    setTitle(c.title);
    setDescription(c.description);
    setDomain(c.domain);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  // poll while the AI builds the graph
  useEffect(() => {
    if (course?.status !== "processing") return;
    const t = setInterval(() => load().catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [course?.status, load]);

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

  async function save() {
    await run("save", async () => {
      if (!id) {
        const c = await api.post<{ id: number }>("/courses", { title, description, domain });
        nav(`/courses/${c.id}/edit`, { replace: true });
      } else {
        await api.patch(`/courses/${id}`, { title, description, domain });
        await load();
      }
    });
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !id) return;
    const form = new FormData();
    form.append("kind", kind);
    Array.from(files).forEach((f) => form.append("files", f));
    await run("upload", async () => {
      await api.upload(`/courses/${id}/materials`, form);
      await load();
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  const titleOf = (nid: number) => course?.nodes.find((n) => n.id === nid)?.title ?? "?";

  // graph edits report errors right under the graph, not at the top of the page
  async function editGraph(fn: () => Promise<unknown>) {
    setGraphError(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      setGraphError(e.message);
    }
  }

  function connect(source: number, target: number) {
    editGraph(() => api.post(`/courses/${id}/edges`, { source, target }));
  }

  function removeEdge(source: number, target: number) {
    if (!confirm(`Убрать пререквизит «${titleOf(source)}» → «${titleOf(target)}»?`)) return;
    editGraph(() => api.del(`/courses/${id}/edges?source=${source}&target=${target}`));
  }

  function saveOrder(ids: number[]) {
    if (!course) return;
    const pos = new Map(ids.map((nid, i) => [nid, i]));
    setCourse({ ...course, nodes: course.nodes.map((n) => (pos.has(n.id) ? { ...n, order_index: pos.get(n.id)! } : n)) });
    run("order", async () => {
      await api.put(`/courses/${id}/order`, { node_ids: ids });
      await load();
    });
  }

  function togglePin(n: TopicNode) {
    if (!course) return;
    setCourse({ ...course, nodes: course.nodes.map((x) => (x.id === n.id ? { ...x, pinned: !n.pinned } : x)) });
    run("pin", async () => {
      await api.patch(`/nodes/${n.id}`, { pinned: !n.pinned });
      await load();
    });
  }

  function setRoute(key: keyof RouteSettings, value: boolean) {
    if (!course) return;
    const route_settings = { ...course.route_settings, [key]: value };
    setCourse({ ...course, route_settings });
    api.patch(`/courses/${id}`, { route_settings }).catch((err) => setError(err.message));
  }

  function rebuild() {
    if (course?.nodes.length && !confirm(
      "Перестроить граф заново?\n\nИИ создаст темы с нуля. Ручные правки (темы, стрелки, порядок, закрепления) и прогресс учеников по этому курсу будут удалены.",
    )) return;
    run("build", async () => { await api.post(`/courses/${id}/build`); await load(); });
  }

  if (!meta || (id && !course)) return error ? <ErrorBox error={error} /> : <Loading />;

  const order = course ? studyOrder(course.nodes, course.edges) : [];
  const direct = (a: number, b: number) => !!course?.edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  const move = (i: number, dir: -1 | 1) => {
    const ids = order.map((n) => n.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    saveOrder(ids);
  };

  return (
    <div>
      <div className="row mb">
        <h1>{id ? "Редактор курса" : "Новый курс"}</h1>
        <span className="spacer" />
        {course && (
          <Link className="btn" to={`/courses/${course.id}`}>
            Открыть как ученик →
          </Link>
        )}
      </div>
      <ErrorBox error={error} />

      <div className="card">
        <h2>1. Тема курса</h2>
        <div className="col">
          <label className="field">
            Название
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Основы Python" />
          </label>
          <label className="field">
            Область — определяет набор инструментов в практике
            <select value={domain} onChange={(e) => setDomain(e.target.value)}>
              {Object.entries(meta.domains).map(([k, v]) => (
                <option key={k} value={k}>
                  {DOMAIN_ICONS[k]} {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Описание для ИИ-методиста: для кого курс, цели, что важно
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn primary" onClick={save} disabled={!!busy || title.trim().length < 2}>
              {busy === "save" ? <span className="spinner" /> : id ? "Сохранить" : "Создать курс"}
            </button>
          </div>
        </div>
      </div>

      {course && (
        <>
          <div className="card">
            <h2>2. Материалы</h2>
            <p className="muted small">
              Учебники, конспекты, сборники задач. ИИ строит по ним граф тем, берёт из них объяснения для лекций и задания для практики.
            </p>
            <div className="row mb">
              <label className="field" style={{ width: 220 }}>
                Тип материала
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {Object.entries(KIND_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </div>
            <div className="row mb">
              <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md" style={{ width: "auto" }}
                onChange={(e) => uploadFiles(e.target.files)} />
              {busy === "upload" && <span className="spinner" />}
            </div>
            <div className="row mb">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… ссылка на PDF или страницу учебника" style={{ flex: 1, minWidth: 260 }} />
              <button className="btn" disabled={!url.trim() || !!busy}
                onClick={() => run("url", async () => { await api.post(`/courses/${id}/materials/url`, { url, kind }); setUrl(""); await load(); })}>
                {busy === "url" ? <span className="spinner" /> : "Добавить по ссылке"}
              </button>
              <button className="btn" onClick={() => setTextModal(true)}>Вставить текст</button>
            </div>
            {course.materials.length ? (
              <table className="md" style={{ width: "100%" }}>
                <tbody>
                  {course.materials.map((m) => (
                    <tr key={m.id}>
                      <td>{m.filename}</td>
                      <td><span className="badge">{KIND_NAMES[m.kind] ?? m.kind}</span></td>
                      <td className="small muted">{(m.chars / 1000).toFixed(1)} тыс. знаков</td>
                      <td style={{ width: 40 }}>
                        <button className="icon-btn" title="Удалить"
                          onClick={() => run("del", async () => { await api.del(`/courses/${id}/materials/${m.id}`); await load(); })}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">Материалов пока нет — можно построить граф и по описанию, но с материалами лекции точнее.</div>
            )}
          </div>

          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>3. Граф знаний</h2>
              <span className="spacer" />
              {course.status !== "processing" && (
                <button className="btn" disabled={!!busy} onClick={() => setNewNode(true)}>
                  {course.nodes.length ? "+ Тема" : "Собрать вручную"}
                </button>
              )}
              <button className={`btn ${course.nodes.length ? "" : "primary"}`} disabled={course.status === "processing" || !!busy} onClick={rebuild}>
                {course.status === "processing" ? <><span className="spinner" /> ИИ строит граф…</> : course.nodes.length ? "Перестроить с нуля" : "Построить граф с ИИ"}
              </button>
            </div>
            {course.status_detail && (
              <div className={`alert mt ${course.status === "error" ? "error" : course.status === "ready" ? "success" : ""}`}>{course.status_detail}</div>
            )}
            {course.summary && <p className="mt">{course.summary}</p>}
            {course.nodes.length > 0 && (
              <>
                <p className="small muted mt">
                  Стрелка — обязательный пререквизит: тема откроется только после темы, из которой стрелка идёт.
                  Чтобы добавить стрелку, потяни от нижней точки темы к другой теме. Нажми на стрелку, чтобы убрать её, на тему — чтобы изменить.
                </p>
                <ErrorBox error={graphError} />
                <GraphView nodes={course.nodes.filter((n) => !n.personal)} edges={course.edges} showStatus={false} height={520}
                  editable onConnect={connect} onEdgeClick={removeEdge}
                  onSelect={(n) => setEditNode(course.nodes.find((x) => x.id === n.id)!)} />
              </>
            )}
          </div>

          {order.length > 0 && (
            <div className="card">
              <h2>4. Порядок тем и личные маршруты</h2>
              <div className="order-grid">
                <div>
                  <div className="eyebrow mb">Порядок изучения</div>
                  <div className="order-list">
                    {order.map((n, i) => {
                      const reqs = course.edges.filter((e) => e.target === n.id).map((e) => titleOf(e.source));
                      return (
                        <div key={n.id} className={`order-item ${n.pinned && course.route_settings.reorder ? "pinned" : ""}`}>
                          <span className="num">{i + 1}</span>
                          <span className="t" title={reqs.length ? `После: ${reqs.join(", ")}` : n.title}>{n.title}</span>
                          {reqs.length > 0 && <span className="req" title={`После: ${reqs.join(", ")}`}>↳ {reqs.length}</span>}
                          {course.route_settings.reorder && (
                            <button className={`icon-btn pin-btn ${n.pinned ? "on" : ""}`} disabled={!!busy} onClick={() => togglePin(n)}
                              title={n.pinned ? "Открепить: ИИ сможет двигать тему" : "Закрепить на этом месте: ИИ не будет её двигать"}>
                              📌
                            </button>
                          )}
                          <button className="icon-btn" title="Выше" onClick={() => move(i, -1)}
                            disabled={!!busy || i === 0 || direct(order[i - 1].id, n.id)}>↑</button>
                          <button className="icon-btn" title="Ниже" onClick={() => move(i, 1)}
                            disabled={!!busy || i === order.length - 1 || direct(n.id, order[i + 1].id)}>↓</button>
                        </div>
                      );
                    })}
                  </div>
                  <p className="small muted mt">
                    Тему нельзя поднять выше её пререквизита: сначала убери стрелку на графе.
                  </p>
                </div>
                <div>
                  <div className="eyebrow mb">Что ИИ-наставник может менять для ученика</div>
                  <div className="col">
                    {ROUTE_OPTIONS.map((o) => (
                      <label key={o.key} className="checkbox">
                        <input type="checkbox" checked={course.route_settings[o.key]} onChange={(e) => setRoute(o.key, e.target.checked)} />
                        <span>
                          {o.label}
                          <span className="small muted" style={{ display: "block" }}>{o.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="alert mt small">
                    {course.route_settings.reorder
                      ? "Слева порядок по умолчанию. ИИ может переставлять темы под ученика, кроме закреплённых 📌: они остаются на своём месте."
                      : "Порядок жёстко задан: все ученики проходят темы ровно так, как в списке слева."}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <h2>5. Инструменты практики</h2>
            <p className="small muted">Отмеченные инструменты появятся справа в рабочем пространстве ученика (остальные доступны через поиск).</p>
            <div className="grid grid-3" style={{ gap: 6 }}>
              {Object.entries(meta.tools).map(([k, v]) => (
                <label key={k} className="checkbox">
                  <input type="checkbox" checked={course.tools.includes(k)}
                    onChange={(e) => {
                      const tools = e.target.checked ? [...course.tools, k] : course.tools.filter((t) => t !== k);
                      setCourse({ ...course, tools });
                      api.patch(`/courses/${id}`, { tools }).catch((err) => setError(err.message));
                    }} />
                  {v}
                </label>
              ))}
            </div>
          </div>

          <div className="card row">
            <div>
              <h2 style={{ margin: 0 }}>6. Публикация</h2>
              <span className="small muted">{course.published ? "Курс виден всем в каталоге." : "Черновик виден только тебе."}</span>
            </div>
            <span className="spacer" />
            <button className={`btn ${course.published ? "" : "success"}`} disabled={course.status !== "ready" || !!busy}
              onClick={() => run("pub", async () => { await api.post(`/courses/${id}/publish?published=${!course.published}`); await load(); })}>
              {course.published ? "Снять с публикации" : "Опубликовать"}
            </button>
            <button className="btn danger" onClick={() => {
              if (confirm("Удалить курс со всеми материалами и прогрессом учеников?"))
                run("delc", async () => { await api.del(`/courses/${id}`); nav("/"); });
            }}>Удалить курс</button>
          </div>
        </>
      )}

      {textModal && (
        <Modal title="Вставить текст материала" onClose={() => setTextModal(false)}
          footer={<>
            <button className="btn" onClick={() => setTextModal(false)}>Отмена</button>
            <button className="btn primary" disabled={!pasteTitle.trim() || pasteText.trim().length < 20}
              onClick={() => run("text", async () => {
                await api.post(`/courses/${id}/materials/text`, { title: pasteTitle, text: pasteText, kind });
                setTextModal(false); setPasteTitle(""); setPasteText(""); await load();
              })}>Добавить</button>
          </>}>
          <div className="col">
            <input placeholder="Название (например, «Глава 3. Циклы»)" value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} />
            <textarea rows={12} placeholder="Текст главы, конспекта или задания…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          </div>
        </Modal>
      )}

      {editNode && (
        <NodeEditor node={editNode} onClose={() => setEditNode(null)}
          onSaved={async () => { setEditNode(null); await load(); }} onError={setError} />
      )}

      {newNode && course && (
        <NewNodeModal courseId={course.id} topics={order} onClose={() => setNewNode(false)}
          onSaved={async () => { setNewNode(false); await load(); }} onError={setError} />
      )}
    </div>
  );
}

function NewNodeModal({ courseId, topics, onClose, onSaved, onError }: {
  courseId: number; topics: TopicNode[]; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [objectives, setObjectives] = useState("");
  const [concepts, setConcepts] = useState("");
  const [requires, setRequires] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Новая тема" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!title.trim() || saving} onClick={async () => {
          setSaving(true);
          try {
            await api.post(`/courses/${courseId}/nodes`, {
              title, summary, requires,
              objectives: objectives.split("\n").map((s) => s.trim()).filter(Boolean),
              concepts: concepts.split(",").map((s) => s.trim()).filter(Boolean),
            });
            onSaved();
          } catch (e: any) { onError(e.message); onClose(); }
        }}>{saving ? <span className="spinner" /> : "Добавить"}</button>
      </>}>
      <div className="col">
        <label className="field">Название<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="field">Описание<textarea value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="field">Цели (по одной в строке)<textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
        <label className="field">Ключевые понятия (через запятую)<input value={concepts} onChange={(e) => setConcepts(e.target.value)} /></label>
        <div className="field">
          Изучается после тем (пререквизиты)
          <div className="col" style={{ gap: 4, maxHeight: 200, overflowY: "auto", marginTop: 6 }}>
            {topics.map((t) => (
              <label key={t.id} className="checkbox">
                <input type="checkbox" checked={requires.includes(t.id)}
                  onChange={(e) => setRequires(e.target.checked ? [...requires, t.id] : requires.filter((x) => x !== t.id))} />
                {t.title}
              </label>
            ))}
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Тема встанет в конец порядка изучения, потом её можно передвинуть.</p>
      </div>
    </Modal>
  );
}

function NodeEditor({ node, onClose, onSaved, onError }: {
  node: CourseFull["nodes"][number]; onClose: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [title, setTitle] = useState(node.title);
  const [summary, setSummary] = useState(node.summary);
  const [objectives, setObjectives] = useState(node.objectives.join("\n"));
  const [concepts, setConcepts] = useState(node.concepts.join(", "));
  return (
    <Modal title="Тема графа" onClose={onClose}
      footer={<>
        <button className="btn danger" onClick={async () => {
          if (!confirm("Удалить тему? Её пререквизиты перейдут к зависимым темам.")) return;
          try { await api.del(`/nodes/${node.id}`); onSaved(); } catch (e: any) { onError(e.message); }
        }}>Удалить</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={async () => {
          try {
            await api.patch(`/nodes/${node.id}`, {
              title, summary,
              objectives: objectives.split("\n").map((s) => s.trim()).filter(Boolean),
              concepts: concepts.split(",").map((s) => s.trim()).filter(Boolean),
            });
            onSaved();
          } catch (e: any) { onError(e.message); }
        }}>Сохранить</button>
      </>}>
      <div className="col">
        <label className="field">Название<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Описание<textarea value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="field">Цели (по одной в строке)<textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
        <label className="field">Ключевые понятия (через запятую)<input value={concepts} onChange={(e) => setConcepts(e.target.value)} /></label>
      </div>
    </Modal>
  );
}
