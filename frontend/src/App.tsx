import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";

// heavy pages (canvas, editors, graph) load on demand
const CourseEditor = lazy(() => import("./pages/CourseEditor"));
const CoursePage = lazy(() => import("./pages/CoursePage"));
const NodePage = lazy(() => import("./pages/NodePage"));
const Profile = lazy(() => import("./pages/Profile"));
const Reviews = lazy(() => import("./pages/Reviews"));

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [due, setDue] = useState(0);
  useEffect(() => {
    api.get<{ due: number }>("/reviews").then((r) => setDue(r.due)).catch(() => undefined);
  }, [loc.pathname]);
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <img src="/favicon.svg" alt="" />
          Meraki
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>Главная</NavLink>
          <NavLink to="/reviews">
            Повторение {due > 0 && <span className="badge accent">{due}</span>}
          </NavLink>
          <NavLink to="/profile">Профиль</NavLink>
        </nav>
        <div className="user-chip">
          <span>{user?.name}</span>
          <span className="badge">{user?.role === "author" ? "автор" : "ученик"}</span>
          <button
            className="btn sm ghost"
            onClick={async () => {
              await logout();
              nav("/login");
            }}
          >
            Выйти
          </button>
        </div>
      </header>
      <Suspense fallback={<div className="loading-block"><span className="spinner" /></div>}>
        {wide ? <main className="page-wide">{children}</main> : <main className="page">{children}</main>}
      </Suspense>
    </div>
  );
}

function Private({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-block"><span className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Shell wide={wide}>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Private><Dashboard /></Private>} />
      <Route path="/courses/new" element={<Private><CourseEditor /></Private>} />
      <Route path="/courses/:id/edit" element={<Private><CourseEditor /></Private>} />
      <Route path="/courses/:id" element={<Private><CoursePage /></Private>} />
      <Route path="/learn/:nodeId" element={<Private wide><NodePage /></Private>} />
      <Route path="/profile" element={<Private><Profile /></Private>} />
      <Route path="/reviews" element={<Private><Reviews /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
