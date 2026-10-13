import { useRef, useState } from "react";
import { useWorkspace } from "../workspace/context";
import { createSqlSession, formatSql, runJavaScript, runPython, type OutKind, type SqlSession } from "../workspace/runners";
import { useToolInstanceId, useToolState } from "./instance";
import { logTool } from "./shared";

function Runner({ lang, sample }: { lang: "python" | "javascript" | "sql"; sample: string }) {
  const ws = useWorkspace();
  const instanceId = useToolInstanceId();
  const [code, setCode] = useToolState("code", sample);
  const [out, setOut] = useState<{ k: OutKind; t: string }[]>([]);
  const [busy, setBusy] = useState(false);
  // every SQL widget keeps its own database, so schemas don't leak between them
  const sqlRef = useRef<SqlSession | null>(null);
  const sql = () => (sqlRef.current ??= createSqlSession());
  async function run() {
    setBusy(true);
    setOut([]);
    const push = (k: OutKind, t: string) => setOut((o) => [...o, { k, t }]);
    try {
      if (lang === "python") await runPython({ files: {}, code }, push);
      else if (lang === "javascript") await runJavaScript(code, push);
      else {
        try {
          push("out", formatSql(await sql().exec(code)));
        } catch (e: any) {
          push("err", String(e.message ?? e));
        }
      }
    } finally {
      setBusy(false);
      logTool(lang, { instance: instanceId ?? undefined, chars: code.length });
    }
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={6} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}
        style={{ fontFamily: "var(--mono)", fontSize: 12.5 }} data-copy-source="workspace"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run();
          if (e.key === "Tab") {
            e.preventDefault();
            const t = e.currentTarget;
            const s = t.selectionStart;
            setCode(code.slice(0, s) + "    " + code.slice(t.selectionEnd));
            requestAnimationFrame(() => t.setSelectionRange(s + 4, s + 4));
          }
        }} />
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm primary" onClick={run} disabled={busy}>{busy ? <span className="spinner" /> : "▶ Ctrl+Enter"}</button>
        {lang === "sql" && <button className="btn sm" onClick={() => { sql().reset(); setOut([{ k: "sys", t: "База очищена\n" }]); }}>Сбросить БД</button>}
        {ws?.activePath && <span className="small muted">файл целиком — кнопкой ▶ над редактором</span>}
      </div>
      {out.length > 0 && (
        <div className="tool-out" style={{ background: "#0f172a", color: "#e2e8f0" }}>
          {out.map((o, i) => <span key={i} style={{ color: o.k === "err" ? "#fca5a5" : o.k === "sys" ? "#94a3b8" : undefined }}>{o.t}</span>)}
        </div>
      )}
    </div>
  );
}

export const PythonTool = () => <Runner lang="python" sample={'nums = [3, 1, 4, 1, 5]\nprint(sorted(nums), sum(nums))'} />;
export const JsTool = () => <Runner lang="javascript" sample={"const xs = [1, 2, 3].map(x => x * x);\nconsole.log(xs);"} />;
export const SqlTool = () => (
  <Runner lang="sql" sample={"CREATE TABLE IF NOT EXISTS t(id INTEGER, name TEXT);\nINSERT INTO t VALUES (1, 'Ада'), (2, 'Алан');\nSELECT * FROM t;"} />
);
