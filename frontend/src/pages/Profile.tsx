import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import { ErrorBox, Loading, Modal, Progress } from "../components/ui";

type ProfileT = {
  user: { name: string; email: string; role: string };
  courses: { id: number; title: string; domain: string; progress: number }[];
  talents: string;
  mind_profile: Record<string, number>;
  mind_axes: Record<string, string>;
  strengths: string[];
  growth_areas: string[];
  profile_updated_at: string | null;
  integrity: {
    typing_cpm: number | null; flags: Record<string, number>; pastes_30d: number; typed_segments_30d: number; total_events: number;
    writing_profile: Record<string, number>; writing_traits: string[];
    calibration: { samples: number; confidence: number; accuracy: number } | null;
  };
  reviews: { cards: number; due: number; reviews: number; retention: number | null };
  memory: { status: { backend: string; ready: boolean; error?: string }; entries: { room: string; content: string; created_at: string }[]; facts: any[] };
};
type Note = { id: number; title: string; content: string; source: string; updated_at: string };

const FLAG_NAMES: Record<string, string> = { paste: "вставки", burst: "аномально быстрый ввод", bulk_insert: "крупные вставки", tab_away: "уходы со вкладки" };

export default function Profile() {
  const [p, setP] = useState<ProfileT | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [edit, setEdit] = useState<Partial<Note> | null>(null);

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

  if (!p) return error ? <ErrorBox error={error} /> : <Loading />;
  const wp = p.integrity.writing_profile ?? {};
  const cal = p.integrity.calibration;

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

      <div className="grid grid-2">
        <div className="card">
          <h2>Таланты</h2>
          {p.talents ? <Markdown>{p.talents}</Markdown> : <p className="muted">Профиль сформируется после первой пройденной темы.</p>}
          {p.strengths.length > 0 && (<><h3 className="mt">Сильные стороны</h3><ul>{p.strengths.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {p.growth_areas.length > 0 && (<><h3>Зоны роста</h3><ul>{p.growth_areas.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {p.profile_updated_at && <div className="small muted">обновлён {new Date(p.profile_updated_at + "Z").toLocaleString()}</div>}
        </div>

        <div className="card">
          <h2>Склад ума</h2>
          {Object.keys(p.mind_profile).length ? (
            <div className="bars">
              {Object.entries(p.mind_axes).map(([k, label]) => (
                <div key={k} className="bar-row">
                  <span>{label}</span>
                  <Progress value={(p.mind_profile[k] ?? 0) * 100} />
                  <span className="small muted">{Math.round((p.mind_profile[k] ?? 0) * 100)}</span>
                </div>
              ))}
            </div>
          ) : <p className="muted">Появится после первой темы.</p>}
        </div>

        <div className="card">
          <h2>Курсы</h2>
          {p.courses.length ? p.courses.map((c) => (
            <div key={c.id} className="mb">
              <div className="row"><Link to={`/courses/${c.id}`}>{c.title}</Link><span className="spacer" /><span className="small muted">{Math.round(c.progress)}%</span></div>
              <Progress value={c.progress} />
            </div>
          )) : <p className="muted">Пока нет курсов.</p>}
        </div>

        <div className="card">
          <h2>Как ты пишешь и думаешь</h2>
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
        </div>

        <div className="card">
          <h2>Метапознание и память</h2>
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
        </div>

        <div className="card">
          <h2>Самостоятельность</h2>
          <p className="small muted">На практике это только записывается и влияет на состав экзамена, а на экзамене — повод для вопросов по решению.</p>
          <p className="small">Событий записано: {p.integrity.total_events}. За 30 дней: сегментов набора {p.integrity.typed_segments_30d}, вставок {p.integrity.pastes_30d}.</p>
          {Object.keys(p.integrity.flags).length ? (
            <ul className="small">{Object.entries(p.integrity.flags).map(([k, v]) => <li key={k}>{FLAG_NAMES[k] ?? k}: {v}</li>)}</ul>
          ) : <p className="small">Сигналов нет.</p>}
        </div>
      </div>

      <div className="card mt">
        <div className="row"><h2 style={{ margin: 0 }}>Заметки</h2><span className="spacer" /><button className="btn sm" onClick={() => setEdit({ title: "", content: "" })}>+ Заметка</button></div>
        {notes.length ? (
          <div className="grid grid-2 mt">
            {notes.map((n) => (
              <div key={n.id} className="card" style={{ margin: 0 }}>
                <div className="row"><b style={{ flex: 1 }}>{n.title}</b>{n.source === "assistant" && <span className="badge accent">наставник</span>}</div>
                <div style={{ maxHeight: 220, overflow: "auto" }} className="small"><Markdown>{n.content}</Markdown></div>
                <div className="row mt">
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
        {p.memory.facts.length > 0 && (
          <>
            <h3>Факты</h3>
            <div className="row" style={{ gap: 4 }}>
              {p.memory.facts.slice(0, 30).map((f: any, i) => (
                <span key={i} className="badge">{f.predicate ?? f.relation ?? ""}: {f.object ?? f.target ?? JSON.stringify(f)}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {edit && (
        <Modal title={edit.id ? "Заметка" : "Новая заметка"} onClose={() => setEdit(null)}
          footer={<>
            <button className="btn" onClick={() => setEdit(null)}>Отмена</button>
            <button className="btn primary" disabled={!edit.title?.trim()} onClick={async () => {
              if (edit.id) await api.patch(`/notes/${edit.id}`, { title: edit.title, content: edit.content });
              else await api.post("/notes", { title: edit.title, content: edit.content });
              setEdit(null);
              load();
            }}>Сохранить</button>
          </>}>
          <div className="col">
            <input value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Заголовок" />
            <textarea rows={10} value={edit.content ?? ""} onChange={(e) => setEdit({ ...edit, content: e.target.value })} placeholder="Markdown поддерживается" />
          </div>
        </Modal>
      )}
    </div>
  );
}
