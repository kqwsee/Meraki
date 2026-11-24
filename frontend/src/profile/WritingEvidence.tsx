import { Link } from "react-router-dom";
import { formatDateTime, STAGE_LABELS, type WritingEvidenceT, type WritingMessageT } from "./talents";
import { DraftCompare, learningMessageLink } from "./TalentParts";

function WritingItem({ m }: { m: WritingMessageT }) {
  const link = learningMessageLink(m.node_id, m.id, m.stage);
  const metrics = m.metrics;
  return (
    <div className="evidence">
      <div className="evidence-head">
        <span className="evidence-time">{formatDateTime(m.created_at)}</span>
        <span className="evidence-kind">{STAGE_LABELS[m.stage] ?? m.stage}</span>
        {m.node_title && <span className="evidence-meta">«{m.node_title}»</span>}
        <span className="spacer" />
        {m.course_title && <span className="small muted">{m.course_title}</span>}
      </div>

      <div className="writing-metrics">
        {metrics.chars > 0 ? (
          <>
            <span className="metric-chip">{metrics.chars} зн.</span>
            {metrics.cpm != null && <span className="metric-chip">{metrics.cpm} зн/мин</span>}
            {metrics.pauses_2s > 0 && <span className="metric-chip">пауз ≥2 с: {metrics.pauses_2s}</span>}
            {metrics.backspaces > 0 && <span className="metric-chip">удалений: {metrics.backspaces}</span>}
            {metrics.sentence_pauses > 0 && <span className="metric-chip">пауз в начале фраз: {metrics.sentence_pauses}</span>}
          </>
        ) : (
          <span className="metric-chip">метрик ввода нет (старая запись)</span>
        )}
      </div>

      <div className="evidence-quote">{m.content}</div>

      {m.notes.length > 0 && (
        <ul className="writing-notes">
          {m.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}

      {m.revisions.length > 0 && (
        <details className="evidence-full" open={m.revisions.length === 1}>
          <summary>Правки черновика ({m.revisions.length})</summary>
          {m.revisions.map((r, i) => <DraftCompare key={`${m.id}-${i}`} revision={r} />)}
        </details>
      )}

      <div className="evidence-foot">
        {link ? <Link className="btn sm" to={link}>К сообщению →</Link> : <span className="small muted">Сообщение недоступно</span>}
      </div>
    </div>
  );
}

/** Every learner message behind the "how you write and think" section: tempo, pauses, edits and
 * paste/delete revisions. Deterministic, so a just-sent message appears on the next poll. */
export default function WritingEvidence({ data }: { data: WritingEvidenceT }) {
  return (
    <div className="mt">
      <div className="row mb">
        <h2 style={{ margin: 0 }}>Конкретные сообщения</h2>
        <span className="spacer" />
        <span className="small muted">новые сверху</span>
      </div>
      <p className="small muted">
        Здесь видно, где именно проявился твой способ писать и думать: темп, паузы, правки, вставки и удаления.
        Новое сообщение появляется на этой странице через пару секунд после отправки.
      </p>
      {data.traits.length > 0 && (
        <div className="section-factors ai">
          <b>Как это читается по всем сообщениям:</b>
          <ul>{data.traits.map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
      )}
      {data.messages.length ? (
        <div className="evidence-list">
          {data.messages.map((m) => <WritingItem key={m.id} m={m} />)}
        </div>
      ) : (
        <div className="empty">
          <p>Пока нет сообщений.</p>
          <p className="small">Напиши наставнику на любом этапе темы — сообщение появится здесь сразу после отправки.</p>
        </div>
      )}
    </div>
  );
}
