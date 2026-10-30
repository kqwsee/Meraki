import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import MemoryGraph from "../components/MemoryGraph";
import { ErrorBox, Loading, Modal, Progress } from "../components/ui";
import { useKnowledgeGraph, type Note, type ProfileT } from "../profile/knowledgeGraph";

const FLAG_NAMES: Record<string, string> = { paste: "вставки", burst: "аномально быстрый ввод", bulk_insert: "крупные вставки", tab_away: "уходы со вкладки" };

/** Info panels that used to fill the profile page. They now live behind square icon tiles; tapping
 * a tile opens that section's contents in a modal, so the page stays short. */
type ProfileSection = "talents" | "mind" | "courses" | "writing" | "meta" | "autonomy";
const PROFILE_SECTIONS: { id: ProfileSection; title: string; icon: string }[] = [
  { id: "talents", title: "Таланты", icon: "🏆" },
  { id: "mind", title: "Склад ума", icon: "🧠" },
  { id: "courses", title: "Курсы", icon: "📚" },
  { id: "writing", title: "Как ты пишешь и думаешь", icon: "✍️" },
  { id: "meta", title: "Метапознание и память", icon: "🎯" },
  { id: "autonomy", title: "Самостоятельность", icon: "🧭" },
];

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

  const load = useCallback(async () => {
    try {
      setP(await api.get<ProfileT>("/profile"));
      setNotes(await api.get<Note[]>("/notes"));
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const graph = useKnowledgeGraph(p, notes);

  if (!p) return error ? <ErrorBox error={error} /> : <Loading />;
  const wp = p.integrity.writing_profile ?? {};
  const cal = p.integrity.calibration;

  /** "What shaped this section" block: the AI's note about the most influential learning moments
   * when the profile has one, otherwise the static hints about where the data comes from. */
  const factors = (id: ProfileSection, fallback: ReactNode) => {
    const note = p.section_notes?.[id]?.trim();
    return (
      <div className={`section-factors ${note ? "ai" : ""}`}>
        <b>{note ? "ИИ-наставник: что сильнее всего повлияло" : "Основные моменты, которые повлияли:"}</b>
        {note ? <Markdown>{note}</Markdown> : fallback}
      </div>
    );
  };

  /** Contents of the selected profile section, shown inside the section modal. Arrow const (not a
   * hoisted function) so TypeScript keeps the `p` non-null narrowing from the guard above. */
  const sectionBody = (id: ProfileSection) => {
    switch (id) {
      case "talents":
        return (
          <>
            {p.talents ? <Markdown>{p.talents}</Markdown> : <p className="muted">Профиль сформируется после первой пройденной темы.</p>}
            {p.strengths.length > 0 && (<><h3 className="mt">Сильные стороны</h3><ul>{p.strengths.map((s) => <li key={s}>{s}</li>)}</ul></>)}
            {p.growth_areas.length > 0 && (<><h3>Зоны роста</h3><ul>{p.growth_areas.map((s) => <li key={s}>{s}</li>)}</ul></>)}
            {p.profile_updated_at && <div className="small muted">обновлён {new Date(p.profile_updated_at + "Z").toLocaleString()}</div>}
          </>
        );
      case "mind":
        return (
          <>
            {factors("mind", (
              <ul>
                <li>уровни прологов, стиль мышления и интересы, которые наставник отмечает в темах;</li>
                <li>оценки практики, экзаменов и проверок понимания после экзамена;</li>
                <li>факты и итоги сессий из долговременной памяти наставника.</li>
              </ul>
            ))}
            {Object.keys(p.mind_profile).length ? (
              <>
                <p className="small">
                  <b>Ведущие направления:</b>{" "}
                  {Object.entries(p.mind_profile).sort((a, b) => b[1] - a[1]).slice(0, 3)
                    .map(([k, v]) => `${p.mind_axes[k] ?? k} — ${Math.round(v * 100)}%`).join(", ")}
                </p>
                <div className="bars">
                  {Object.entries(p.mind_axes).map(([k, label]) => (
                    <div key={k} className="bar-row">
                      <span>{label}</span>
                      <Progress value={(p.mind_profile[k] ?? 0) * 100} />
                      <span className="small muted">{Math.round((p.mind_profile[k] ?? 0) * 100)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="muted">Появится после первой темы.</p>}
          </>
        );
      case "courses":
        return p.courses.length ? (
          <>
            {p.courses.map((c) => (
              <div key={c.id} className="mb">
                <div className="row"><Link to={`/courses/${c.id}`}>{c.title}</Link><span className="spacer" /><span className="small muted">{Math.round(c.progress)}%</span></div>
                <Progress value={c.progress} />
              </div>
            ))}
          </>
        ) : <p className="muted">Пока нет курсов.</p>;
      case "writing":
        return (
          <>
            {factors("writing", (
              <ul>
                <li>скорость набора по сравнению с твоей обычной;</li>
                <li>длина фрагментов между паузами ≥2 с — беглость;</li>
                <li>частота правок и удалений на знак — переформулирование по ходу;</li>
                <li>доля пауз в начале предложений — обдумываешь заранее или по ходу письма.</li>
              </ul>
            ))}
            <p className="small muted">По ритму ввода: паузы от 2 с — время на обдумывание, правки — переформулирование по ходу. Это не оценка, а описание стиля.</p>
            {p.integrity.writing_traits.length ? <ul>{p.integrity.writing_traits.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted small">Данных пока мало.</p>}
            <table className="md small" style={{ width: "100%" }}>
              <tbody>
                <tr><td>Обычная скорость</td><td>{p.integrity.typing_cpm ? `${Math.round(p.integrity.typing_cpm)} зн/мин` : "—"}</td></tr>
                <tr><td>Знаков между паузами</td><td>{wp.burst_chars != null ? Math.round(wp.burst_chars) : "—"}</td></tr>
                <tr><td>Правок на 100 знаков</td><td>{wp.revision_rate != null ? (wp.revision_rate * 100).toFixed(1) : "—"}</td></tr>
                <tr><td>Пауз ≥2 с на 100 знаков</td><td>{wp.pause_rate != null ? wp.pause_rate.toFixed(1) : "—"}</td></tr>
                <tr><td>Паузы перед предложениями</td><td>{wp.sentence_pause_share != null ? `${Math.round(wp.sentence_pause_share * 100)}%` : "—"}</td></tr>
              </tbody>
            </table>
          </>
        );
      case "meta":
        return (
          <>
            {factors("meta", (
              <ul>
                <li>уверенность 1–5, которую ты указываешь перед ответом, против фактической оценки задания;</li>
                <li>карточки интервального повторения: сколько их, сколько повторений сделано и какая доля материала удерживается.</li>
              </ul>
            ))}
            {cal ? (
              <>
                <div className="bars">
                  <div className="bar-row"><span>Уверенность</span><Progress value={cal.confidence * 100} /><span className="small">{Math.round(cal.confidence * 100)}</span></div>
                  <div className="bar-row"><span>Точность</span><Progress value={cal.accuracy * 100} /><span className="small">{Math.round(cal.accuracy * 100)}</span></div>
                </div>
                <p className="small muted mt">
                  {cal.confidence - cal.accuracy > 0.15 ? "Ты склонен(на) переоценивать решения — перед сдачей проверяй себя." :
                    cal.accuracy - cal.confidence > 0.15 ? "Ты решаешь лучше, чем думаешь — доверяй себе больше." : "Уверенность хорошо совпадает с результатом."}
                  {" "}({cal.samples} заданий)
                </p>
              </>
            ) : <p className="small muted">Калибровка уверенности появится после сдачи практических заданий.</p>}
            <h3 className="mt">Повторение</h3>
            <p className="small">
              Карточек: {p.reviews.cards}, к повторению: <b>{p.reviews.due}</b>, повторений: {p.reviews.reviews}
              {p.reviews.retention != null && <>, удержание: <b>{Math.round(p.reviews.retention * 100)}%</b></>}
            </p>
            {p.reviews.due > 0 && <Link className="btn sm primary" to="/reviews">Повторить</Link>}
          </>
        );
      case "autonomy":
        return (
          <>
            {factors("autonomy", (
              <ul>
                <li>вставки из буфера и крупные нестандартные вставки на практике и экзамене;</li>
                <li>серии набора заметно быстрее твоей обычной скорости без пауз и правок;</li>
                <li>уход из вкладки во время экзамена;</li>
                <li>объём собственного набора — сегменты ввода за последние 30 дней.</li>
              </ul>
            ))}
            <p className="small muted">На практике это только записывается и влияет на состав экзамена, а на экзамене — повод для вопросов по решению.</p>
            <p className="small">Событий записано: {p.integrity.total_events}. За 30 дней: сегментов набора {p.integrity.typed_segments_30d}, вставок {p.integrity.pastes_30d}.</p>
            {Object.keys(p.integrity.flags).length ? (
              <ul className="small">{Object.entries(p.integrity.flags).map(([k, v]) => <li key={k}>{FLAG_NAMES[k] ?? k}: {v}</li>)}</ul>
            ) : <p className="small">Сигналов нет.</p>}
          </>
        );
    }
  };

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
        <Modal title={PROFILE_SECTIONS.find((s) => s.id === section)!.title} onClose={() => setSection(null)}>
          {sectionBody(section)}
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
