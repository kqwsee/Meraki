import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import MemoryGraph from "../components/MemoryGraph";
import { ErrorBox, Loading, Modal } from "../components/ui";
import { useKnowledgeGraph, type Note, type ProfileT } from "../profile/knowledgeGraph";
import ProfileSectionBody, { PROFILE_SECTIONS, type ProfileSection } from "../profile/ProfileSectionBody";
import type { TalentOverviewT } from "../profile/talents";

/** One-line teaser for the notes grid: drops the Markdown scaffolding (code fences, links, heading
 * and list markers) and keeps the first ~160 characters. The full text opens in the note viewer. */
function noteExcerpt(md: string, limit = 160): string {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

export default function Profile() {
  const navigate = useNavigate();
  const [p, setP] = useState<ProfileT | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [edit, setEdit] = useState<Partial<Note> | null>(null);
  const [viewing, setViewing] = useState<Note | null>(null);
  const [section, setSection] = useState<ProfileSection | null>(null);
  const [talentOverview, setTalentOverview] = useState<TalentOverviewT | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, noteList] = await Promise.all([api.get<ProfileT>("/profile"), api.get<Note[]>("/notes")]);
      setP(profile);
      setNotes(noteList);
      api.get<TalentOverviewT>("/profile/talents").then(setTalentOverview).catch(() => undefined);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // the talent tiles keep moving while the learner talks to the tutor in another tab
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        api.get<TalentOverviewT>("/profile/talents").then(setTalentOverview).catch(() => undefined);
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  const graph = useKnowledgeGraph(p, notes);

  if (!p) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div>
      <div className="row mb">
        <div>
          <h1 style={{ margin: 0 }}>{p.user.name}</h1>
          <div className="muted small">{p.user.email} · {p.user.role === "author" ? "автор курсов" : "ученик"}</div>
        </div>
        <span className="spacer" />
        <button className="btn" disabled={refreshing} onClick={async () => {
          setRefreshing(true);
          await api.post("/profile/refresh");
          setTimeout(async () => { await load(); setRefreshing(false); }, 15000);
        }}>{refreshing ? <><span className="spinner" /> ИИ анализирует…</> : "↻ Обновить профиль"}</button>
      </div>

      <div className="card mt">
        <div className="row"><h2 style={{ margin: 0 }}>Карта знаний</h2><span className="spacer" />
          <Link className="btn sm ghost" to="/profile/graph">⤢ На весь экран</Link>
        </div>
        {graph.nodes.length > 0 ? (
          <MemoryGraph nodes={graph.nodes} links={graph.links}
            onNodeClick={(n) => { if (n.kind === "course") navigate(`/courses/${n.id.split(":")[1]}`); }} />
        ) : <p className="muted">Появится, когда наберётся прогресс, факты памяти или заметки.</p>}
      </div>

      <div className="card mt section-picker">
        <h2>Разделы профиля</h2>
        <p className="small muted">Нажмите на плитку — содержимое раздела откроется в окне.</p>
        <div className="section-tiles">
          {PROFILE_SECTIONS.map((s) => (
            <button key={s.id} className="section-tile" onClick={() => setSection(s.id)}>
              <span className="section-tile-icon" aria-hidden="true">{s.icon}</span>
              <span className="section-tile-title">{s.title}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card mt">
        <div className="row"><h2 style={{ margin: 0 }}>Заметки</h2><span className="spacer" /><button className="btn sm" onClick={() => setEdit({ title: "", content: "" })}>+ Заметка</button></div>
        {notes.length ? (
          <div className="grid grid-2 mt">
            {notes.map((n) => (
              <div key={n.id} className="card note-card" style={{ margin: 0 }} role="button" tabIndex={0}
                onClick={() => setViewing(n)}
                onKeyDown={(e) => {
                  // only when the card itself is focused, not a button inside it
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setViewing(n);
                  }
                }}>
                <div className="row"><b style={{ flex: 1 }}>{n.title}</b>{n.source === "assistant" && <span className="badge accent">наставник</span>}</div>
                <p className="small muted note-excerpt">{noteExcerpt(n.content) || "Пустая заметка"}</p>
                <div className="row mt" onClick={(e) => e.stopPropagation()}>
                  <button className="btn sm" onClick={() => setEdit(n)}>Изменить</button>
                  <button className="btn sm danger" onClick={async () => { if (confirm("Удалить заметку?")) { await api.del(`/notes/${n.id}`); load(); } }}>Удалить</button>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted mt">Заметок пока нет. Конспекты лекций наставник добавит сюда сам.</p>}
      </div>

      <div className="card mt">
        <h2>Долговременная память наставника</h2>
        <p className="small muted">
          Хранилище: {p.memory.status.backend === "mempalace" ? "MemPalace" : "SQLite"} — {p.memory.status.ready ? "работает" : `недоступно (${p.memory.status.error || "запуск…"})`}.
          Итоги сессий и тем записываются сюда; наставник обращается к ним в начале этапов.
        </p>
        {p.memory.entries.length ? p.memory.entries.map((m, i) => (
          <div key={i} className="mb small" style={{ borderLeft: "3px solid var(--accent-soft)", paddingLeft: 10 }}>
            <div className="muted">
              {new Date(m.created_at + "Z").toLocaleString()} · {m.room.endsWith("_dialogs") ? "дословный диалог" : m.room}
            </div>
            {m.content.length > 400 ? (
              <details>
                <summary style={{ cursor: "pointer" }}>{m.content.slice(0, 220)}…</summary>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </details>
            ) : (
              m.content
            )}
          </div>
        )) : <p className="muted small">Пока пусто.</p>}
      </div>

      {section && (
        <Modal
          title={PROFILE_SECTIONS.find((s) => s.id === section)!.title}
          onClose={() => setSection(null)}
          action={
            <Link className="btn sm ghost" to={section === "talents" ? "/profile/talents" : `/profile/sections/${section}`}>
              Подробнее →
            </Link>
          }
        >
          <ProfileSectionBody p={p} section={section} talentOverview={talentOverview} />
        </Modal>
      )}

      {viewing && (
        <Modal wide title={viewing.title} onClose={() => setViewing(null)}
          footer={<>
            <button className="btn" onClick={() => setViewing(null)}>Закрыть</button>
            <button className="btn primary" onClick={() => { setEdit(viewing); setViewing(null); }}>Изменить</button>
          </>}>
          <div className="note-view"><Markdown>{viewing.content}</Markdown></div>
        </Modal>
      )}

      {edit && (
        <Modal wide title={edit.id ? "Заметка" : "Новая заметка"} onClose={() => setEdit(null)}
          footer={<>
            <button className="btn" onClick={() => setEdit(null)}>Отмена</button>
            <button className="btn primary" disabled={!edit.title?.trim()} onClick={async () => {
              if (edit.id) await api.patch(`/notes/${edit.id}`, { title: edit.title, content: edit.content });
              else await api.post("/notes", { title: edit.title, content: edit.content });
              setEdit(null);
              load();
            }}>Сохранить</button>
          </>}>
          <div className="col note-edit">
            <input value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Заголовок" />
            <textarea value={edit.content ?? ""} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Markdown поддерживается" />
          </div>
        </Modal>
      )}
    </div>
  );
}
