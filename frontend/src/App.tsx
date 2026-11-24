import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import Brand from "./components/Brand";
import { Icon } from "./components/Icon";
import { Loading } from "./components/ui";
import Dashboard from "./pages/Dashboard";
import Home from "./pages/Home";
import Login from "./pages/Login";

// heavy pages (canvas, editors, graph) load on demand
const CourseEditor = lazy(() => import("./pages/CourseEditor"));
const CoursePage = lazy(() => import("./pages/CoursePage"));
const Encounter = lazy(() => import("./pages/Encounter"));
const KnowledgeMap = lazy(() => import("./pages/KnowledgeMap"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const NodePage = lazy(() => import("./pages/NodePage"));
const Profile = lazy(() => import("./pages/Profile"));
const ProfileSectionPage = lazy(() => import("./pages/ProfileSectionPage"));
const Reviews = lazy(() => import("./pages/Reviews"));
const TalentDetailPage = lazy(() => import("./pages/TalentDetailPage"));
const TalentsPage = lazy(() => import("./pages/TalentsPage"));

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [due, setDue] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.get<{ due: number }>("/reviews").then((r) => {
      if (!cancelled) setDue(r.due);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [loc.pathname]);
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">К содержанию</a>
      <header className="topbar">
        <Brand />
        <nav className="nav" aria-label="Разделы Meraki">
          <NavLink to="/" end><Icon name="home" /> Главная</NavLink>
          <NavLink to="/courses"><Icon name="book" /> Курсы</NavLink>
          <NavLink to="/reviews">
            <Icon name="refresh" /> Повторение {due > 0 && <span className="nav-count">{due}</span>}
          </NavLink>
          <NavLink to="/profile"><Icon name="user" /> Профиль</NavLink>
        </nav>
        <div className="user-chip">
          <span className="user-name" title={user?.name}>{user?.name}</span>
          <button
            className="btn sm ghost logout-button"
            onClick={async () => {
              await logout();
              nav("/", { replace: true });
            }}
          >
            <Icon name="logout" /> Выйти
          </button>
        </div>
      </header>
      <main id="main-content" className={wide ? "page-wide" : "page"} tabIndex={-1}>
        <Suspense fallback={<Loading text="Загружаем страницу" />}>{children}</Suspense>
      </main>
    </div>
  );
}

function Private({ children, wide, authorOnly }: { children: ReactNode; wide?: boolean; authorOnly?: boolean }) {
  const { user, loading } = useAuth();
  const { pathname, search, hash } = useLocation();
  if (loading) return <Loading text="Загружаем страницу" />;
  if (!user) return <Navigate to="/login" replace state={{ from: pathname + search + hash }} />;
  if (authorOnly && user.role !== "author") return <Navigate to="/courses" replace />;
  return <Shell wide={wide}>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Home />} />
      <Route path="/courses" element={<Private><Dashboard /></Private>} />
      <Route path="/courses/new" element={<Private authorOnly><CourseEditor /></Private>} />
      <Route path="/courses/:id/edit" element={<Private><CourseEditor /></Private>} />
      <Route path="/courses/:id" element={<Private><CoursePage /></Private>} />
      <Route path="/courses/:id/leaderboard" element={<Private><Leaderboard /></Private>} />
      <Route path="/learn/:nodeId" element={<Private wide><NodePage /></Private>} />
      <Route path="/encounters/:id" element={<Private><Encounter /></Private>} />
      <Route path="/profile" element={<Private><Profile /></Private>} />
      <Route path="/profile/graph" element={<Private wide><KnowledgeMap /></Private>} />
      <Route path="/profile/talents" element={<Private><TalentsPage /></Private>} />
      <Route path="/profile/talents/:talent" element={<Private><TalentDetailPage /></Private>} />
      <Route path="/profile/sections/:section" element={<Private><ProfileSectionPage /></Private>} />
      <Route path="/reviews" element={<Private><Reviews /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
