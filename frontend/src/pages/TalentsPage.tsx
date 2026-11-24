import { Icon } from "../components/Icon";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import { ErrorBox, Loading, Progress } from "../components/ui";
import { signed, type TalentInfoT, type TalentOverviewT } from "../profile/talents";
import { DeltaBadge, RecentSignal } from "../profile/TalentParts";

function TalentCard({ talent }: { talent: TalentInfoT }) {
  return (
    <div className="card talent-card">
      <div className="talent-card-head">
        <span className="talent-card-icon" aria-hidden="true"><Icon name={talent.icon} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="talent-card-title">{talent.title}</div>
          <div className="small muted">{talent.label} талант</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="talent-score">{Math.round(talent.score * 100)}%</div>
          <DeltaBadge delta={talent.delta} />
        </div>
      </div>
      <Progress value={talent.score * 100} />
      <p className="talent-desc">
        {talent.description.length > 280 ? `${talent.description.slice(0, 280).trimEnd()}…` : talent.description}
      </p>

      <div className="talent-recent">
        <div className="row small muted" style={{ justifyContent: "space-between" }}>
          <span>Что повлияло</span>
          <span>{talent.signals} наблюдений</span>
        </div>
        {talent.recent?.length ? (
          talent.recent.map((s) => <RecentSignal key={s.id} signal={s} />)
        ) : (
          <span className="talent-recent-empty">
            Пока нет наблюдений. Напиши наставнику сообщение — анализ появится здесь через несколько секунд.
          </span>
        )}
      </div>

      <div className="row mt" style={{ marginTop: "auto", paddingTop: 12 }}>
        <Link className="btn sm" to={`/profile/talents/${talent.key}`}>Все наблюдения →</Link>
      </div>
    </div>
  );
}

export default function TalentsPage() {
  const [data, setData] = useState<TalentOverviewT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.get<TalentOverviewT>("/profile/talents");
      setData(next);
      setLoadedAt(new Date());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // live view: the tutor may be analysing a message in another tab right now
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div>
      <div className="talent-page-head mb">
        <div style={{ flex: 1, minWidth: 260 }}>
          <Link className="small muted" to="/profile">← Профиль</Link>
          <h1 style={{ margin: "4px 0 6px" }}>Таланты</h1>
          <p className="muted" style={{ margin: 0 }}>
            Все показатели и конкретные сообщения, которые на них повлияли. Страница обновляется сама, пока открыта.
          </p>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            Наблюдение появляется, когда в сообщении действительно виден талант. Служебные реплики («просто тестирую»)
            показатель не двигают — их можно увидеть в разделе{" "}
            <Link to="/profile/sections/writing">«Как ты пишешь и думаешь»</Link>.
          </p>
        </div>
        <span className="live-pill"><span className="live-dot" /> в реальном времени{loadedAt ? ` · ${loadedAt.toLocaleTimeString("ru-RU")}` : ""}</span>
        <button className="btn" disabled={requested} onClick={async () => {
          setRequested(true);
          await api.post("/profile/talents/analyze");
          await load();
          window.setTimeout(() => setRequested(false), 8000);
        }}>{requested ? <><span className="spinner" /> анализ…</> : "↻ Разобрать сообщения"}</button>
      </div>

      <ErrorBox error={error} />

      {(data.analyzing || data.pending > 0) && (
        <div className="alert mb row">
          <span className="spinner" />
          <span>
            {data.analyzing
              ? "Наставник читает сообщения и пересчитывает показатели…"
              : `Новые сообщения ждут разбора (${data.pending}). Наблюдения появятся через несколько секунд.`}
          </span>
        </div>
      )}

      {data.intro && (
        <div className="card mb">
          <Markdown>{data.intro}</Markdown>
          {data.updated_at && (
            <div className="small muted">профиль обновлён {new Date(`${data.updated_at}Z`).toLocaleString("ru-RU")}</div>
          )}
        </div>
      )}

      <div className="talent-grid">
        {data.talents.map((t) => <TalentCard key={t.key} talent={t} />)}
      </div>
    </div>
  );
}
