import { Icon } from "../components/Icon";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import Markdown from "../components/Markdown";
import { Progress } from "../components/ui";
import type { ProfileT } from "./knowledgeGraph";
import { signed, type TalentOverviewT } from "./talents";

export type ProfileSection = "talents" | "mind" | "courses" | "writing" | "meta" | "autonomy";

export const PROFILE_SECTIONS: { id: ProfileSection; title: string; icon: string }[] = [
  { id: "talents", title: "Таланты", icon: "trophy" },
  { id: "mind", title: "Склад ума", icon: "brain" },
  { id: "courses", title: "Курсы", icon: "book" },
  { id: "writing", title: "Как ты пишешь и думаешь", icon: "note" },
  { id: "meta", title: "Метапознание и память", icon: "target" },
  { id: "autonomy", title: "Самостоятельность", icon: "compass" },
];

export const FLAG_NAMES: Record<string, string> = {
  paste: "вставки",
  burst: "аномально быстрый ввод",
  bulk_insert: "крупные вставки",
  tab_away: "уходы со вкладки",
};

/** "What shaped this section" block: the AI's note about the most influential learning moments
 * when the profile has one, otherwise the static hints about where the data comes from. */
export function SectionFactors({
  p,
  id,
  fallback,
}: {
  p: ProfileT;
  id: ProfileSection;
  fallback: ReactNode;
}) {
  const note = p.section_notes?.[id]?.trim();
  return (
    <div className={`section-factors ${note ? "ai" : ""}`}>
      <b>{note ? "ИИ-наставник: что сильнее всего повлияло" : "Основные моменты, которые повлияли:"}</b>
      {note ? <Markdown>{note}</Markdown> : fallback}
    </div>
  );
}

/** Contents of one profile section. Shared by the profile modal and the full-page section view,
 * so "Подробнее" never shows a different picture than the tile it came from. */
export default function ProfileSectionBody({
  p,
  section,
  talentOverview,
}: {
  p: ProfileT;
  section: ProfileSection;
  talentOverview: TalentOverviewT | null;
}) {
  const wp = p.integrity.writing_profile ?? {};
  const cal = p.integrity.calibration;

  switch (section) {
    case "talents":
      return (
        <>
          {p.talents ? (
            <Markdown>{p.talents}</Markdown>
          ) : (
            <p className="muted">Профиль сформируется после первой пройденной темы.</p>
          )}
          <h3 className="mt">Показатели по талантам</h3>
          {talentOverview ? (
            <>
              <div className="talent-mini-grid">
                {talentOverview.talents.map((t) => (
                  <Link key={t.key} className="talent-mini" to={`/profile/talents/${t.key}`}>
                    <span className="talent-mini-icon" aria-hidden="true"><Icon name={t.icon} /></span>
                    <span className="talent-mini-body">
                      <span className="row" style={{ gap: 6 }}>
                        <b style={{ flex: 1 }}>{t.title}</b>
                        <span className="small muted">{Math.round(t.score * 100)}%</span>
                      </span>
                      <Progress value={t.score * 100} />
                      <span className="small muted">
                        {t.delta ? `${signed(t.delta)} п.п. к прошлому показателю` : "пока без изменений"}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
              <div className="row mt">
                <Link className="btn sm primary" to="/profile/talents">Подробнее по всем талантам →</Link>
                {(talentOverview.pending > 0 || talentOverview.analyzing) && (
                  <span className="small muted"><span className="spinner" /> наставник разбирает новые сообщения…</span>
                )}
              </div>
            </>
          ) : (
            <p className="small muted">Показатели появятся после первого анализа сообщений.</p>
          )}
          {p.strengths.length > 0 && (<><h3 className="mt">Сильные стороны</h3><ul>{p.strengths.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {p.growth_areas.length > 0 && (<><h3>Зоны роста</h3><ul>{p.growth_areas.map((s) => <li key={s}>{s}</li>)}</ul></>)}
          {p.profile_updated_at && <div className="small muted">обновлён {new Date(p.profile_updated_at + "Z").toLocaleString()}</div>}
        </>
      );
    case "mind":
      return (
        <>
          <SectionFactors
            p={p}
            id="mind"
            fallback={
              <ul>
                <li>уровни прологов, стиль мышления и интересы, которые наставник отмечает в темах;</li>
                <li>оценки практики, экзаменов и проверок понимания после экзамена;</li>
                <li>факты и итоги сессий из долговременной памяти наставника.</li>
              </ul>
            }
          />
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
              <div className="row mt">
                <Link className="btn sm" to="/profile/talents">Увидеть, что повлияло на показатели →</Link>
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
          <SectionFactors
            p={p}
            id="writing"
            fallback={
              <ul>
                <li>скорость набора по сравнению с твоей обычной;</li>
                <li>длина фрагментов между паузами ≥2 с — беглость;</li>
                <li>частота правок и удалений на знак — переформулирование по ходу;</li>
                <li>доля пауз в начале предложений — обдумываешь заранее или по ходу письма.</li>
              </ul>
            }
          />
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
          <SectionFactors
            p={p}
            id="meta"
            fallback={
              <ul>
                <li>уверенность 1–5, которую ты указываешь перед ответом, против фактической оценки задания;</li>
                <li>карточки интервального повторения: сколько их, сколько повторений сделано и какая доля материала удерживается.</li>
              </ul>
            }
          />
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
          <SectionFactors
            p={p}
            id="autonomy"
            fallback={
              <ul>
                <li>вставки из буфера и крупные нестандартные вставки на практике и экзамене;</li>
                <li>серии набора заметно быстрее твоей обычной скорости без пауз и правок;</li>
                <li>уход из вкладки во время экзамена;</li>
                <li>объём собственного набора — сегменты ввода за последние 30 дней.</li>
              </ul>
            }
          />
          <p className="small muted">На практике это только записывается и влияет на состав экзамена, а на экзамене — повод для вопросов по решению.</p>
          <p className="small">Событий записано: {p.integrity.total_events}. За 30 дней: сегментов набора {p.integrity.typed_segments_30d}, вставок {p.integrity.pastes_30d}.</p>
          {Object.keys(p.integrity.flags).length ? (
            <ul className="small">{Object.entries(p.integrity.flags).map(([k, v]) => <li key={k}>{FLAG_NAMES[k] ?? k}: {v}</li>)}</ul>
          ) : <p className="small">Сигналов нет.</p>}
        </>
      );
  }
}
