import { Icon } from "../components/Icon";
import { useState } from "react";
import { api } from "../api";
import GraphHistory from "../components/GraphHistory";
import GraphView from "../components/GraphView";
import { ErrorBox, Modal } from "../components/ui";
import type { CourseFull, Excerpt, RouteSettings, TopicNode } from "./types";

const ROUTE_OPTIONS: { key: keyof RouteSettings; label: string; hint: string }[] = [
  { key: "reorder", label: "ИИ может менять порядок тем", hint: "Под знания и интересы ученика. Стрелки-пререквизиты и закреплённые темы не нарушаются." },
  { key: "modes", label: "ИИ может назначать режим темы", hint: "«Ускоренно» для знакомого материала, «углублённо» для слабых мест." },
  { key: "bridges", label: "ИИ может добавлять мостовые темы", hint: "Личная короткая тема, если ученику не хватает базы для следующей." },
  {
    key: "adventures", label: "Побочные квесты и случайные встречи",
    hint: "Необязательное на карте ученика: сверхматериал по его интересу и встречи со старыми темами. В рейтинг и процент прохождения не входит.",
  },
];

export default function TopicsStep({ course, setCourse, order, excerpts, busy, run, load, onError, openPins }: {
  course: CourseFull;
  setCourse: (c: CourseFull) => void;
  order: TopicNode[];
  excerpts: Excerpt[];
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  load: () => Promise<void>;
  onError: (msg: string | null) => void;
  openPins: (nodeId: number) => void;
}) {
  const [editNode, setEditNode] = useState<TopicNode | null>(null);
  const [newNode, setNewNode] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const id = course.id;
  const processing = course.status === "processing";

  const titleOf = (nid: number) => course.nodes.find((n) => n.id === nid)?.title ?? "?";
  const pinsOf = (nid: number) => excerpts.filter((e) => e.node_id === nid);
  const direct = (a: number, b: number) => course.edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));

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

  function removeEdge(source: number, target: number) {
    if (!confirm(`Убрать пререквизит «${titleOf(source)}» → «${titleOf(target)}»?`)) return;
    editGraph(() => api.del(`/courses/${id}/edges?source=${source}&target=${target}`));
  }

  function saveOrder(ids: number[]) {
    const pos = new Map(ids.map((nid, i) => [nid, i]));
    setCourse({ ...course, nodes: course.nodes.map((n) => (pos.has(n.id) ? { ...n, order_index: pos.get(n.id)! } : n)) });
    run("order", async () => {
      await api.put(`/courses/${id}/order`, { node_ids: ids });
      await load();
    });
  }

  function move(i: number, dir: -1 | 1) {
    const ids = order.map((n) => n.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    saveOrder(ids);
  }

  function togglePin(n: TopicNode) {
    setCourse({ ...course, nodes: course.nodes.map((x) => (x.id === n.id ? { ...x, pinned: !n.pinned } : x)) });
    run("pin", async () => {
      await api.patch(`/nodes/${n.id}`, { pinned: !n.pinned });
      await load();
    });
  }

  function setRoute(key: keyof RouteSettings, value: boolean) {
    const route_settings = { ...course.route_settings, [key]: value };
    setCourse({ ...course, route_settings });
    api.patch(`/courses/${id}`, { route_settings }).catch((err) => onError(err.message));
  }

  function build() {
    if (course.nodes.length && !confirm(
      "Перестроить граф заново?\n\nИИ создаст темы с нуля. Ручные правки (темы, стрелки, порядок, закрепления в маршруте) и прогресс учеников по этому курсу будут удалены.\n\nТекущий граф сохранится в истории графа, но актуальной станет новая версия. Обязательные фрагменты останутся, но их придётся заново привязать к новым темам.",
    )) return;
    run("build", async () => { await api.post(`/courses/${id}/build`); await load(); });
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <div>
            <h2 style={{ margin: 0 }}>Граф знаний</h2>
            <div className="small muted">Темы курса и то, что нужно знать до каждой из них.</div>
          </div>
          <span className="spacer" />
          {!processing && course.nodes.length > 0 && (
            <>
              <button className="btn" disabled={!!busy} onClick={() => setNewNode(true)}>+ Тема</button>
              <button className="btn" disabled={!!busy} onClick={build}>Перестроить с ИИ</button>
            </>
          )}
        </div>

        {processing && (
          <div className="alert mt row" style={{ flexWrap: "nowrap" }}>
            <span className="spinner" />
            <div><b>ИИ строит граф…</b><div className="small muted">{course.status_detail || "Обычно это занимает до минуты."}</div></div>
          </div>
        )}
        {!processing && course.status_detail && course.status === "error" && <div className="alert error mt">{course.status_detail}</div>}
        {course.summary && !processing && <p className="mt" style={{ marginBottom: 0 }}>{course.summary}</p>}

        {!processing && course.nodes.length === 0 && (
          <div className="choice-grid mt">
            <button className="choice" disabled={!!busy} onClick={build}>
              <span className="ico"><Icon name="graph" /></span>
              <b>Построить граф с ИИ</b>
              <span className="small muted">
                ИИ изучит описание{course.materials.length ? ` и ${course.materials.length} материал(ов)` : ""} и предложит 4–14 тем со связями.
                Потом всё можно поправить.
              </span>
            </button>
            <button className="choice" disabled={!!busy} onClick={() => setNewNode(true)}>
              <span className="ico"><Icon name="note" /></span>
              <b>Собрать вручную</b>
              <span className="small muted">Добавьте темы сами и соедините стрелками. Тему можно создать и прямо из материала, на шаге «Обязательное».</span>
            </button>
          </div>
        )}

        {course.nodes.length > 0 && (
          <>
            <p className="small muted mt">
              Стрелка — обязательный пререквизит: тема откроется только после темы, из которой стрелка идёт.
              Чтобы добавить стрелку, потяните от нижней точки темы к другой теме. Нажмите на стрелку, чтобы убрать её, на тему — чтобы изменить.
            </p>
            <ErrorBox error={graphError} />
            <div className="row mb" style={{ gap: 8 }}>
              <button className="btn sm" disabled={!!busy} onClick={() => setHistory(true)} title="Все варианты графа: прошлые — только для просмотра">
                <Icon name="history" /> История графа
              </button>
              <span className="small muted">как менялся граф</span>
            </div>
            <GraphView nodes={course.nodes.filter((n) => !n.personal)} edges={course.edges} showStatus={false} height={500}
              editable onConnect={(s, t) => editGraph(() => api.post(`/courses/${id}/edges`, { source: s, target: t }))} onEdgeClick={removeEdge}
              onSelect={(n) => setEditNode(course.nodes.find((x) => x.id === n.id)!)} />
          </>
        )}
      </div>

      {order.length > 0 && (
        <div className="card">
          <h2>Порядок тем и личные маршруты</h2>
          <div className="order-grid">
            <div>
              <div className="eyebrow mb">Порядок изучения</div>
              <div className="order-list">
                {order.map((n, i) => {
                  const reqs = course.edges.filter((e) => e.target === n.id).map((e) => titleOf(e.source));
                  const mine = pinsOf(n.id);
                  return (
                    <div key={n.id} className={`order-item ${n.pinned && course.route_settings.reorder ? "pinned" : ""}`}>
                      <span className="num">{i + 1}</span>
                      <span className="t" title={reqs.length ? `После: ${reqs.join(", ")}` : n.title}>{n.title}</span>
                      {reqs.length > 0 && <span className="req" title={`После: ${reqs.join(", ")}`}>↳ {reqs.length}</span>}
                      <button className={`pins-chip ${mine.length ? "on" : ""}`} onClick={() => openPins(n.id)}
                        title={mine.length ? "Обязательное содержание этой темы" : "Закрепить обязательные темы и задания из материалов"}>
                        <Icon name="target" />{mine.length ? ` ${mine.length}` : ""}
                      </button>
                      {course.route_settings.reorder && (
                        <button className={`icon-btn pin-btn ${n.pinned ? "on" : ""}`} disabled={!!busy} onClick={() => togglePin(n)}
                          title={n.pinned ? "Открепить: ИИ сможет двигать тему" : "Закрепить на этом месте: ИИ не будет её двигать"}>
                          <Icon name="pin" />
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
                Тему нельзя поднять выше её пререквизита: сначала уберите стрелку на графе. Значок мишени открывает обязательные фрагменты темы. Булавка закрепляет тему на своём месте в маршруте.
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
                  ? "Слева порядок по умолчанию. ИИ может переставлять темы под ученика, кроме закреплённых: они остаются на своём месте."
                  : "Порядок жёстко задан: все ученики проходят темы ровно так, как в списке слева."}
              </div>
            </div>
          </div>
        </div>
      )}

      {editNode && (
        <NodeEditor node={editNode} pins={pinsOf(editNode.id)} onClose={() => setEditNode(null)}
          onPins={() => { const nid = editNode.id; setEditNode(null); openPins(nid); }}
          onSaved={async () => { setEditNode(null); await load(); }} onError={onError} />
      )}
      {newNode && (
        <NewNodeModal courseId={id} topics={order} onClose={() => setNewNode(false)}
          onSaved={async () => { setNewNode(false); await load(); }} onError={onError} />
      )}
      {history && <GraphHistory courseId={id} onClose={() => setHistory(false)} />}
    </>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const commas = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

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
            await api.post(`/courses/${courseId}/nodes`, { title, summary, requires, objectives: lines(objectives), concepts: commas(concepts) });
            onSaved();
          } catch (e: any) { onError(e.message); onClose(); }
        }}>{saving ? <span className="spinner" /> : "Добавить"}</button>
      </>}>
      <div className="col">
        <label className="field">Название<input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="field">Описание<textarea value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="field">Цели (по одной в строке)<textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
        <label className="field">Ключевые понятия (через запятую)<input value={concepts} onChange={(e) => setConcepts(e.target.value)} /></label>
        {topics.length > 0 && (
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
        )}
        <p className="small muted" style={{ margin: 0 }}>Тема встанет в конец порядка изучения, потом её можно передвинуть.</p>
      </div>
    </Modal>
  );
}

function NodeEditor({ node, pins, onClose, onPins, onSaved, onError }: {
  node: TopicNode; pins: Excerpt[]; onClose: () => void; onPins: () => void; onSaved: () => void; onError: (e: string) => void;
}) {
  const [title, setTitle] = useState(node.title);
  const [summary, setSummary] = useState(node.summary);
  const [objectives, setObjectives] = useState(node.objectives.join("\n"));
  const [concepts, setConcepts] = useState(node.concepts.join(", "));
  const topics = pins.filter((e) => e.kind === "topic").length;
  return (
    <Modal title="Тема графа" onClose={onClose}
      footer={<>
        <button className="btn danger" onClick={async () => {
          if (!confirm("Удалить тему? Её пререквизиты перейдут к зависимым темам." + (pins.length ? "\n\nЗакреплённые за ней фрагменты останутся без темы." : ""))) return;
          try { await api.del(`/nodes/${node.id}`); onSaved(); } catch (e: any) { onError(e.message); }
        }}>Удалить</button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={async () => {
          try {
            await api.patch(`/nodes/${node.id}`, { title, summary, objectives: lines(objectives), concepts: commas(concepts) });
            onSaved();
          } catch (e: any) { onError(e.message); }
        }}>Сохранить</button>
      </>}>
      <div className="col">
        <label className="field">Название<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">Описание<textarea value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        <label className="field">Цели (по одной в строке)<textarea value={objectives} onChange={(e) => setObjectives(e.target.value)} /></label>
        <label className="field">Ключевые понятия (через запятую)<input value={concepts} onChange={(e) => setConcepts(e.target.value)} /></label>
        <div className="alert small row" style={{ flexWrap: "nowrap" }}>
          <span style={{ flex: 1 }}>
            <Icon name="target" /> Обязательное содержание{" "}
            {pins.length ? <b>{topics} тем, {pins.length - topics} заданий</b> : <span className="muted">пока ничего</span>}
          </span>
          <button className="btn sm" onClick={onPins}>Открыть материалы</button>
        </div>
      </div>
    </Modal>
  );
}
