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
        <span className="domain-ico">{DOMAIN_ICONS[c.domain] ?? "🎓"}</span>
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">{c.domain_name}</span>
          <span className="course-meta">{c.nodes_count} тем · {c.author}</span>
        </div>
        <span className="spacer" />
        {c.is_author && !c.published && <span className="badge warning">черновик</span>}
        {c.is_author && c.published && <span className="badge accent">мой курс</span>}
      </div>
      <h3>{c.title}</h3>
      <div className="desc">{(c.summary || c.description || "").slice(0, 170)}</div>
      {c.enrolled && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row small"><span className="muted">Прогресс</span><span className="spacer" /><span>{Math.round(c.progress)}%</span></div>
          <Progress value={c.progress} />
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
      <div className="hero grid-bg">
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="eyebrow mb">Твоё обучение</div>
          <h1>Привет, <span className="gradient-text">{user?.name}</span></h1>
          <p>Каждая тема — пролог, лекция, практика и экзамен. Маршрут по графу знаний подстраивается под тебя после каждой темы.</p>
        </div>
        {user?.role === "author" && (
          <Link className="btn primary lg" to="/courses/new">
            + Создать курс
          </Link>
        )}
      </div>

      {due > 0 && (
        <div className="review-banner">
          <span className="ico">🧠</span>
          <div>
            <b>Пора повторить: {due} карточ{due === 1 ? "ка" : due < 5 ? "ки" : "ек"}</b>
            <div className="small muted">Припоминание с интервалами — один из самых надёжных способов закрепить знания.</div>
          </div>
          <span className="spacer" />
          <Link className="btn primary" to="/reviews">Повторить</Link>
        </div>
      )}

      <div className="section-title"><h2>Мои курсы</h2>{mine.length > 0 && <span className="muted">{mine.length}</span>}</div>
      {mine.length ? (
        <div className="grid grid-3">{mine.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Пока нет курсов — выбери любой в каталоге ниже.</div>
      )}

      {authored.length > 0 && (
        <>
          <div className="section-title"><h2>Курсы, которые я создаю</h2><span className="muted">{authored.length}</span></div>
          <div className="grid grid-3">{authored.map((c) => <CourseCard key={c.id} c={c} />)}</div>
        </>
      )}

      <div className="section-title"><h2>Каталог</h2>{catalog.length > 0 && <span className="muted">{catalog.length}</span>}</div>
      {catalog.length ? (
        <div className="grid grid-3">{catalog.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Опубликованных курсов пока нет.</div>
      )}
    </div>
  );
}
