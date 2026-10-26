/**
 * Tools the course author made. Both kinds sit in the same dock and canvas as the built-in ones:
 * - formula: a no-code calculator (see ./formula.ts);
 * - html: the author's page in a sandboxed iframe. The frame has an opaque origin (no `allow-same-origin`),
 *   so it cannot reach the site's storage, cookies or API; a CSP meta blocks network requests from it.
 */
import { useEffect, useMemo, useRef } from "react";
import { useToolInstanceId, useToolState, useToolSummary } from "./instance";
import { defaultValues, evalFormula, formulaHtml, type FormulaSpec } from "./formula";
import { logTool } from "./shared";

export type CustomToolDto = {
  id: number; tool_id: string; name: string; icon: string; description: string; kind: "formula" | "html";
  origin: "manual" | "ai"; spec: any; code: string; prompt: string; enabled: boolean; position: number;
};

// ---------- formula ----------

export function FormulaView({ spec, toolId, name }: { spec: FormulaSpec; toolId: string; name: string }) {
  const instance = useToolInstanceId();
  const [typed, setTyped] = useToolState<Record<string, string>>("vals", {});
  const defaults = useMemo(() => defaultValues(spec), [spec]);
  const values = { ...defaults, ...typed };
  const results = evalFormula(spec, values);

  useToolSummary(() => {
    const ins = spec.inputs.map((i) => `${i.label}=${values[i.key]}${i.unit ? " " + i.unit : ""}`).join(", ");
    const outs = spec.outputs.map((o) => `${o.label}=${results[o.key]?.text}${o.unit ? " " + o.unit : ""}`).join(", ");
    return `${name}: ${ins} → ${outs}`;
  });

  return (
    <div className="ft">
      {spec.notes && <div className="small muted ft-notes">{spec.notes}</div>}
      <div className="ft-inputs">
        {spec.inputs.map((i) => {
          const n = Number(values[i.key]);
          const out = values[i.key] !== "" && ((i.min != null && n < i.min) || (i.max != null && n > i.max));
          return (
            <label key={i.key} className={`ft-row ${out ? "out" : ""}`} title={out ? `Вне диапазона${i.min != null ? ` от ${i.min}` : ""}${i.max != null ? ` до ${i.max}` : ""}` : undefined}>
              <span className="ft-label">{i.label}{i.unit && <i>{i.unit}</i>}</span>
              <input type="number" step="any" inputMode="decimal" value={values[i.key]} min={i.min} max={i.max}
                onChange={(e) => { setTyped({ ...typed, [i.key]: e.target.value }); logTool(toolId, { instance }); }} />
            </label>
          );
        })}
      </div>
      <div className="ft-results">
        {spec.outputs.map((o) => (
          <div key={o.key} className={`ft-res ${results[o.key]?.error ? "err" : ""}`} title={results[o.key]?.error}>
            <span>{o.label}</span>
            <b>{results[o.key]?.text}{o.unit && results[o.key]?.text !== "—" ? ` ${o.unit}` : ""}</b>
          </div>
        ))}
      </div>
      <details className="ft-formulas">
        <summary className="small muted">Формулы</summary>
        {spec.outputs.map((o) => {
          const html = formulaHtml(o);
          return html ? <div key={o.key} className="ft-tex" dangerouslySetInnerHTML={{ __html: html }} /> : <code key={o.key} className="small">{o.key} = {o.expr}</code>;
        })}
      </details>
      {typed && Object.keys(typed).length > 0 && (
        <button className="link-btn" onClick={() => setTyped({})}>↺ значения по умолчанию</button>
      )}
    </div>
  );
}

// ---------- HTML / JS ----------

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "font-src data: https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const BASE_CSS =
  "html{color-scheme:dark}*{box-sizing:border-box}html,body{margin:0}body{padding:8px;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e2e5e9;background:transparent}" +
  "button,.btn{font:inherit;color:#e2e5e9;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 12px;cursor:pointer}" +
  "button:hover,.btn:hover{background:rgba(255,255,255,.13)}" +
  "input,select,textarea{font:inherit;color:#e2e5e9;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 8px;max-width:100%}" +
  "input[type=range]{padding:0}a{color:#6bada5}canvas,svg,img{max-width:100%}";

