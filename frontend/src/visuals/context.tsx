/**
 * Where the lecture text finds its visuals: the tutor writes a marker `[[visual:12]]` on its own line, Markdown
 * replaces it with the visual. The lecture page provides the topic's approved visuals up front; anything else
 * (a note saved from a lecture) is fetched once and cached.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { VisualDto } from "./types";
import VisualView from "./VisualView";

type Ctx = { byId: Map<number, VisualDto>; courseId: number; nodeId: number };
const VisualsCtx = createContext<Ctx | null>(null);

const fetched = new Map<number, Promise<VisualDto | null>>();

export function VisualsProvider({ items, courseId, nodeId, children }: { items: VisualDto[]; courseId: number; nodeId: number; children: ReactNode }) {
  const value = useMemo(() => ({ byId: new Map(items.map((v) => [v.id, v])), courseId, nodeId }), [items, courseId, nodeId]);
  return <VisualsCtx.Provider value={value}>{children}</VisualsCtx.Provider>;
}

function load(id: number): Promise<VisualDto | null> {
  let p = fetched.get(id);
  if (!p) {
    p = api.get<VisualDto>(`/visuals/${id}`).catch(() => null);
    fetched.set(id, p);
  }
  return p;
}

/** A marker in the tutor's text. Unknown or hidden visuals render nothing: the text reads fine without them.
 * Inside a lecture only the topic's own approved visuals are shown, so a wrong number never pulls in a foreign one. */
export function VisualRef({ id }: { id: number }) {
  const ctx = useContext(VisualsCtx);
  const known = ctx?.byId.get(id);
  const [visual, setVisual] = useState<VisualDto | null | undefined>(known);
  useEffect(() => {
    if (known || ctx) { setVisual(known ?? null); return; }
    let live = true;
    load(id).then((v) => { if (live) setVisual(v); });
    return () => { live = false; };
  }, [id, known, ctx]);
  if (!visual) return null;
  return <VisualView visual={visual} courseId={ctx?.courseId} nodeId={ctx?.nodeId} />;
}

const MARKER = /\[\[visual:(\d+)\]\]/g;
// while the reply streams in, a half-typed marker at the very end is hidden instead of flashing as text
const PARTIAL = /\[(?:\[(?:v(?:i(?:s(?:u(?:a(?:l(?::\d*(?:\])?)?)?)?)?)?)?)?)?$/;

/** The text split into Markdown pieces and visual markers. */
export function splitMarkers(text: string): ({ md: string } | { visual: number })[] {
  const src = text.replace(PARTIAL, "");
  const out: ({ md: string } | { visual: number })[] = [];
  let last = 0;
  for (const m of src.matchAll(MARKER)) {
    if (m.index! > last) out.push({ md: src.slice(last, m.index) });
    out.push({ visual: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ md: src.slice(last) });
  return out;
}
