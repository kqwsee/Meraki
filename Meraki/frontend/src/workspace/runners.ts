/** In-browser interpreters: Python (Pyodide worker), JavaScript (sandboxed worker), SQL (sql.js / SQLite WASM). */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";

export type OutKind = "out" | "err" | "sys";
export type OnOut = (kind: OutKind, text: string) => void;

const TIMEOUT_MS = 20000;

// ---------- Python ----------
let pyWorker: Worker | null = null;
let pyRun = 0;
let pyLoaded = false; // the first run also downloads Pyodide
// One worker serves every Python widget, so replies are routed by run id and runs are serialised:
// a single `onmessage` (the old design) made two concurrent widgets overwrite each other's handler.
const pyHandlers = new Map<number, (msg: any) => void>();
let pyQueue: Promise<void> = Promise.resolve();

function getPy() {
  if (!pyWorker) {
    pyWorker = new Worker("/pyodide-worker.js");
    pyWorker.onmessage = (e: MessageEvent) => pyHandlers.get(e.data?.id)?.(e.data);
  }
  return pyWorker;
}

/** A worker stuck in an infinite loop can't be reused — terminate it and fail the runs still waiting. */
function killPy() {
  pyWorker?.terminate();
  pyWorker = null;
  pyLoaded = false;
  const pending = [...pyHandlers.values()];
  pyHandlers.clear();
  for (const handler of pending) handler({ type: "killed", text: "\nВыполнение прервано: интерпретатор перезапущен.\n" });
}

export function runPython(opts: { files: Record<string, string>; entry?: string; code?: string; stdin?: string }, onOut: OnOut): Promise<void> {
  const exec = () =>
    new Promise<void>((resolve) => {
      const worker = getPy();
      const id = ++pyRun;
      let settled = false;
      let timer = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        pyHandlers.delete(id);
        resolve();
      };
      timer = window.setTimeout(() => {
        onOut("err", `\n⏱ Превышено время выполнения (${TIMEOUT_MS / 1000} с) — выполнение остановлено.\n`);
        pyHandlers.delete(id);
        killPy();
        finish();
      }, TIMEOUT_MS + (pyLoaded ? 0 : 60000));
      pyHandlers.set(id, (msg) => {
        if (msg.type === "done") {
          pyLoaded = true;
          finish();
        } else if (msg.type === "killed") {
          onOut("err", msg.text);
          finish();
        } else onOut(msg.type, msg.text);
      });
      worker.postMessage({ id, files: opts.files, entry: opts.entry, code: opts.code ?? null, stdin: opts.stdin ?? "" });
    });

  const next = pyQueue.then(exec, exec);
  pyQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---------- JavaScript ----------
const JS_WORKER_SRC = `
const fmt = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x, null, 1) } catch { return String(x) } })()).join(" ");
self.onmessage = async (e) => {
  console.log = (...a) => postMessage({ type: "out", text: fmt(a) + "\\n" });
  console.info = console.log; console.warn = console.log;
  console.error = (...a) => postMessage({ type: "err", text: fmt(a) + "\\n" });
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const r = await new AsyncFn(e.data.code)();
    if (r !== undefined) postMessage({ type: "out", text: "← " + fmt([r]) + "\\n" });
  } catch (err) {
    postMessage({ type: "err", text: String((err && err.stack) || err) + "\\n" });
  }
  postMessage({ type: "done" });
};`;

export function runJavaScript(code: string, onOut: OnOut): Promise<void> {
  const url = URL.createObjectURL(new Blob([JS_WORKER_SRC], { type: "text/javascript" }));
  const worker = new Worker(url);
  return new Promise((resolve) => {
    const finish = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve();
    };
    const timer = window.setTimeout(() => {
      onOut("err", `\n⏱ Превышено время выполнения (${TIMEOUT_MS / 1000} с).\n`);
      finish();
    }, TIMEOUT_MS);
    worker.onmessage = (e) => {
      if (e.data.type === "done") {
        window.clearTimeout(timer);
        finish();
      } else onOut(e.data.type, e.data.text);
    };
    worker.postMessage({ code });
  });
}

// ---------- SQL ----------
let sqlDb: Promise<Database> | null = null;

export function resetSql() {
  sqlDb = null;
}

export type SqlResult = { columns: string[]; values: unknown[][] }[];

export async function runSql(code: string): Promise<SqlResult> {
  if (!sqlDb) sqlDb = initSqlJs({ locateFile: () => wasmUrl }).then((SQL) => new SQL.Database());
  const db = await sqlDb;
  return db.exec(code) as SqlResult;
}

export type SqlSession = { exec: (code: string) => Promise<SqlResult>; reset: () => void };

/**
 * Database of its own, for a SQL tool that lives on the canvas: two widgets must not share a schema
 * and one "Сбросить БД" must not wipe the other's tables.
 */
export function createSqlSession(): SqlSession {
  let db: Promise<Database> | null = null;
  const open = () => (db ??= initSqlJs({ locateFile: () => wasmUrl }).then((SQL) => new SQL.Database()));
  return {
    async exec(code: string) {
      const database = await open();
      return database.exec(code) as SqlResult;
    },
    reset() {
      db = null;
    },
  };
}

export function formatSql(res: SqlResult): string {
  if (!res.length) return "OK (нет строк)\n";
  return res
    .map(({ columns, values }) => {
      const widths = columns.map((c, i) => Math.min(30, Math.max(c.length, ...values.map((r) => String(r[i] ?? "NULL").length))));
      const line = (cells: unknown[]) => cells.map((v, i) => String(v ?? "NULL").slice(0, 30).padEnd(widths[i])).join(" | ");
      return [line(columns), widths.map((w) => "-".repeat(w)).join("-+-"), ...values.map(line), `(${values.length} строк)`].join("\n");
    })
    .join("\n\n") + "\n";
}

export function languageOf(path: string): "python" | "javascript" | "sql" | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "py") return "python";
  if (ext === "js" || ext === "mjs") return "javascript";
  if (ext === "sql") return "sql";
  return null;
}
