import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/Icon";
import ThemePicker from "../components/ThemePicker";
import Markdown from "../components/Markdown";
import MemoryGraph from "../components/MemoryGraph";
import { ErrorBox, Loading, Modal } from "../components/ui";
import { useKnowledgeGraph, type Note, type ProfileT } from "../profile/knowledgeGraph";
import ProfileSectionBody, { PROFILE_SECTIONS, type ProfileSection } from "../profile/ProfileSectionBody";
import type { TalentOverviewT } from "../profile/talents";

const MEMORY_ROOMS: Record<string, string> = { sessions: "Учебные сессии", profile: "Анализ профиля" };

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
  const refreshTimer = useRef<number>();
  const [edit, setEdit] = useState<Partial<Note> | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Note | null>(null);
  const [section, setSection] = useState<ProfileSection | null>(null);
  const [talentOverview, setTalentOverview] = useState<TalentOverviewT | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, noteList] = await Promise.all([api.get<ProfileT>("/profile"), api.get<Note[]>("/notes")]);
      setP(profile);
      setNotes(noteList);
      setError(null);
      api.get<TalentOverviewT>("/profile/talents").then(setTalentOverview).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить профиль");
    }
  }, []);
  useEffect(() => {
    load();
    return () => window.clearTimeout(refreshTimer.current);
  }, [load]);

  // Keep the talent summary current while the learner talks to the tutor in another tab.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        api.get<TalentOverviewT>("/profile/talents").then(setTalentOverview).catch(() => undefined);
      }
    }, 5000);
    return () => window.clearInterval(t);
  }, []);

  const graph = useKnowledgeGraph(p, notes);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      await api.post("/profile/refresh");
      refreshTimer.current = window.setTimeout(async () => {
        await load();
        setRefreshing(false);
      }, 15000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось обновить профиль");
      setRefreshing(false);
    }
  }

  function openEditor(note: Partial<Note>) {
    setNoteError(null);
    setViewing(null);
    setEdit(note);
  }

  async function saveNote(event: React.FormEvent) {
    event.preventDefault();
    if (!edit?.title?.trim() || saving) return;
    setSaving(true);
    setNoteError(null);
    try {
      const data = { title: edit.title, content: edit.content };
      if (edit.id) await api.patch(`/notes/${edit.id}`, data);
      else await api.post("/notes", data);
      setEdit(null);
      await load();
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : "Не удалось сохранить заметку");
    } finally {
      setSaving(false);
    }
  }

  async function deleteNote(id: number) {
    if (!confirm("Удалить заметку?")) return;
    try {
      await api.del(`/notes/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить заметку");
    }
  }

  /** Notes as an Obsidian vault: the server builds a zip of markdown files whose [[links]] keep the
   * note → course/topic connections, so the graph view there matches Meraki's knowledge map. */
  async function exportNotes() {
    setExporting(true);
    setError(null);
    try {
      await api.download("/notes/export", "meraki-obsidian.zip");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось экспортировать заметки");
    } finally {
      setExporting(false);
    }
  }

  if (!p) return error ? <ErrorBox error={error} /> : <Loading text="Загружаем профиль" />;
  const initials = p.user.name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toLocaleUpperCase("ru");
  const memory = p.memory;
  const sectionMeta = PROFILE_SECTIONS.find(({ id }) => id === section);

  return (
    <div className="profile">
      <header className="workspace-head profile-head">
        <div className="profile-identity">
          <span className="profile-avatar" aria-hidden="true">{initials || <Icon name="user" />}</span>
          <div className="profile-heading">
            <h1>{p.user.name}</h1>
            <p>{p.user.email} · {p.user.role === "author" ? "Автор курсов" : "Ученик"}</p>
          </div>
        </div>
        <div className="profile-refresh">
          <button className="btn" disabled={refreshing} onClick={refresh}>
            {refreshing ? <><span className="spinner" /> Идёт анализ</> : <><Icon name="refresh" /> Обновить профиль</>}
          </button>
          {p.profile_updated_at && <small>Обновлён {new Date(p.profile_updated_at + "Z").toLocaleDateString("ru-RU")}</small>}
        </div>
      </header>

      <ErrorBox error={error} />

      <div className="profile-overview">
        <section className="card profile-panel profile-map" aria-labelledby="profile-map-title">
          <header className="profile-panel-head">
            <div>
              <h2 id="profile-map-title">Карта знаний</h2>
              <p>Связи между курсами, темами и заметками</p>
            </div>
            <Link className="btn sm" to="/profile/graph"><Icon name="expand" /> На весь экран</Link>
          </header>
          <div className="profile-map-body">
            {graph.nodes.length > 0 ? (
              <MemoryGraph nodes={graph.nodes} links={graph.links}
                onNodeClick={(n) => { if (n.kind === "course") navigate(`/courses/${n.id.split(":")[1]}`); }} />
            ) : (
              <div className="profile-map-empty">
                <span className="icon-frame"><Icon name="graph" /></span>
                <strong>Карта пока пуста</strong>
                <p>Здесь появятся курсы, освоенные темы и заметки.</p>
                <Link className="icon-label" to="/courses">Выбрать курс <Icon name="arrowRight" /></Link>
              </div>
            )}
          </div>
        </section>
        <section className="card profile-panel" aria-labelledby="profile-sections-title">
          <header className="profile-panel-head"><h2 id="profile-sections-title">Разделы профиля</h2></header>
          <div className="profile-index">
            {PROFILE_SECTIONS.map((s) => (
              <button key={s.id} className="profile-index-row" aria-haspopup="dialog" onClick={() => setSection(s.id)}>
                <span className="icon-frame"><Icon name={s.icon} /></span>
                <span>{s.title}</span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
        </section>
      </div>

      <ThemePicker />

      <section className="card profile-panel" aria-labelledby="profile-notes-title">
        <header className="profile-panel-head">
          <h2 id="profile-notes-title">Заметки</h2>
          <div className="row">
            <button className="btn sm" onClick={exportNotes} disabled={exporting || notes.length === 0}
              title="Скачать все заметки как хранилище Obsidian со связями">
              {exporting ? <><span className="spinner" /> Экспорт</> : <><Icon name="download" /> Экспорт</>}
            </button>
            <button className="btn sm" onClick={() => openEditor({ title: "", content: "" })}><Icon name="plus" /> Заметка</button>
          </div>
        </header>
        {notes.length ? (
          <div className="profile-note-list">
            {notes.map((n) => (
              <article key={n.id} className="profile-note">
                <div className="profile-note-copy">
                  <div className="row">
                    <button className="profile-note-title" onClick={() => setViewing(n)}>
                      <Icon name="file" /> <span>{n.title}</span>
                    </button>
                    {n.source === "assistant" && <span className="small muted">От наставника</span>}
                  </div>
                  <p className="small muted">{noteExcerpt(n.content) || "Пустая заметка"}</p>
                </div>
                <div className="row">
                  <button className="btn sm ghost" onClick={() => openEditor(n)}>Изменить</button>
                  <button className="btn sm danger" onClick={() => deleteNote(n.id)}>Удалить</button>
                </div>
              </article>
            ))}
          </div>
        ) : <div className="profile-empty"><span className="icon-frame"><Icon name="note" /></span>
          <p>Заметок пока нет. Здесь будут твои записи и конспекты лекций от наставника.</p>
        </div>}
      </section>

      <section className="card profile-panel" aria-labelledby="profile-memory-title">
        <header className="profile-panel-head">
          <div>
            <h2 id="profile-memory-title">Память наставника</h2>
            <p>Итоги сессий и тем, которые наставник учитывает в следующих занятиях</p>
          </div>
          <span className={`memory-status ${memory.status.ready ? "ready" : ""}`}>
            {memory.status.backend === "mempalace" ? "MemPalace" : "SQLite"} · {memory.status.ready ? "Работает" : "Недоступно"}
          </span>
        </header>
        {!memory.status.ready && memory.status.error && <p className="small muted">{memory.status.error}</p>}
        {memory.entries.length ? memory.entries.map((m, i) => (
          <div key={i} className="profile-entry">
            <div className="muted">
              <time dateTime={m.created_at + "Z"}>{new Date(m.created_at + "Z").toLocaleString("ru-RU")}</time>
              {" · "}{m.room.endsWith("_dialogs") ? "Дословный диалог" : MEMORY_ROOMS[m.room] ?? m.room}
            </div>
            {m.content.length > 400 ? (
              <details>
                <summary>{m.content.slice(0, 220)}…</summary>
                <div>{m.content}</div>
              </details>
            ) : (
              m.content
            )}
          </div>
        )) : <div className="profile-empty"><span className="icon-frame"><Icon name="history" /></span>
          <p>Записей пока нет</p>
        </div>}
      </section>

      {sectionMeta && (
        <Modal
          title={sectionMeta.title}
          onClose={() => setSection(null)}
          action={
            <Link className="btn sm ghost" to={sectionMeta.id === "talents" ? "/profile/talents" : `/profile/sections/${sectionMeta.id}`}>
              Подробнее <Icon name="arrowRight" />
            </Link>
          }
        >
          <ProfileSectionBody p={p} section={sectionMeta.id} talentOverview={talentOverview} />
        </Modal>
      )}

      {(viewing || edit) && (
        <Modal wide
          title={viewing ? viewing.title : edit?.id ? "Редактирование заметки" : "Новая заметка"}
          onClose={() => {
            if (saving) return;
            setViewing(null);
            setEdit(null);
          }}
          footer={viewing && <>
            <button className="btn" onClick={() => setViewing(null)}>Закрыть</button>
            <button className="btn primary" onClick={() => openEditor(viewing)}>Изменить</button>
          </>}
        >
          {viewing && <div className="note-view"><Markdown>{viewing.content}</Markdown></div>}
          {edit && (
            <form className="col note-edit" onSubmit={saveNote}>
              <ErrorBox error={noteError} />
              <label className="field">
                Заголовок
                <input value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required disabled={saving} />
              </label>
              <label className="field note-content-field">
                Текст заметки
                <textarea value={edit.content ?? ""} onChange={(e) => setEdit({ ...edit, content: e.target.value })}
                  placeholder="Поддерживается Markdown" disabled={saving} />
              </label>
              <div className="row note-edit-actions">
                <button type="button" className="btn" disabled={saving} onClick={() => setEdit(null)}>Отмена</button>
                <button className="btn primary" disabled={saving || !edit.title?.trim()}>{saving ? "Сохраняем" : "Сохранить"}</button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
