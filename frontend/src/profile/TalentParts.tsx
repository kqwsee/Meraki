import { Link } from "react-router-dom";
import { draftDiff, formatDateTime, REVISION_LABELS, signed, type TalentSignalT } from "./talents";

/** Link to the exact learner message, used from both talent and writing evidence. */
export function learningMessageLink(nodeId: number | null, messageId: number | null, stage: string): string | null {
  if (messageId == null || nodeId == null) return null;
  return `/learn/${nodeId}?stage=${encodeURIComponent(stage || "prologue")}&message=${messageId}`;
}

export function messageLink(s: TalentSignalT): string | null {
  return learningMessageLink(s.node_id, s.message_id, s.stage);
}

export function DeltaBadge({ delta }: { delta: number }) {
  const cls = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat";
  return (
    <span className={`talent-delta ${cls}`}>
      {delta > 0.05 || delta < -0.05 ? `${signed(delta)} п.п.` : "без изменений"}
    </span>
  );
}

/** Compact observation used on the all-talents overview card. */
export function RecentSignal({ signal }: { signal: TalentSignalT }) {
  const link = messageLink(signal);
  return (
    <div className="talent-recent-item">
      <span className="excerpt">{signal.kind === "profile" ? "Пересчёт профиля ИИ" : signal.excerpt || signal.reason}</span>
      <span>
        {formatDateTime(signal.message_created_at ?? signal.created_at)}
        {signal.node_title ? ` · ${signal.node_title}` : ""}
      </span>
      {link && (
        <>
          {" · "}
          <Link to={link}>к сообщению →</Link>
        </>
      )}
    </div>
  );
}

/** Before/after of one draft edit, with only the changed span highlighted. */
export function DraftCompare({ revision }: { revision: { kind: string; before: string; after: string } }) {
  const diff = draftDiff(revision.before, revision.after);
  const isDelete = revision.kind === "delete";
  return (
    <>
      <div className="small muted mt">
        {isDelete ? "Черновик: что было и что осталось после удаления" : "Черновик: что было и что стало после вставки"}
        {revision.kind ? ` (${REVISION_LABELS[revision.kind] ?? revision.kind})` : ""}
      </div>
      <div className="draft-compare">
        <div className="draft-block">
          <div className="draft-label">Было</div>
          <pre>{diff.before.prefix}<del>{diff.before.changed}</del>{diff.before.suffix}</pre>
        </div>
        <div className="draft-block">
          <div className="draft-label">Стало</div>
          <pre>{diff.after.prefix}<ins>{diff.after.changed}</ins>{diff.after.suffix}</pre>
        </div>
      </div>
    </>
  );
}
