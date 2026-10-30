/** One visual of a lecture, as learners see it (the course editor shows the same thing as its preview). */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { HtmlToolView } from "../tools/custom";
import { dropBag, seedBag, ToolInstanceProvider } from "../tools/instance";
import { TOOL_BY_ID } from "../tools/registry";
import Chart from "./Chart";
import Scheme from "./Scheme";
import type { VisualDto } from "./types";

const MermaidView = lazy(() => import("./Mermaid"));

const svgSrc = (code: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;

function ToolPreset({ visual, courseId, nodeId, onError }: { visual: VisualDto; courseId: number; nodeId: number; onError?: (m: string) => void }) {
  const def = TOOL_BY_ID[visual.data?.tool_id];
  const stateKey = JSON.stringify(visual.data?.state ?? {});
  // a fresh widget instance seeded with the example; the learner's changes live only on this page
  const instance = useMemo(() => {
    const id = `vis_${visual.id}_${Math.random().toString(36).slice(2, 8)}`;
    seedBag(id, visual.data?.state ?? {});
    return id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visual.id, stateKey]);
  useEffect(() => () => dropBag(instance), [instance]);
  useEffect(() => {
    if (!def) onError?.(`Инструмент «${visual.data?.tool_id}» не найден`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def]);
  if (!def) return <div className="alert error small">Инструмент «{String(visual.data?.tool_id)}» не найден</div>;
  const Tool = def.component;
  return (
    <div className="vis-tool-box">
      <div className="vis-tool-head small muted">{def.icon} {def.name} · попробуй сам</div>
      <ToolInstanceProvider key={instance} id={instance}>
        <Suspense fallback={<div className="vis-loading"><span className="spinner" /></div>}>
          <Tool courseId={courseId} nodeId={nodeId} />
        </Suspense>
      </ToolInstanceProvider>
    </div>
  );
}

function Credit({ visual }: { visual: VisualDto }) {
  const a = visual.asset;
  if (!a || a.source !== "web") return null;
  return (
    <span className="vis-credit">
      {a.author && <>Автор: {a.author}. </>}
      {a.license && <>Лицензия: {a.license}. </>}
      {a.source_url && <a href={a.source_url} target="_blank" rel="noopener noreferrer">Источник</a>}
    </span>
  );
}

export default function VisualView({ visual, courseId = 0, nodeId = 0, onError, caption = true }: {
  visual: VisualDto;
  courseId?: number;
  nodeId?: number;
  /** The editor shows render errors next to the "fix with AI" button. */
  onError?: (message: string) => void;
  caption?: boolean;
}) {
  const v = visual;
  const [broken, setBroken] = useState(false);
  if (broken && !onError) return null; // a learner never sees a broken visual, the author does (with the reason)
  let body: ReactNode;
  switch (v.kind) {
    case "mermaid":
      body = <Suspense fallback={<div className="vis-loading"><span className="spinner" /></div>}><MermaidView code={v.code} onError={(m) => { setBroken(true); onError?.(m); }} /></Suspense>;
      break;
    case "svg":
      body = (
        <div className="vis-paper">
          <img src={svgSrc(v.code)} alt={v.description || v.title} onError={() => { setBroken(true); onError?.("SVG не отображается: проверьте разметку рисунка"); }} />
        </div>
      );
      break;
    case "chart":
      body = <Chart data={v.data} />;
      break;
    case "scheme":
      body = <Scheme data={v.data} />;
      break;
    case "html":
      body = <HtmlToolView code={v.code} height={v.data?.height ?? 360} toolId={`visual_${v.id}`} name={v.title} onError={onError} />;
      break;
    case "tool":
      body = <ToolPreset visual={v} courseId={courseId} nodeId={nodeId} onError={onError} />;
      break;
    case "image":
      body = v.asset ? (
        <a className="vis-image-link" href={v.asset.url} target="_blank" rel="noopener noreferrer" title="Открыть в полном размере">
          <img src={v.asset.url} alt={v.description || v.title} loading="lazy" width={v.asset.width || undefined} height={v.asset.height || undefined} />
        </a>
      ) : <div className="alert error small">Файл картинки не найден</div>;
      break;
    default:
      body = <div className="alert error small">Неизвестный вид материала</div>;
  }
  return (
    <figure className={`vis vis-${v.kind}`}>
      <div className="vis-body">{body}</div>
      {caption && (v.title || v.asset?.source === "web") && (
        <figcaption>{v.title}<Credit visual={v} /></figcaption>
      )}
    </figure>
  );
}
