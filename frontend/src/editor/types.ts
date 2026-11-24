import type { GNode } from "../components/GraphView";

export type Meta = { domains: Record<string, string>; tools: Record<string, string> };
export type Material = { id: number; filename: string; kind: string; chars: number };
export type RouteSettings = { reorder: boolean; modes: boolean; bridges: boolean; adventures: boolean };
export type TopicNode = GNode & { key: string; objectives: string[]; concepts: string[]; order_index: number };
export type Edge = { source: number; target: number };

export type CourseFull = {
  id: number; title: string; description: string; domain: string; status: string; status_detail: string; summary: string;
  tools: string[]; published: boolean; enrolled: boolean; is_author: boolean; materials: Material[]; route_settings: RouteSettings;
  nodes: TopicNode[];
  edges: Edge[];
};

export type ExcerptKind = "topic" | "task";
export type UseIn = "practice" | "exam" | "";

/** A passage of the materials the author marked as mandatory for a topic. */
export type Excerpt = {
  id: number; node_id: number | null; material_id: number | null; source: string; kind: ExcerptKind; use_in: UseIn;
  title: string; content: string; char_start: number | null; char_end: number | null; position: number;
};
export type ExcerptLimits = { topic_chars: number; task_chars: number; theory_budget: number };

export const KIND_NAMES: Record<string, string> = { textbook: "учебник / теория", tasks: "задания", other: "другое" };

export type StepKey = "basics" | "materials" | "topics" | "pins" | "visuals" | "tools" | "launch";

/** Author topics in study order: the author's order wherever the prerequisite arrows allow it. */
export function studyOrder(nodes: TopicNode[], edges: Edge[]): TopicNode[] {
  const remaining = nodes.filter((n) => !n.personal).sort((a, b) => a.order_index - b.order_index || a.id - b.id);
  const result: TopicNode[] = [];
  while (remaining.length) {
    const left = new Set(remaining.map((n) => n.id));
    const i = Math.max(0, remaining.findIndex((n) => !edges.some((e) => e.target === n.id && left.has(e.source))));
    result.push(...remaining.splice(i, 1));
  }
  return result;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** "tasks" for names that look like problem books, "textbook" otherwise; the author can change it afterwards. */
export function guessKind(filename: string): string {
  return /(задач|задан|упражн|практик|сборник|тест|вопрос|task|problem|exercise|quiz|homework)/i.test(filename) ? "tasks" : "textbook";
}
