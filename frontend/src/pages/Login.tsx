import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import Brand from "../components/Brand";
import { Icon } from "../components/Icon";
import { ErrorBox } from "../components/ui";

export default function Login() {
  const { user, login, register, loading } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const mode = params.get("mode") === "register" ? "register" : "login";
  const from = typeof location.state?.from === "string" ? location.state.from : "/courses";
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("student");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={from} replace />;

  function selectMode(value: "login" | "register") {
    setError(null);
    setParams(value === "register" ? { mode: value } : {}, { replace: true, state: location.state });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register({ email, name, password, role, consent });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-hero">
          <Brand />
          <h1>{mode === "login" ? "Вход в Meraki" : "Создать аккаунт"}</h1>
        </div>
        <div className="card">
          <div className="tabs mb">
            <button aria-pressed={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => selectMode("login")}>Вход</button>
            <button aria-pressed={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => selectMode("register")}>Регистрация</button>
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
              {mode === "login" ? "Email или логин" : "Email"}
              <input
                type={mode === "login" ? "text" : "email"} value={email} onChange={(e) => setEmail(e.target.value)} required
                autoComplete={mode === "login" ? "username" : "email"}
              />
            </label>
            <label className="field">
              Пароль
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                minLength={mode === "register" ? 6 : undefined}
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
            <button className="btn primary lg" disabled={loading || busy || (mode === "register" && !consent)}>
              {busy ? <><span className="spinner" /> {mode === "login" ? "Входим" : "Создаём аккаунт"}</> :
                <>{mode === "login" ? "Войти" : "Создать аккаунт"} <Icon name="arrowRight" /></>}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
