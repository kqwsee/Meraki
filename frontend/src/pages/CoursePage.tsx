import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import GraphView, { type GNode } from "../components/GraphView";
import { DOMAIN_ICONS, ErrorBox, Loading, MODE_LABELS, Progress, STAGE_NAMES } from "../components/ui";

type CourseView = {
  id: number; title: string; description: string; summary: string; domain: string; domain_name: string; status: string;
  enrolled: boolean; is_author: boolean; progress: number; author: string;
  nodes: (GNode & { objectives: string[]; concepts: string[]; mode_reason: string })[];
  edges: { source: number; target: number }[];
  route: { message: string; replans: number; next_node_id: number | null };
};

export default function CoursePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [c, setC] = useState<CourseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<CourseView>(`/courses/${id}`).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (!c) return error ? <ErrorBox error={error} /> : <Loading />;
  const ordered = [...c.nodes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const open = (n: GNode) => {
    if (!c.enrolled) return;
    if (n.unlocked || n.completed) nav(`/learn/${n.id}`);
  };

  return (
    <div>
      <div className="row mb" style={{ alignItems: "flex-start", gap: 16 }}>
        <span className="domain-ico" style={{ width: 52, height: 52, fontSize: 26, borderRadius: 14 }}>{DOMAIN_ICONS[c.domain] ?? "🎓"}</span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="eyebrow">{c.domain_name}</div>
          <h1 style={{ margin: "4px 0 6px" }}>{c.title}</h1>
          <div className="muted small">автор {c.author} · {c.nodes.filter((n) => !n.personal).length} тем</div>
        </div>
        {c.is_author && <Link className="btn" to={`/courses/${c.id}/edit`}>Редактировать</Link>}
        {!c.enrolled && c.status === "ready" && (
          <button className="btn primary lg" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/courses/${c.id}/enroll`); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>Записаться на курс</button>
        )}
      </div>
      <ErrorBox error={error} />
      <p className="muted" style={{ maxWidth: 820, fontSize: 15.5 }}>{c.summary || c.description}</p>

      {c.enrolled && (
        <div className="card grid-bg mb mt">
          <div className="row" style={{ alignItems: "flex-end", gap: 24 }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="eyebrow">Прогресс по курсу</div>
              <div className="row" style={{ alignItems: "baseline", gap: 10, margin: "6px 0 12px" }}>
                <span className="score-big" style={{ fontSize: 44 }}>{Math.round(c.progress)}%</span>
                <span className="muted small">пройдено</span>
              </div>
              <Progress value={c.progress} />
            </div>
            {c.route.next_node_id && (
              <div className="col" style={{ gap: 8, minWidth: 240 }}>
                <span className="muted small">Следующая тема</span>
                <b style={{ color: "var(--text-strong)" }}>{c.nodes.find((n) => n.id === c.route.next_node_id)?.title}</b>
                <Link className="btn primary" to={`/learn/${c.route.next_node_id}`}>Продолжить →</Link>
              </div>
            )}
          </div>
          {c.route.message && (
            <div className="alert mt">
              <b>🧭 Твой маршрут{c.route.replans ? ` · перестроен ${c.route.replans} раз` : ""}</b>
              <div style={{ marginTop: 4 }}>{c.route.message}</div>
            </div>
          )}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <GraphView nodes={c.nodes} edges={c.edges} nextId={c.route.next_node_id} onSelect={open} />
        <div className="card" style={{ padding: 18 }}>
          <div className="eyebrow mb">Темы маршрута</div>
          <div className="route">
            {ordered.map((n, i) => {
              const mode = n.mode && MODE_LABELS[n.mode];
              const clickable = c.enrolled && (n.unlocked || n.completed);
              const isNext = n.id === c.route.next_node_id;
              return (
                <div key={n.id}
                  className={`route-step ${n.completed ? "done" : ""} ${isNext ? "next" : ""} ${c.enrolled && !clickable ? "locked" : ""}`}
                  onClick={() => clickable && open(n)} title={n.mode_reason || n.summary}>
                  <span className="route-num">{n.completed ? "✓" : i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="route-title">{n.title}</div>
                    {((n.stage && !n.completed) || mode || (c.enrolled && !n.unlocked && !n.completed)) && (
                      <div className="row" style={{ gap: 4, marginTop: 6 }}>
                        {n.stage && !n.completed && <span className="badge accent">{STAGE_NAMES[n.stage]}</span>}
                        {mode && <span className={`badge ${mode.cls}`}>{mode.label}</span>}
                        {c.enrolled && !n.unlocked && !n.completed && <span className="badge">🔒 закрыта</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
