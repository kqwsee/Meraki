import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../components/Icon";
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
    <article className="card course-card">
      <div className="row">
        <span className="icon-frame"><Icon name={DOMAIN_ICONS[c.domain] ?? "graduation"} /></span>
        <div className="col" style={{ gap: 2 }}>
          <span className="eyebrow">{c.domain_name}</span>
          <span className="course-meta">{c.nodes_count} тем · {c.author}</span>
        </div>
        <span className="spacer" />
        {c.is_author && !c.published && <span className="badge warning">черновик</span>}
        {c.is_author && c.published && <span className="badge accent">мой курс</span>}
      </div>
      <h3>{c.title}</h3>
      {(c.summary || c.description) && <p className="desc">{c.summary || c.description}</p>}
      {c.enrolled && (
        <div className="course-progress">
          <div className="row small"><span className="muted">Прогресс</span><span className="spacer" /><span>{Math.round(c.progress)}%</span></div>
          <Progress value={c.progress} />
        </div>
      )}
      <div className="row course-actions">
        {c.status === "ready" && (
          <Link className="btn primary sm" to={`/courses/${c.id}`}>
            {c.enrolled ? "Продолжить" : "Открыть"} <Icon name="arrowRight" />
          </Link>
        )}
        {c.is_author && (
          <Link className="btn sm" to={`/courses/${c.id}/edit`}>
            Редактировать
          </Link>
        )}
      </div>
    </article>
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

  if (!courses) return error ? <ErrorBox error={error} /> : <Loading text="Загружаем курсы" />;
  const mine = courses.filter((c) => c.enrolled);
  const authored = courses.filter((c) => c.is_author);
  const catalog = courses.filter((c) => !c.enrolled && c.published && c.status === "ready");

  return (
    <div>
      <header className="workspace-head">
        <div>
          <h1>Курсы</h1>
          <p>Продолжи свой маршрут или выбери новый курс в каталоге.</p>
        </div>
        {user?.role === "author" && (
          <Link className="btn primary lg" to="/courses/new">
            <Icon name="plus" /> Создать курс
          </Link>
        )}
      </header>

      {due > 0 && (
        <div className="review-banner">
          <span className="icon-frame"><Icon name="refresh" /></span>
          <div>
            <strong>Карточки к повторению · {due}</strong>
            <p className="small muted">Вернись к пройденным темам</p>
          </div>
          <span className="spacer" />
          <Link className="btn" to="/reviews">Повторить <Icon name="arrowRight" /></Link>
        </div>
      )}

      <div className="section-title"><h2>Мои курсы</h2>{mine.length > 0 && <span className="muted">{mine.length}</span>}</div>
      {mine.length ? (
        <div className="grid course-grid">{mine.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Пока нет курсов — выбери любой в каталоге ниже.</div>
      )}

      {authored.length > 0 && (
        <>
          <div className="section-title"><h2>Курсы, которые я создаю</h2><span className="muted">{authored.length}</span></div>
          <div className="grid course-grid">{authored.map((c) => <CourseCard key={c.id} c={c} />)}</div>
        </>
      )}

      <div className="section-title"><h2>Каталог</h2>{catalog.length > 0 && <span className="muted">{catalog.length}</span>}</div>
      {catalog.length ? (
        <div className="grid course-grid">{catalog.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      ) : (
        <div className="empty">Опубликованных курсов пока нет.</div>
      )}
    </div>
  );
}
