const TOKEN_KEY = "meraki_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  const t = getToken();
  if (t) h["Authorization"] = `Bearer ${t}`;
  return h;
}

async function handle<T>(res: Response, redirectOnUnauthorized = true): Promise<T> {
  if (res.status === 401) {
    setToken(null);
    if (redirectOnUnauthorized && location.pathname !== "/" && !location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
  }
  const where = res.url ? res.url.replace(location.origin, "") : "";
  if (!res.ok) {
    let msg = `Ошибка ${res.status}${where ? ` (${where})` : ""}`;
    try {
      const data = await res.json();
      msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data);
    } catch {
      // A dev server answers unknown /api paths with index.html, so "Unexpected token '<'" is not
      // a data error: it almost always means the backend was not restarted or the route is missing.
      if ((res.headers.get("content-type") || "").includes("text/html")) {
        msg = htmlInsteadOfJsonMessage(where);
      }
    }
    throw new ApiError(res.status, msg);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(res.status, htmlInsteadOfJsonMessage(where));
  }
  return res.json() as Promise<T>;
}

function htmlInsteadOfJsonMessage(where: string): string {
  return (
    `Сервер вернул страницу вместо данных${where ? ` по адресу ${where}` : ""}. ` +
    "Обычно это значит, что backend не успел перезапуститься или вкладка была открыта до перезапуска. " +
    "Обновите страницу (Ctrl+F5); если ошибка повторяется — перезапустите backend."
  );
}

export const api = {
  // no-store: profile/talent/writing views poll in a loop, and a heuristically cached GET would
  // silently freeze the live numbers in a long-open tab
  get: <T = any>(url: string, options?: { redirectOnUnauthorized?: boolean }) =>
    fetch(`/api${url}`, { headers: headers(false), cache: "no-store" })
      .then((r) => handle<T>(r, options?.redirectOnUnauthorized)),
  post: <T = any>(url: string, body?: unknown) =>
    fetch(`/api${url}`, { method: "POST", headers: headers(), body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  put: <T = any>(url: string, body?: unknown) =>
    fetch(`/api${url}`, { method: "PUT", headers: headers(), body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  patch: <T = any>(url: string, body?: unknown) =>
    fetch(`/api${url}`, { method: "PATCH", headers: headers(), body: JSON.stringify(body ?? {}) }).then((r) => handle<T>(r)),
  del: <T = any>(url: string) => fetch(`/api${url}`, { method: "DELETE", headers: headers(false) }).then((r) => handle<T>(r)),
  upload: <T = any>(url: string, form: FormData) =>
    fetch(`/api${url}`, { method: "POST", headers: headers(false), body: form }).then((r) => handle<T>(r)),
  /** POST with keepalive: survives page unload (telemetry, session end). */
  beacon: (url: string, body: unknown) =>
    fetch(`/api${url}`, { method: "POST", headers: headers(), body: JSON.stringify(body), keepalive: true }).catch(() => undefined),
};

export type StreamEvent = { type: "delta"; text: string } | { type: "error"; message: string } | { type: "done"; message: any };

/** Server-sent events over a POST request (the chat endpoints stream the tutor's reply). */
export async function streamPost(url: string, body: unknown, onEvent: (ev: StreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`/api${url}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    await handle(res);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            onEvent(JSON.parse(line.slice(6)));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
  }
}
