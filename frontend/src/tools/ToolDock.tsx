import { Suspense, useMemo, useState } from "react";
import { tracker } from "../telemetry/tracker";
import { TOOL_BY_ID, TOOLS, type ToolDef } from "./registry";

export default function ToolDock({ tools, domain, courseId, nodeId }: { tools: string[]; domain: string; courseId: number; nodeId: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState<string[]>([]);

  const course = useMemo(() => {
    const ids = tools.length ? tools : TOOLS.filter((t) => t.domains.includes(domain) || t.domains.includes("general")).map((t) => t.id);
    return [...new Set([...ids, ...extra])].map((id) => TOOL_BY_ID[id]).filter(Boolean) as ToolDef[];
  }, [tools, domain, extra]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return TOOLS.filter((t) => `${t.name} ${t.keywords} ${t.id}`.toLowerCase().includes(q));
  }, [query]);

  function toggle(t: ToolDef) {
    setOpen((o) => {
      const next = !o[t.id];
      if (next) tracker.log("tool_open", t.id);
      return { ...o, [t.id]: next };
    });
  }

  const card = (t: ToolDef) => (
    <div key={t.id} className="tool-card">
      <div className="tool-head" onClick={() => toggle(t)}>
        <span className="ico">{t.icon}</span>
        <span style={{ flex: 1 }}>{t.name}</span>
        <span className="muted">{open[t.id] ? "▾" : "▸"}</span>
      </div>
      {open[t.id] && (
        <div className="tool-body">
          <Suspense fallback={<span className="spinner" />}>
            <t.component courseId={courseId} nodeId={nodeId} />
          </Suspense>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="ws-section-title" style={{ padding: "12px 14px 0" }}>🧰 Инструменты</div>
      <div className="ws-scroll" style={{ padding: "8px 12px" }}>
        <div className="tool-list">{course.map(card)}</div>
      </div>
      <div className="tool-search">
        {results.length > 0 && (
          <div className="tool-list" style={{ maxHeight: 220, overflowY: "auto", marginBottom: 8 }}>
            {results.map((t) => (
              <div key={t.id} className="tool-head" style={{ border: "1px solid var(--border)", borderRadius: 8 }}
                onClick={() => {
                  setExtra((e) => (e.includes(t.id) ? e : [...e, t.id]));
                  setOpen((o) => ({ ...o, [t.id]: true }));
                  tracker.log("tool_open", t.id, { via: "search" });
                  setQuery("");
                }}>
                <span className="ico">{t.icon}</span>
                <span style={{ flex: 1 }}>{t.name}</span>
                {course.some((c) => c.id === t.id) ? <span className="badge">есть</span> : <span className="badge accent">+ добавить</span>}
              </div>
            ))}
          </div>
        )}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="🔍 Найти среди всех инструментов…" />
      </div>
    </>
  );
}
