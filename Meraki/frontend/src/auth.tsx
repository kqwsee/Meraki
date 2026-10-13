import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";
import { tracker } from "./telemetry/tracker";

export type User = { id: number; email: string; name: string; role: "student" | "author" };

type AuthCtx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; name: string; password: string; role: string; consent: boolean }) => Promise<void>;
  logout: () => Promise<void>;
};

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get<User>("/auth/me")
      .then((u) => {
        setUser(u);
        tracker.start();
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: User }>("/auth/login", { email, password });
    setToken(res.token);
    setUser(res.user);
    tracker.start();
  }, []);

  const register = useCallback(async (data: { email: string; name: string; password: string; role: string; consent: boolean }) => {
    const res = await api.post<{ token: string; user: User }>("/auth/register", data);
    setToken(res.token);
    setUser(res.user);
    tracker.start();
  }, []);

  const logout = useCallback(async () => {
    await tracker.end(); // session summary -> long-term memory
    setToken(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
