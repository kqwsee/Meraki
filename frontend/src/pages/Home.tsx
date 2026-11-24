import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import Brand from "../components/Brand";
import { Icon, type IconName } from "../components/Icon";

const stages: { title: string; summary: string; icon: IconName }[] = [
  { title: "Пролог", summary: "Наставник выясняет, что ты уже знаешь, и находит точку входа в тему.", icon: "compass" },
  { title: "Лекция", summary: "Разбираешь теорию в своём темпе и объясняешь главное своими словами.", icon: "book" },
  { title: "Практика", summary: "Решаешь задачи на холсте, в редакторе кода и с предметными инструментами.", icon: "tools" },
  { title: "Экзамен", summary: "Проверяешь себя самостоятельно. По результатам наставник уточняет маршрут.", icon: "exam" },
];

function RouteExample() {
  return (
    <figure className="route-example" aria-labelledby="route-example-title">
      <figcaption className="route-example-head">
        <span className="route-example-label"><Icon name="graph" /> Пример карты курса</span>
        <strong id="route-example-title">Электрические цепи</strong>
      </figcaption>
      <div className="route-example-canvas">
        <svg viewBox="0 0 560 260" preserveAspectRatio="none" aria-hidden="true">
          <path className="route-guide" d="M0 65h560M0 130h560M0 195h560M112 0v260M224 0v260M336 0v260M448 0v260" />
          <path className="route-branch" d="M84 180H112Q132 180 132 160V79Q132 59 152 59H365M240 130H321Q345 130 345 154V201Q345 221 365 221H435" />
          <path className="route-trail" d="M84 180H152Q176 180 176 156V154Q176 130 200 130H240" />
          <path className="route-next" d="M240 130H462" />
        </svg>
        <div className="route-point route-point--start">
          <span className="route-dot"><Icon name="check" /></span>
          <span className="route-caption">Ток и напряжение</span>
        </div>
        <div className="route-point route-point--current">
          <span className="route-dot"><Icon name="zap" /></span>
          <span className="route-caption"><strong>Закон Ома</strong><small>Текущая тема</small></span>
        </div>
        <div className="route-point route-point--next">
          <span className="route-dot" />
          <span className="route-caption">Соединения</span>
        </div>
        <div className="route-point route-point--branch">
          <span className="route-dot" />
          <span className="route-caption">Измерения</span>
        </div>
        <div className="route-point route-point--final">
          <span className="route-dot" />
          <span className="route-caption">Мощность</span>
        </div>
      </div>
      <ol className="route-example-stages" aria-label="Этапы текущей темы">
        {stages.map((stage, index) => (
          <li key={stage.title} className={index === 2 ? "current" : ""} aria-current={index === 2 ? "step" : undefined}>
            <span className="stage-point">
              {index < 2 ? <Icon name="check" /> : <span aria-hidden="true" />}
            </span>
            {stage.title}
          </li>
        ))}
      </ol>
    </figure>
  );
}

export default function Home() {
  const { user } = useAuth();
  const start = user ? "/courses" : "/login?mode=register";
  const startLabel = user ? "К моим курсам" : "Начать обучение";

  return (
    <div className="landing">
      <a className="skip-link" href="#main-content">К содержанию</a>
      <header className="landing-header">
        <div className="landing-container landing-header-inner">
          <Brand />
          <nav aria-label="Навигация по главной">
            <a className="landing-nav-link" href="#how-it-works">Как устроено обучение</a>
            {user?.role === "author" ? (
              <Link className="btn" to="/courses/new"><Icon name="plus" /> Создать курс</Link>
            ) : user ? (
              <Link className="btn" to="/courses">Мои курсы <Icon name="arrowRight" /></Link>
            ) : (
              <Link className="btn" to="/login">Войти <Icon name="arrowRight" /></Link>
            )}
          </nav>
        </div>
      </header>
      <main id="main-content" className="landing-container" tabIndex={-1}>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-intro">
            <p className="landing-kicker"><Icon name="route" /> Обучение с ИИ-наставником</p>
            <h1 id="landing-title">Учись по своему <span>маршруту</span></h1>
            <p className="landing-summary">Осваивай темы по карте знаний. Наставник подбирает объяснения, помогает на практике и меняет маршрут после каждой темы.</p>
            <div className="landing-actions">
              <Link className="btn primary lg" to={start}>{startLabel} <Icon name="arrowRight" /></Link>
              <a className="landing-text-link" href="#how-it-works">Как это работает <Icon name="chevron" /></a>
            </div>
          </div>
          <RouteExample />
        </section>

        <section className="landing-method" id="how-it-works" aria-labelledby="landing-method-title">
          <div className="landing-method-head">
            <h2 id="landing-method-title">Четыре этапа одной темы</h2>
            <p>От первого вопроса до самостоятельного решения</p>
          </div>
          <ol className="landing-stage-list">
            {stages.map((stage) => (
              <li key={stage.title}>
                <span className="landing-stage-icon"><Icon name={stage.icon} /></span>
                <h3>{stage.title}</h3>
                <p>{stage.summary}</p>
              </li>
            ))}
          </ol>
        </section>
        <div className="landing-outro">
          <div>
            <h2>{user ? "Продолжи свой маршрут" : "Выбери первый курс"}</h2>
            <p>{user ? "Вернись к своим курсам или найди новую тему в каталоге." : "Начни с пролога и собери свою карту знаний по ходу обучения."}</p>
          </div>
          <Link className="btn primary lg" to={start}>{startLabel} <Icon name="arrowRight" /></Link>
        </div>
      </main>
      <footer className="landing-container landing-footer">
        <Brand />
        <a className="landing-text-link" href="#main-content">Наверх <Icon name="arrowUp" /></a>
      </footer>
    </div>
  );
}