/** JSON for inlining in a <script>: no "</script>" breakouts, no raw line separators. */
const safeJson = (value: unknown) => {
  const escape = (code: number) => String.fromCharCode(92) + "u" + code.toString(16).padStart(4, "0"); // a backslash-u sequence, as text
  return JSON.stringify(value ?? {})
    .split("<").join(escape(0x3c))
    .split(String.fromCharCode(0x2028)).join(escape(0x2028))
    .split(String.fromCharCode(0x2029)).join(escape(0x2029));
};

/** Page-side API: Meraki.state (saved state), Meraki.save(obj), Meraki.describe(text). Errors are reported to the author. */
const BRIDGE = (state: unknown) =>
  `<script>(function(){var send=function(t,p){try{parent.postMessage(Object.assign({meraki:1,type:t},p),"*")}catch(e){}};` +
  `window.Meraki={state:${safeJson(state)},` +
  `save:function(s){try{JSON.stringify(s)}catch(e){return}window.Meraki.state=s;send("save",{state:s})},` +
  `describe:function(t){send("describe",{text:String(t)})}};` +
  `window.addEventListener("error",function(e){send("error",{message:(e.message||"Ошибка")+(e.lineno?" (строка "+e.lineno+")":"")})});` +
  `window.addEventListener("unhandledrejection",function(e){send("error",{message:String(e.reason&&e.reason.message||e.reason)})})})();</script>`;

/** The author's page with the guard rails (CSP, base styles, Meraki API) placed first in <head>. */
export function buildSrcDoc(code: string, state: unknown): string {
  const prelude = `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta charset="utf-8"><style>${BASE_CSS}</style>${BRIDGE(state)}`;
  const head = code.match(/<head[^>]*>/i);
  if (head) return code.replace(head[0], head[0] + prelude);
  const html = code.match(/<html[^>]*>/i);
  if (html) return code.replace(html[0], `${html[0]}<head>${prelude}</head>`);
  return `<!doctype html><html><head>${prelude}</head><body>${code}</body></html>`;
}

export function HtmlToolView({ code, height, toolId, name, onError }: {
  code: string; height: number; toolId: string; name: string; onError?: (message: string) => void;
}) {
  const instance = useToolInstanceId();
  const [saved, setSaved] = useToolState<Record<string, unknown>>("state", {});
  const frame = useRef<HTMLIFrameElement>(null);
  const summary = useRef("");
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const initial = useRef(saved); // the page starts from what was saved; later saves must not reload it
  const srcDoc = useMemo(() => buildSrcDoc(code, initial.current), [code]);

  useToolSummary(() => (summary.current ? `${name}: ${summary.current}` : name));

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow) return; // only our own frame
      const d = e.data as { meraki?: number; type?: string; state?: unknown; text?: unknown; message?: unknown } | null;
      if (!d || d.meraki !== 1) return;
      if (d.type === "save" && d.state && typeof d.state === "object") {
        setSaved(d.state as Record<string, unknown>);
        logTool(toolId, { instance });
      } else if (d.type === "describe") {
        summary.current = String(d.text ?? "").slice(0, 400);
      } else if (d.type === "error") {
        onErrorRef.current?.(String(d.message ?? "Ошибка"));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <iframe ref={frame} className="html-tool" title={name} sandbox="allow-scripts" srcDoc={srcDoc} style={{ height }} />;
}

// ---------- the dock / canvas entry ----------

export function CustomToolView({ tool }: { tool: CustomToolDto }) {
  return tool.kind === "formula" ? (
    <FormulaView spec={tool.spec as FormulaSpec} toolId={tool.tool_id} name={tool.name} />
  ) : (
    <HtmlToolView code={tool.code} height={tool.spec?.height ?? 360} toolId={tool.tool_id} name={tool.name} />
  );
}
