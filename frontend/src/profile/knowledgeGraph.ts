import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { GraphLink, GraphNode } from "../components/MemoryGraph";

export type ProfileT = {
  user: { name: string; email: string; role: string };
  courses: { id: number; title: string; domain: string; progress: number }[];
  talents: string;
  mind_profile: Record<string, number>;
  mind_axes: Record<string, string>;
  strengths: string[];
  growth_areas: string[];
  /** AI-written explanation of the concrete learning moments behind each profile section
   * (keys: mind, writing, meta, autonomy); empty until the profile has been refreshed. */
  section_notes: Record<string, string>;
  profile_updated_at: string | null;
  integrity: {
    typing_cpm: number | null; flags: Record<string, number>; pastes_30d: number; typed_segments_30d: number; total_events: number;
    writing_profile: Record<string, number>; writing_traits: string[];
    calibration: { samples: number; confidence: number; accuracy: number } | null;
  };
  reviews: { cards: number; due: number; reviews: number; retention: number | null };
  memory: { status: { backend: string; ready: boolean; error?: string }; entries: { room: string; content: string; created_at: string }[]; facts: any[] };
};
export type Note = { id: number; title: string; content: string; source: string; course_id: number | null; node_id: number | null; updated_at: string };

/** Topic titles per enrolled course, so a "mastered" memory fact (stored as the node's exact title
 * by services/learning.py) can be placed in its course's cloud via an exact-text fallback match,
 * for facts the AI clustering (see below) hasn't covered yet. */
function useCourseTopics(p: ProfileT | null) {
  const [courseTopics, setCourseTopics] = useState<Record<number, Set<string>>>({});
  const courseIds = p?.courses.map((c) => c.id).join(",") ?? "";
  useEffect(() => {
    if (!courseIds) return;
    let cancelled = false;
    Promise.all(
      courseIds.split(",").map((idStr) => {
        const id = Number(idStr);
        return api.get<{ nodes: { title: string }[] }>(`/courses/${id}`)
          .then((d) => [id, new Set(d.nodes.map((n) => n.title))] as const)
          .catch(() => [id, new Set<string>()] as const);
      }),
    ).then((pairs) => {
      if (!cancelled) setCourseTopics(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [courseIds]);
  return courseTopics;
}

/** Builds the knowledge-map graph: course nodes as cluster hubs, with mastered concepts, memory
 * facts, strengths/growth areas and notes radiating off — clustered under their course when known
 * (AI-assigned `fact.course_id`, see services/profile.py's update_profile, with an exact-title
 * fallback for "mastered" facts), otherwise left unlinked so they float in their own loose cloud
 * instead of being forced onto a course they don't belong to. */
export function buildKnowledgeGraph(p: ProfileT | null, notes: Note[], courseTopics: Record<number, Set<string>>): { nodes: GraphNode[]; links: GraphLink[] } {
  if (!p) return { nodes: [], links: [] };
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  for (const c of p.courses) {
    nodes.push({ id: `course:${c.id}`, label: c.title, kind: "course", cluster: `course:${c.id}`, detail: `${c.title} — ${Math.round(c.progress)}%` });
  }
  p.memory.facts.forEach((f: any, i: number) => {
    const predicate = String(f.predicate ?? f.relation ?? "");
    const obj = String(f.object ?? f.target ?? "");
    if (!obj) return;
    const id = `fact:${i}`;
    let course = typeof f.course_id === "number" ? p.courses.find((c) => c.id === f.course_id) : undefined;
    if (!course && predicate === "mastered") course = p.courses.find((c) => courseTopics[c.id]?.has(obj));
    nodes.push({
      id, label: obj, kind: predicate === "mastered" ? "mastered" : "fact",
      cluster: course ? `course:${course.id}` : undefined, detail: predicate ? `${predicate}: ${obj}` : obj,
    });
    if (course) links.push({ source: `course:${course.id}`, target: id });
  });
  p.strengths.forEach((s, i) => nodes.push({ id: `strength:${i}`, label: s, kind: "strength", detail: `Сильная сторона: ${s}` }));
  p.growth_areas.forEach((s, i) => nodes.push({ id: `growth:${i}`, label: s, kind: "growth", detail: `Зона роста: ${s}` }));
  notes.forEach((n) => {
    const id = `note:${n.id}`;
    const course = n.course_id != null ? p.courses.find((c) => c.id === n.course_id) : undefined;
    nodes.push({ id, label: n.title, kind: "note", cluster: course ? `course:${course.id}` : undefined, detail: n.content.slice(0, 180) });
    if (course) links.push({ source: `course:${course.id}`, target: id });
  });
  return { nodes, links };
}

export function useKnowledgeGraph(p: ProfileT | null, notes: Note[]) {
  const courseTopics = useCourseTopics(p);
  return useMemo(() => buildKnowledgeGraph(p, notes, courseTopics), [p, notes, courseTopics]);
}
