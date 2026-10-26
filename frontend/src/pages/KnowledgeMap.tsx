import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import MemoryGraph from "../components/MemoryGraph";
import { ErrorBox, Loading } from "../components/ui";
import { useKnowledgeGraph, type Note, type ProfileT } from "../profile/knowledgeGraph";

/** Full-screen view of the same "Карта знаний" shown on the profile page — reached via the
 * "⤢ На весь экран" link there, so you can spread out and actually read the clusters. */
export default function KnowledgeMap() {
  const navigate = useNavigate();
  const [p, setP] = useState<ProfileT | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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

  if (!p) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;

  return (
    <div className="col" style={{ height: "100%", minHeight: 0 }}>
      <div className="row" style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <Link to="/profile" className="btn sm ghost">← Профиль</Link>
        <h2 style={{ margin: 0 }}>Карта знаний</h2>
        <span className="spacer" />
        <button className="btn sm" disabled={refreshing} onClick={async () => {
          setRefreshing(true);
          await api.post("/profile/refresh");
          setTimeout(async () => { await load(); setRefreshing(false); }, 15000);
        }}>
          {refreshing ? <><span className="spinner" /> ИИ пересчитывает связи…</> : "↻ Пересчитать связи"}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 20 }}>
        {graph.nodes.length > 0 ? (
          <MemoryGraph fill nodes={graph.nodes} links={graph.links}
            onNodeClick={(n) => { if (n.kind === "course") navigate(`/courses/${n.id.split(":")[1]}`); }} />
        ) : <p className="muted">Появится, когда наберётся прогресс, факты памяти или заметки.</p>}
      </div>
    </div>
  );
}
