import { Icon } from "../components/Icon";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Loading, Modal } from "../components/ui";
import MaterialViewer, { type Highlight, type TextSelection } from "./MaterialViewer";
import { plural, type CourseFull, type Excerpt, type ExcerptKind, type ExcerptLimits, type TopicNode, type UseIn } from "./types";

const CARD_KIND: Record<string, { icon: string; label: string; badge: string }> = {
  topic: { icon: "book", label: "Тема", badge: "accent" },
  practice: { icon: "note", label: "Практика", badge: "warning" },
  exam: { icon: "flag", label: "Экзамен", badge: "bridge" },
};
const cardKind = (e: Pick<Excerpt, "kind" | "use_in">) => CARD_KIND[e.kind === "topic" ? "topic" : e.use_in === "exam" ? "exam" : "practice"];
const hlClass = (e: Excerpt) => (e.kind === "topic" ? "hl-topic" : e.use_in === "exam" ? "hl-exam" : "hl-task");

const fmt = (n: number) => n.toLocaleString("ru-RU");

export default function PinsStep({ course, order, excerpts, limits, reload, reloadCourse, focus, goTo, onError }: {
  course: CourseFull;
  order: TopicNode[];
  excerpts: Excerpt[];
  limits: ExcerptLimits;
  reload: () => Promise<void>;
  reloadCourse: () => Promise<void>;
  focus: { materialId?: number; nodeId?: number };
  goTo: (step: "materials" | "topics") => void;
  onError: (msg: string) => void;
}) {
  const materials = course.materials;
  const [materialId, setMaterialId] = useState<number | null>(focus.materialId ?? materials[0]?.id ?? null);
  const [text, setText] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<number | null>(focus.nodeId ?? order[0]?.id ?? null);
  const [selectedPin, setSelectedPin] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ offset: number; nonce: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; undoId: number } | null>(null);
  const [editing, setEditing] = useState<Excerpt | null>(null);
  const [newTopic, setNewTopic] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const cache = useRef(new Map<number, string>());

  // a link from another step may point at a topic or material that did not exist when this step mounted
  useEffect(() => {
    if (focus.materialId) setMaterialId(focus.materialId);
    if (focus.nodeId) setActiveNode(focus.nodeId);
  }, [focus.materialId, focus.nodeId]);
  useEffect(() => {
    if (materialId == null || !materials.some((m) => m.id === materialId)) setMaterialId(materials[0]?.id ?? null);
  }, [materials, materialId]);
  useEffect(() => {
    if (activeNode == null || !order.some((n) => n.id === activeNode)) setActiveNode(order[0]?.id ?? null);
  }, [order, activeNode]);

  useEffect(() => {
    if (materialId == null) { setText(null); return; }
    const hit = cache.current.get(materialId);
    if (hit != null) { setText(hit); return; }
    let live = true;
    setText(null);
    api.get<{ text: string }>(`/courses/${course.id}/materials/${materialId}/text`)
      .then((r) => { cache.current.set(materialId, r.text); if (live) setText(r.text); })
      .catch((e) => { if (live) onError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialId, course.id]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  // ----- search inside the material -----
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!text || q.length < 2) return [] as number[];
    const lower = text.toLowerCase(), out: number[] = [];
    for (let i = lower.indexOf(q); i >= 0 && out.length < 500; i = lower.indexOf(q, i + q.length)) out.push(i);
    return out;
  }, [text, query]);
  useEffect(() => setHitIdx(0), [query, materialId]);
  const jump = useCallback((i: number) => {
    if (!hits.length) return;
    const k = (i + hits.length) % hits.length;
    setHitIdx(k);
    setScrollTo({ offset: hits[k], nonce: Date.now() });
  }, [hits]);
  useEffect(() => { if (hits.length) jump(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [hits]);

  const highlights: Highlight[] = useMemo(() => {
    const list: Highlight[] = excerpts
      .filter((e) => e.material_id === materialId && e.char_start != null && e.char_end != null)
      .map((e) => ({ start: e.char_start!, end: e.char_end!, cls: hlClass(e) + (e.id === selectedPin ? " on" : ""), id: e.id }));
    if (hits.length && query.trim()) list.push({ start: hits[hitIdx], end: hits[hitIdx] + query.trim().length, cls: "hl-find" });
    return list;
  }, [excerpts, materialId, selectedPin, hits, hitIdx, query]);

  // ----- data -----
  const titleOf = (id: number | null) => order.find((n) => n.id === id)?.title ?? "—";
  const byNode = useMemo(() => {
    const map = new Map<number | null, Excerpt[]>();
    for (const e of excerpts) map.set(e.node_id, [...(map.get(e.node_id) ?? []), e]);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position || a.id - b.id);
    return map;
  }, [excerpts]);
  const mine = activeNode != null ? byNode.get(activeNode) ?? [] : [];
  const topics = mine.filter((e) => e.kind === "topic");
  const tasks = mine.filter((e) => e.kind === "task");
  const lost = byNode.get(null) ?? [];
  const topicChars = topics.reduce((s, e) => s + e.content.length, 0);
  const perMaterial = (id: number) => excerpts.filter((e) => e.material_id === id).length;

  async function pin(sel: TextSelection, kind: ExcerptKind, use_in: UseIn, hide: () => void) {
    if (activeNode == null) return;
    try {
      const e = await api.post<Excerpt>(`/courses/${course.id}/excerpts`, {
        node_id: activeNode, material_id: materialId, kind, use_in, content: sel.text, char_start: sel.start, char_end: sel.end,
      });
      await reload();
      hide();
      setSelectedPin(e.id);
      setToast({ text: `Закреплено за темой «${titleOf(activeNode)}»`, undoId: e.id });
    } catch (err: any) {
      onError(err.message);
    }
  }

  async function remove(id: number) {
    try { await api.del(`/excerpts/${id}`); await reload(); } catch (err: any) { onError(err.message); }
    setToast(null);
  }

  async function move(list: Excerpt[], i: number, dir: -1 | 1) {
    const ids = list.map((e) => e.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    try { await api.put(`/courses/${course.id}/excerpts/order`, { ids }); await reload(); } catch (err: any) { onError(err.message); }
  }

  async function createTopic() {
    const title = (newTopic ?? "").trim();
    if (!title) return;
    try {
      const r = await api.post<{ id: number }>(`/courses/${course.id}/nodes`, { title });
      await reloadCourse();
      setActiveNode(r.id);
      setNewTopic(null);
    } catch (err: any) {
      onError(err.message);
    }
  }

  function showInText(e: Excerpt) {
    if (e.material_id == null || e.char_start == null) return;
    setMaterialId(e.material_id);
    setSelectedPin(e.id);
    setScrollTo({ offset: e.char_start, nonce: Date.now() });
  }

  function onHighlightClick(id: number) {
    const e = excerpts.find((x) => x.id === id);
    if (!e) return;
    setSelectedPin(id);
    if (e.node_id != null) setActiveNode(e.node_id);
    setTimeout(() => document.getElementById(`pin-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
  }

  const card = (e: Excerpt, list: Excerpt[], i: number) => {
    const k = cardKind(e);
    const sameKind = list.filter((x) => x.kind === e.kind);
    const j = sameKind.findIndex((x) => x.id === e.id);
    return (
      <div key={e.id} id={`pin-${e.id}`} className={`pin-card ${e.id === selectedPin ? "on" : ""}`} onClick={() => setSelectedPin(e.id)}>
        <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
          <span className={`badge ${k.badge}`}><Icon name={k.icon} /> {k.label}</span>
          <b className="pin-title" title={e.title}>{e.title}</b>
          <span className="spacer" />
          <button className="icon-btn" title="Выше" disabled={j <= 0} onClick={(ev) => { ev.stopPropagation(); move(sameKind, j, -1); }}>↑</button>
          <button className="icon-btn" title="Ниже" disabled={j >= sameKind.length - 1} onClick={(ev) => { ev.stopPropagation(); move(sameKind, j, 1); }}>↓</button>
          <button className="icon-btn" title="Изменить" onClick={(ev) => { ev.stopPropagation(); setEditing(e); }}>✎</button>
          <button className="icon-btn" title="Убрать из обязательного" onClick={(ev) => { ev.stopPropagation(); remove(e.id); }}>✕</button>
        </div>
        <div className="pin-snippet">{e.content}</div>
        <div className="row small muted" style={{ gap: 10 }}>
          <span>{fmt(e.content.length)} зн.</span>
          {e.source && <span className="pin-src" title={e.source}>{e.source}</span>}
          <span className="spacer" />
          {e.material_id != null && e.char_start != null && (
            <button className="link-btn" onClick={(ev) => { ev.stopPropagation(); showInText(e); }}>показать в тексте <Icon name="external" /></button>
          )}
        </div>
      </div>
    );
  };

  if (!materials.length) {
    return (
      <div className="card">
        <div className="empty">
          <span className="icon-frame mb"><Icon name="file" /></span>
          <b>Сначала добавьте материалы</b>
          <p className="small" style={{ margin: "6px auto 14px", maxWidth: 440 }}>
            Здесь вы откроете загруженный PDF или Word, выделите нужные абзацы, главы или задачи и закрепите их за темой.
          </p>
          <button className="btn primary" onClick={() => goTo("materials")}>Добавить материалы</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pins-layout">
      {/* ---------- the material ---------- */}
      <div className="card pins-doc">
        <div className="row mb" style={{ gap: 8 }}>
          <select value={materialId ?? ""} onChange={(e) => setMaterialId(Number(e.target.value))} style={{ flex: "1 1 220px", width: "auto", minWidth: 0 }}>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>{m.filename}{perMaterial(m.id) ? ` · фрагментов: ${perMaterial(m.id)}` : ""}</option>
            ))}
          </select>
          <div className="find-box">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти в тексте…"
              onKeyDown={(e) => e.key === "Enter" && jump(hitIdx + (e.shiftKey ? -1 : 1))} />
            {query.trim().length >= 2 && (
              <span className="small muted find-count">{hits.length ? `${hitIdx + 1}/${hits.length}` : "нет"}</span>
            )}
          </div>
          <button className="btn sm" disabled={!hits.length} onClick={() => jump(hitIdx - 1)} title="Предыдущее совпадение">↑</button>
          <button className="btn sm" disabled={!hits.length} onClick={() => jump(hitIdx + 1)} title="Следующее совпадение">↓</button>
        </div>
        <div className="legend small muted">
          <span><i className="dot hl-topic" /> обязательная тема</span>
          <span><i className="dot hl-task" /> задание в практику</span>
          <span><i className="dot hl-exam" /> задание в экзамен</span>
        </div>
        {text == null ? <Loading text="Открываю материал…" /> : (
          <MaterialViewer
            text={text} highlights={highlights} scrollTo={scrollTo} onHighlightClick={onHighlightClick}
            toolbar={(sel, hide) => <SelectionToolbar sel={sel} topic={activeNode != null ? titleOf(activeNode) : null} limits={limits}
              onPin={(kind, use) => pin(sel, kind, use, hide)} onClose={hide} />}
          />
        )}
      </div>

      {/* ---------- what is pinned ---------- */}
      <div className="pins-side">
        <div className="card">
          <div className="eyebrow">Обязательное содержание</div>
          <p className="small muted" style={{ margin: "6px 0 12px" }}>
            Выделите в тексте слева абзацы, главы или задачи: <b>тема</b> ИИ обязательно разберёт на лекции, <b>задание</b> даст ученику
            почти без изменений. Всё остальное ИИ подберёт сам.
          </p>

          {order.length === 0 ? (
            <div className="alert warning small">
              Тем пока нет. Создайте тему здесь или{" "}
              <button className="link-btn" onClick={() => goTo("topics")}>постройте граф знаний</button>.
            </div>
          ) : (
            <label className="field">
              Закрепляю за темой
              <select value={activeNode ?? ""} onChange={(e) => setActiveNode(Number(e.target.value))}>
                {order.map((n, i) => {
                  const c = byNode.get(n.id)?.length ?? 0;
                  return <option key={n.id} value={n.id}>{i + 1}. {n.title}{c ? `  ·  ${c}` : ""}</option>;
                })}
              </select>
            </label>
          )}
          {newTopic == null ? (
            <button className="link-btn" style={{ marginTop: 8 }} onClick={() => setNewTopic("")}>＋ Новая тема</button>
          ) : (
            <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "nowrap" }}>
              <input autoFocus value={newTopic} placeholder="Название темы" onChange={(e) => setNewTopic(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createTopic(); if (e.key === "Escape") setNewTopic(null); }} />
              <button className="btn primary sm" disabled={!newTopic.trim()} onClick={createTopic}>Создать</button>
              <button className="btn sm ghost" onClick={() => setNewTopic(null)}>✕</button>
            </div>
          )}
        </div>

        {activeNode != null && (
          <div className="card pins-list">
            <h3 style={{ marginBottom: 2 }}>{titleOf(activeNode)}</h3>
            <div className="small muted mb" style={{ marginBottom: 12 }}>
              {topics.length + tasks.length === 0 ? "Пока ничего не закреплено — ИИ сам выберет материал по этой теме." : (
                <>{topics.length} {plural(topics.length, "тема", "темы", "тем")} · {tasks.length} {plural(tasks.length, "задание", "задания", "заданий")}</>
              )}
            </div>

            {topics.length > 0 && (
              <div className="col" style={{ gap: 8 }}>
                <div className="pins-group-title">
                  <span><Icon name="book" /> Обязательные темы</span>
                  <span className={topicChars > limits.theory_budget ? "warn" : ""}>{fmt(topicChars)} / {fmt(limits.theory_budget)} зн.</span>
                </div>
                {topicChars > limits.theory_budget && (
                  <div className="alert warning small">
                    В лекцию попадает до {fmt(limits.theory_budget)} знаков: фрагменты будут сокращены поровну. Оставьте самое важное или разделите на несколько тем.
                  </div>
                )}
                {topics.map((e, i) => card(e, topics, i))}
              </div>
            )}
            {tasks.length > 0 && (
              <div className="col" style={{ gap: 8, marginTop: topics.length ? 16 : 0 }}>
                <div className="pins-group-title"><span><Icon name="note" /> Обязательные задания</span><span>{tasks.length}</span></div>
                {tasks.map((e, i) => card(e, tasks, i))}
              </div>
            )}
          </div>
        )}

        {order.some((n) => n.id !== activeNode && (byNode.get(n.id)?.length ?? 0) > 0) && (
          <div className="card" style={{ padding: 16 }}>
            <div className="eyebrow mb" style={{ marginBottom: 8 }}>Другие темы</div>
            <div className="col" style={{ gap: 2 }}>
              {order.filter((n) => n.id !== activeNode && (byNode.get(n.id)?.length ?? 0) > 0).map((n) => {
                const list = byNode.get(n.id)!;
                const t = list.filter((e) => e.kind === "topic").length;
                return (
                  <button key={n.id} className="topic-row" onClick={() => setActiveNode(n.id)}>
                    <span className="t">{n.title}</span>
                    <span className="small muted">Тем: {t} · Заданий: {list.length - t}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {lost.length > 0 && (
          <div className="card" style={{ padding: 16, borderColor: "rgba(207,180,124,.35)" }}>
            <div className="eyebrow mb" style={{ color: "var(--warning)", marginBottom: 6 }}>Не привязано к теме</div>
            <p className="small muted" style={{ margin: "0 0 10px" }}>
              Тема этих фрагментов была удалена или граф перестроили. ИИ их пока не использует — привяжите к темам.
            </p>
            <div className="col" style={{ gap: 8 }}>
              {lost.map((e) => (
                <div key={e.id}>
                  {card(e, lost, 0)}
                  <select style={{ marginTop: 6 }} value="" disabled={!order.length}
                    onChange={async (ev) => {
                      try { await api.patch(`/excerpts/${e.id}`, { node_id: Number(ev.target.value) }); await reload(); } catch (err: any) { onError(err.message); }
                    }}>
                    <option value="">Привязать к теме…</option>
                    {order.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button className="link-btn" onClick={() => remove(toast.undoId)}>Отменить</button>
        </div>
      )}

      {editing && (
        <PinEditor excerpt={editing} order={order} limits={limits} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }} onError={onError} />
      )}
    </div>
  );
}

function SelectionToolbar({ sel, topic, limits, onPin, onClose }: {
  sel: TextSelection; topic: string | null; limits: ExcerptLimits; onPin: (kind: ExcerptKind, use: UseIn) => void; onClose: () => void;
}) {
  const len = sel.text.length;
  const tooBigTopic = len > limits.topic_chars, tooBigTask = len > limits.task_chars;
  const above = sel.rect.top > 96;
  const style = above
    ? { top: sel.rect.top - 10, left: Math.max(8, Math.min(sel.rect.left, window.innerWidth - 560)), transform: "translateY(-100%)" }
    : { top: sel.below.bottom + 10, left: Math.max(8, Math.min(sel.below.left, window.innerWidth - 560)) };
  const off = topic == null;
  return (
    <div className="sel-toolbar" style={style} onMouseDown={(e) => e.preventDefault()}>
      <div className="sel-info">
        {off ? "Сначала выберите тему справа" : <>→ <b>{topic}</b></>} · {fmt(len)} зн.
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" disabled={off || tooBigTopic} title={tooBigTopic ? `Не больше ${fmt(limits.topic_chars)} знаков` : "ИИ разберёт это на лекции почти дословно"}
          onClick={() => onPin("topic", "")}><Icon name="book" /> Обязательная тема</button>
        <button className="btn sm" disabled={off || tooBigTask} title={tooBigTask ? `Задание не больше ${fmt(limits.task_chars)} знаков` : "Ученик получит это задание в практике"}
          onClick={() => onPin("task", "practice")}><Icon name="note" /> Задание в практику</button>
        <button className="btn sm" disabled={off || tooBigTask} title={tooBigTask ? `Задание не больше ${fmt(limits.task_chars)} знаков` : "Это задание попадёт на экзамен"}
          onClick={() => onPin("task", "exam")}><Icon name="flag" /> В экзамен</button>
        <button className="icon-btn" title="Снять выделение" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}

function PinEditor({ excerpt, order, limits, onClose, onSaved, onError }: {
  excerpt: Excerpt; order: TopicNode[]; limits: ExcerptLimits; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [title, setTitle] = useState(excerpt.title);
  const [kind, setKind] = useState<ExcerptKind>(excerpt.kind);
  const [useIn, setUseIn] = useState<UseIn>(excerpt.use_in || "practice");
  const [nodeId, setNodeId] = useState<number | null>(excerpt.node_id);
  const [content, setContent] = useState(excerpt.content);
  const [busy, setBusy] = useState(false);
  const limit = kind === "task" ? limits.task_chars : limits.topic_chars;
  const over = content.length > limit;
  return (
    <Modal title="Обязательный фрагмент" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={busy || over || !content.trim() || nodeId == null} onClick={async () => {
          setBusy(true);
          try {
            await api.patch(`/excerpts/${excerpt.id}`, { title, kind, use_in: kind === "task" ? useIn : "", node_id: nodeId, content });
            onSaved();
          } catch (e: any) { onError(e.message); setBusy(false); }
        }}>{busy ? <span className="spinner" /> : "Сохранить"}</button>
      </>}>
      <div className="col">
        <div className="field">
          Что это
          <div className="tabs">
            <button className={kind === "topic" ? "active" : ""} onClick={() => setKind("topic")}><Icon name="book" /> Обязательная тема</button>
            <button className={kind === "task" ? "active" : ""} onClick={() => setKind("task")}><Icon name="note" /> Обязательное задание</button>
          </div>
        </div>
        {kind === "task" && (
          <div className="field">
            Где выдать
            <div className="tabs">
              <button className={useIn === "practice" ? "active" : ""} onClick={() => setUseIn("practice")}>В практике</button>
              <button className={useIn === "exam" ? "active" : ""} onClick={() => setUseIn("exam")}>На экзамене</button>
            </div>
          </div>
        )}
        <label className="field">
          Тема курса
          <select value={nodeId ?? ""} onChange={(e) => setNodeId(e.target.value ? Number(e.target.value) : null)}>
            {nodeId == null && <option value="">— не привязано —</option>}
            {order.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          </select>
        </label>
        <label className="field">Название<input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field">
          <span className="row" style={{ gap: 8 }}>
            Текст, который получит ИИ
            <span className="spacer" />
            <span className={over ? "warn-text" : "faint"}>{fmt(content.length)} / {fmt(limit)}</span>
          </span>
          <textarea rows={11} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          Можно поправить текст: убрать номера страниц, склеенные переносы, лишнее. ИИ сохранит вашу формулировку{kind === "task" ? ", а решение, критерии и подсказки добавит сам" : ""}.
        </p>
      </div>
    </Modal>
  );
}
