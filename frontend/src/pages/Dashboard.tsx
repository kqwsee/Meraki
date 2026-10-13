import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { DOMAIN_ICONS, ErrorBox, Loading, Progress } from "../components/ui";

export type CourseSummary = {
  id: number;
  title: string;
  description: string;
  domain: string;
  domain_name: string;
  status: string;
  status_detail: string;
  summary: string;
  published: boolean;
  author: string;
  is_author: boolean;
  enrolled: boolean;
  nodes_count: number;
  progress: number;
};

function CourseCard({ c }: { c: CourseSummary }) {
  return (
    <div className="card course-card">
      <div className="row">
        <span style={{ fontSize: 24 }}>{DOMAIN_ICONS[c.domain] ?? "🎓"}</span>
        <span className="badge">{c.domain_name}</span>
        <span className="spacer" />
        {c.is_author && <span className="badge accent">мой курс</span>}
        {c.is_author && !c.published && <span className="badge warning">черновик</span>}
      </div>
      <h3>{c.title}</h3>
      <div className="desc">{(c.summary || c.description || "").slice(0, 180)}</div>
      <div className="small muted">
        {c.nodes_count} тем · автор {c.author}
      </div>
      {c.enrolled && (
        <div className="col" style={{ gap: 4 }}>
          <Progress value={c.progress} />
          <span className="small muted">пройдено {Math.round(c.progress)}%</span>
        </div>
      )}
      <div className="row">
        {c.status === "ready" && (
          <Link className="btn primary sm" to={`/courses/${c.id}`}>
            {c.enrolled ? "Продолжить" : "Открыть"}
          </Link>
        )}
        {c.is_author && (
          <Link className="btn sm" to={`/courses/${c.id}/edit`}>
            Редактировать
          </Link>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<CourseSummary[] | null>(null);
  const [due, setDue] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<CourseSummary[]>("/courses").then(setCourses).catch((e) => setError(e.message));
    api.get<{ due: number }>("/reviews").then((r) => setDue(r.due)).catch(() => undefined);
  }, []);

  if (!courses) return error ? <ErrorBox error={error} /> : <Loading />;
  const mine = courses.filter((c) => c.enrolled);
  const authored = courses.filter((c) => c.is_author);
  const catalog = courses.filter((c) => !c.enrolled && c.published && c.status === "ready");

  return (
    <div>
      <div className="row mb">
        <div>
          <h1>Привет, {user?.name}!</h1>
          <p className="muted">Твоё обучение строится по графу знаний: каждая тема — пролог, лекция, практика и экзамен.</p>
        </div>
        <span className="spacer" />
        {user?.role === "author" && (
          <Link className="btn primary" to="/courses/new">
            + Создать курс
          </Link>
        )}
      </div>

      {due > 0 && (
        <div className="card mb row" style={{ background: "var(--accent-soft)", borderColor: "#c7d2fe" }}>
          <span style={{ fontSize: 28 }}>🧠</span>
          <div>
            <b>Пора повторить: {due} карточ{due === 1 ? "ка" : due < 5 ? "ки" : "ек"}</b>
            <div className="small muted">Припоминание с интервалами — один из самых надёжных способов закрепить знания.</div>
          </div>
          <span className="spacer" />
          <Link className="btn primary" to="/reviews">Повторить</Link>
        </div>
      )}

      <h2 className="mt">Мои курсы</h2>
      {mine.length ? (
        <div className="grid grid-3">{mine.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Ты ещё не записан ни на один курс — выбери в каталоге ниже.</div>
      )}

      {authored.length > 0 && (
        <>
          <h2 className="mt">Курсы, которые я создаю</h2>
          <div className="grid grid-3">{authored.map((c) => <CourseCard key={c.id} c={c} />)}</div>
        </>
      )}

      <h2 className="mt">Каталог</h2>
      {catalog.length ? (
        <div className="grid grid-3">{catalog.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Опубликованных курсов пока нет.</div>
      )}
    </div>
  );
}
