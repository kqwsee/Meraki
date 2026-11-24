import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../components/Icon";
import MemoryGraph from "../components/MemoryGraph";
import { ErrorBox, Loading } from "../components/ui";
import { useKnowledgeGraph, type Note, type ProfileT } from "../profile/knowledgeGraph";

/** Full-screen view of the same "Карта знаний" shown on the profile page — reached via the
 * "На весь экран" link there, so you can spread out and actually read the clusters. */
export default function KnowledgeMap() {
  const navigate = useNavigate();
  const [p, setP] = useState<ProfileT | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<number>();

  const load = useCallback(async () => {
    try {
      const [profile, noteList] = await Promise.all([api.get<ProfileT>("/profile"), api.get<Note[]>("/notes")]);
      setP(profile);
      setNotes(noteList);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить карту знаний");
    }
  }, []);
  useEffect(() => {
    load();
    return () => window.clearTimeout(refreshTimer.current);
  }, [load]);

  const graph = useKnowledgeGraph(p, notes);

  if (!p) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading text="Загружаем карту знаний" />;

  return (
    <div className="knowledge-page">
      <header className="row knowledge-head">
        <Link to="/profile" className="btn sm ghost"><Icon name="arrowLeft" /> Профиль</Link>
        <h1>Карта знаний</h1>
        <span className="spacer" />
        <button className="btn sm" disabled={refreshing} onClick={async () => {
          setRefreshing(true);
          setError(null);
          try {
            await api.post("/profile/refresh");
            refreshTimer.current = window.setTimeout(async () => {
              await load();
              setRefreshing(false);
            }, 15000);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Не удалось пересчитать связи");
            setRefreshing(false);
          }
        }}>
          {refreshing ? <><span className="spinner" /> Пересчитываем связи</> : <><Icon name="refresh" /> Пересчитать связи</>}
        </button>
      </header>
      <ErrorBox error={error} />
      <div className="profile-map-body">
        {graph.nodes.length > 0 ? (
          <MemoryGraph fill nodes={graph.nodes} links={graph.links}
            onNodeClick={(n) => { if (n.kind === "course") navigate(`/courses/${n.id.split(":")[1]}`); }} />
        ) : <div className="profile-map-empty">
          <span className="icon-frame"><Icon name="graph" /></span>
          <strong>Карта пока пуста</strong>
          <p>Здесь появятся курсы, освоенные темы и заметки.</p>
        </div>}
      </div>
    </div>
  );
}
