import { Icon } from "../components/Icon";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Loading, Progress } from "../components/ui";

type Entry = {
  rank: number; user_id: number; name: string; is_me: boolean;
  completed: number; total: number; progress: number; avg_score: number | null;
};
type LeaderboardT = { course_title: string; total_nodes: number; entries: Entry[] };

export default function Leaderboard() {
  const { id } = useParams();
  const [lb, setLb] = useState<LeaderboardT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<LeaderboardT>(`/courses/${id}/leaderboard`).then(setLb).catch((e) => setError(e.message));
  }, [id]);

  if (!lb) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div>
      <div className="row mb">
        <div>
          <div className="eyebrow">Лидерборд</div>
          <h1 style={{ margin: "4px 0 0" }}>{lb.course_title}</h1>
        </div>
        <span className="spacer" />
        <Link className="btn" to={`/courses/${id}`}>← К курсу</Link>
      </div>
      <ErrorBox error={error} />
      <p className="small muted" style={{ margin: "-4px 0 14px" }}>
        В рейтинг входят только темы автора. Побочные квесты, случайные встречи и личные мостики его не меняют.
      </p>
      {lb.entries.length === 0 ? (
        <div className="card center" style={{ maxWidth: 480, margin: "40px auto" }}>
          <span className="icon-frame mb"><Icon name="trophy" /></span>
          <p className="muted">Пока никто не записался на курс — будь первым в рейтинге.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 10 }}>
          <div className="route">
            {lb.entries.map((e) => (
              <div key={e.user_id} className={`lb-row ${e.is_me ? "me" : ""}`}>
                <span className={`lb-rank ${e.rank === 1 ? "first" : ""}`}>{e.rank}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <b style={{ color: "var(--text-strong)" }}>{e.name}</b>
                    {e.is_me && <span className="badge accent">ты</span>}
                    <span className="spacer" />
                    <span className="small muted">{e.completed}/{e.total} тем</span>
                    {e.avg_score != null && <span className="badge"><Icon name="exam" /> {e.avg_score}</span>}
                  </div>
                  <Progress value={e.progress} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
