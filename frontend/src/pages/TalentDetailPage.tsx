import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Loading, Progress } from "../components/ui";
import { formatDateTime, signed, STAGE_LABELS, type TalentDetailT, type TalentSignalT } from "../profile/talents";
import { DeltaBadge, DraftCompare, messageLink } from "../profile/TalentParts";

function Evidence({ signal }: { signal: TalentSignalT }) {
  const link = messageLink(signal);
  const hasDraft = Boolean(signal.before_text || signal.after_text) && Boolean(signal.revision_kind);
  return (
    <div className="evidence">
      <div className="evidence-head">
        <span className="evidence-time">{formatDateTime(signal.message_created_at ?? signal.created_at)}</span>
        {signal.kind === "profile" ? (
          <span className="evidence-kind">пересчёт профиля</span>
        ) : (
          <>
            <span className="evidence-kind">{STAGE_LABELS[signal.stage] ?? signal.stage}</span>
            {signal.node_title && <span className="evidence-meta">«{signal.node_title}»</span>}
          </>
        )}
        <span className="spacer" />
        <span className="small muted" style={{ fontFamily: "var(--mono)" }}>
          {Math.round(signal.score_before * 100)}% → <b style={{ color: "var(--text-strong)" }}>{Math.round(signal.score_after * 100)}%</b>
        </span>
        <DeltaBadge delta={signal.delta} />
      </div>

      {signal.kind !== "profile" && (signal.excerpt || signal.message_content) && (
        <div className="evidence-quote">{signal.excerpt || signal.message_content}</div>
      )}
      {signal.kind !== "profile" && signal.message_content.trim() && signal.message_content.trim() !== signal.excerpt.trim() && (
        <details className="evidence-full">
          <summary>Весь текст сообщения</summary>
          <div className="evidence-full-text">{signal.message_content}</div>
        </details>
      )}

      {signal.reason && <p className="evidence-reason">{signal.reason}</p>}

      {hasDraft && (
        <DraftCompare
          revision={{ kind: signal.revision_kind, before: signal.before_text, after: signal.after_text }}
        />
      )}

      <div className="evidence-foot">
        {link ? <Link className="btn sm" to={link}>К сообщению →</Link> : <span className="small muted">Сообщение недоступно</span>}
        {signal.course_title && <span className="small muted">{signal.course_title}</span>}
      </div>
    </div>
  );
}

export default function TalentDetailPage() {
  const { talent = "" } = useParams();
  const [data, setData] = useState<TalentDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<TalentDetailT>(`/profile/talents/${talent}`));
      setLoadedAt(new Date());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [talent]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 2500);
    return () => window.clearInterval(t);
  }, [load]);

  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;

  const t = data.talent;
  return (
    <div>
      <div className="talent-page-head mb">
        <div style={{ flex: 1, minWidth: 280 }}>
          <Link className="small muted" to="/profile/talents">← Все таланты</Link>
          <div className="row mt" style={{ gap: 14 }}>
            <span className="talent-card-icon" style={{ width: 56, height: 56, fontSize: 30 }} aria-hidden="true">{t.icon}</span>
            <div>
              <h1 style={{ margin: 0 }}>{t.title}</h1>
              <div className="small muted">{t.label} талант</div>
            </div>
          </div>
        </div>
        {data.analyzing && <span className="live-pill"><span className="spinner" /> наставник читает сообщения…</span>}
        <span className="live-pill"><span className="live-dot" /> в реальном времени{loadedAt ? ` · ${loadedAt.toLocaleTimeString("ru-RU")}` : ""}</span>
        <button className="btn" disabled={requested} onClick={async () => {
          setRequested(true);
          await api.post("/profile/talents/analyze");
          await load();
          window.setTimeout(() => setRequested(false), 8000);
        }}>{requested ? <><span className="spinner" /> анализ…</> : "↻ Разобрать сообщения"}</button>
      </div>

      <ErrorBox error={error} />

      <div className="card mb">
        <div className="row" style={{ alignItems: "flex-end", gap: 14 }}>
          <div>
            <div className="talent-score" style={{ fontSize: 44 }}>{Math.round(t.score * 100)}%</div>
            <div className="small muted">
              прошлый показатель {Math.round(t.previous * 100)}%
              {t.delta ? ` · ${signed(t.delta)} п.п.` : ""}
            </div>
          </div>
          <span className="spacer" />
          <DeltaBadge delta={t.delta} />
        </div>
        <Progress value={t.score * 100} />
        <p className="talent-desc" style={{ fontSize: 14 }}>{t.description}</p>
        <div className="small muted">
          {t.signals} наблюдений{t.last_at ? ` · последнее ${formatDateTime(t.last_at)}` : ""}
        </div>
      </div>

      <div className="row mb">
        <h2 style={{ margin: 0 }}>Конкретные места, которые повлияли</h2>
        <span className="spacer" />
        <span className="small muted">новые наблюдения появляются сверху</span>
      </div>

      {data.signals.length ? (
        <div className="evidence-list">
          {data.signals.map((s) => <Evidence key={s.id} signal={s} />)}
        </div>
      ) : (
        <div className="empty">
          <p>Пока нет наблюдений по этому таланту.</p>
          <p className="small">
            Напиши наставнику сообщение на любом этапе темы — через несколько секунд здесь появятся цитата,
            дата и объяснение, как это сообщение изменило показатель.
          </p>
          <p className="small muted">
            Служебные реплики («просто тестирую») этот показатель не двигают, но их видно в разделе{" "}
            <Link to="/profile/sections/writing">«Как ты пишешь и думаешь»</Link>.
          </p>
          <button className="btn primary" disabled={requested} onClick={async () => {
            setRequested(true);
            await api.post("/profile/talents/analyze");
            window.setTimeout(() => { load(); setRequested(false); }, 1500);
          }}>{requested ? <><span className="spinner" /> анализирую…</> : "Разобрать мои сообщения"}</button>
        </div>
      )}
    </div>
  );
}
