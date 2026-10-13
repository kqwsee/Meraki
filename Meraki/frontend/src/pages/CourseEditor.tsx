import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import GraphView, { type GNode } from "../components/GraphView";
import { DOMAIN_ICONS, ErrorBox, Loading, Modal } from "../components/ui";

type Meta = { domains: Record<string, string>; tools: Record<string, string> };
type Material = { id: number; filename: string; kind: string; chars: number };
type CourseFull = {
  id: number; title: string; description: string; domain: string; status: string; status_detail: string; summary: string;
  tools: string[]; published: boolean; enrolled: boolean; materials: Material[];
  nodes: (GNode & { key: string; objectives: string[]; concepts: string[] })[];
  edges: { source: number; target: number }[];
};

const KIND_NAMES: Record<string, string> = { textbook: "учебник/теория", tasks: "задания", other: "другое" };

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
  const [editNode, setEditNode] = useState<CourseFull["nodes"][number] | null>(null);
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

  if (!meta || (id && !course)) return error ? <ErrorBox error={error} /> : <Loading />;

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
              <button className="btn primary" disabled={course.status === "processing" || !!busy}
                onClick={() => run("build", async () => { await api.post(`/courses/${id}/build`); await load(); })}>
                {course.status === "processing" ? <><span className="spinner" /> ИИ строит граф…</> : course.nodes.length ? "Перестроить граф" : "Построить граф с ИИ"}
              </button>
            </div>
            {course.status_detail && (
              <div className={`alert mt ${course.status === "error" ? "error" : course.status === "ready" ? "success" : ""}`}>{course.status_detail}</div>
            )}
            {course.summary && <p className="mt">{course.summary}</p>}
            {course.nodes.length > 0 && (
              <>
                <p className="small muted mt">
                  Это базовый граф: стрелки — обязательные пререквизиты. Для каждого ученика ИИ-наставник строит поверх него личный маршрут.
                  Нажми на тему, чтобы отредактировать её.
                </p>
                <GraphView nodes={course.nodes} edges={course.edges} showStatus={false} onSelect={(n) => setEditNode(course.nodes.find((x) => x.id === n.id)!)} height={460} />
              </>
            )}
          </div>

          <div className="card">
            <h2>4. Инструменты практики</h2>
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
              <h2 style={{ margin: 0 }}>5. Публикация</h2>
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
    </div>
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
