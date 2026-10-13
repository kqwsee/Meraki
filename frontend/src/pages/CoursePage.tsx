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
      <div className="row mb">
        <span style={{ fontSize: 36 }}>{DOMAIN_ICONS[c.domain] ?? "🎓"}</span>
        <div>
          <h1 style={{ margin: 0 }}>{c.title}</h1>
          <div className="muted small">{c.domain_name} · автор {c.author}</div>
        </div>
        <span className="spacer" />
        {c.is_author && <Link className="btn" to={`/courses/${c.id}/edit`}>Редактировать</Link>}
        {!c.enrolled && c.status === "ready" && (
          <button className="btn primary lg" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/courses/${c.id}/enroll`); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>Записаться на курс</button>
        )}
      </div>
      <ErrorBox error={error} />
      <p>{c.summary || c.description}</p>

      {c.enrolled && (
        <div className="card mb">
          <div className="row">
            <b>Прогресс</b>
            <span className="spacer" />
            <span className="muted small">{Math.round(c.progress)}%</span>
          </div>
          <div className="mt"><Progress value={c.progress} /></div>
          {c.route.message && (
            <div className="alert mt">
              <b>🧭 Твой маршрут{c.route.replans ? ` (перестроен ${c.route.replans} раз)` : ""}:</b> {c.route.message}
            </div>
          )}
          {c.route.next_node_id && (
            <div className="row mt">
              <span>Следующая тема: <b>{c.nodes.find((n) => n.id === c.route.next_node_id)?.title}</b></span>
              <span className="spacer" />
              <Link className="btn primary" to={`/learn/${c.route.next_node_id}`}>Продолжить →</Link>
            </div>
          )}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "start" }}>
        <GraphView nodes={c.nodes} edges={c.edges} nextId={c.route.next_node_id} onSelect={open} />
        <div className="card" style={{ padding: 14 }}>
          <h3>Маршрут</h3>
          <div className="col" style={{ gap: 6 }}>
            {ordered.map((n, i) => {
              const mode = n.mode && MODE_LABELS[n.mode];
              const clickable = c.enrolled && (n.unlocked || n.completed);
              return (
                <div key={n.id} className="task-item" style={{ cursor: clickable ? "pointer" : "default", opacity: clickable || !c.enrolled ? 1 : 0.6, marginBottom: 0 }}
                  onClick={() => clickable && open(n)} title={n.mode_reason || n.summary}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="muted small">{i + 1}.</span>
                    <span className="ttitle" style={{ flex: 1 }}>{n.title}</span>
                    {n.completed ? <span className="badge success">✓</span> : !n.unlocked ? <span>🔒</span> : null}
                  </div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {n.stage && !n.completed && <span className="badge accent">{STAGE_NAMES[n.stage]}</span>}
                    {mode && <span className={`badge ${mode.cls}`}>{mode.label}</span>}
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
