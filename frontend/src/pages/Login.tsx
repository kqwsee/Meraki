import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ErrorBox } from "../components/ui";

export default function Login() {
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("student");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register({ email, name, password, role, consent });
      nav("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-hero">
          <img src="/favicon.svg" alt="" />
          <h1>Учись с <span className="gradient-text">ИИ‑наставником</span></h1>
          <p>Пролог, лекция, практика и экзамен — по твоему личному маршруту в графе знаний.</p>
        </div>
        <div className="card">
          <div className="tabs mb">
            <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Вход</button>
            <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Регистрация</button>
          </div>
          <ErrorBox error={error} />
          <form className="col" onSubmit={submit}>
            {mode === "register" && (
              <label className="field">
                Имя
                <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
              </label>
            )}
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label className="field">
              Пароль
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </label>
            {mode === "register" && (
              <>
                <label className="field">
                  Я хочу
                  <select value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="student">учиться (ученик)</option>
                    <option value="author">создавать курсы и учиться (автор)</option>
                  </select>
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>
                    Согласен(на) на запись учебных действий: сообщений, работы в рабочем пространстве, скорости и ритма ввода,
                    вставок из буфера обмена. Это нужно, чтобы наставник подстраивался под меня и чтобы проверять самостоятельность
                    на экзамене. Медицинских выводов не делается, профиль ввода виден мне в профиле.
                  </span>
                </label>
              </>
            )}
            <button className="btn primary lg" disabled={busy || (mode === "register" && !consent)}>
              {busy ? <span className="spinner" /> : mode === "login" ? "Войти" : "Создать аккаунт"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
