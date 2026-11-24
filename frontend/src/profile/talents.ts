/** Shared types and helpers for the talent evidence pages (see backend/app/services/talents.py). */

export type TalentSignalT = {
  id: number;
  kind: "message" | "profile" | string;
  talent: string;
  message_id: number | null;
  node_id: number | null;
  node_title: string;
  course_id: number | null;
  course_title: string;
  stage: string;
  delta: number;
  score_before: number;
  score_after: number;
  reason: string;
  excerpt: string;
  /** the full learner message the evidence points at (empty for profile-level signals) */
  message_content: string;
  /** when the learner actually sent it (null for profile-level signals) */
  message_created_at: string | null;
  before_text: string;
  after_text: string;
  revision_kind: string;
  created_at: string;
};

export type TalentInfoT = {
  key: string;
  label: string;
  title: string;
  icon: string;
  hint: string;
  description: string;
  score: number;
  previous: number;
  delta: number;
  signals: number;
  last_at: string | null;
  recent?: TalentSignalT[];
};

export type TalentOverviewT = {
  updated_at: string | null;
  intro: string;
  pending: number;
  analyzing: boolean;
  talents: TalentInfoT[];
};

export type TalentDetailT = { talent: TalentInfoT; analyzing: boolean; signals: TalentSignalT[] };

export type WritingRevisionT = { kind: string; before: string; after: string };

export type WritingMetricsT = {
  chars: number;
  ms: number;
  cpm: number | null;
  pauses_2s: number;
  backspaces: number;
  iki_median: number | null;
  iki_cv: number | null;
  sentence_pauses: number;
};

export type WritingMessageT = {
  id: number;
  content: string;
  created_at: string;
  node_id: number | null;
  node_title: string;
  course_id: number | null;
  course_title: string;
  stage: string;
  metrics: WritingMetricsT;
  baseline_cpm: number | null;
  notes: string[];
  revisions: WritingRevisionT[];
};

export type WritingEvidenceT = {
  baseline_cpm: number | null;
  traits: string[];
  writing_profile: Record<string, number>;
  messages: WritingMessageT[];
};

export const STAGE_LABELS: Record<string, string> = {
  prologue: "Пролог",
  lecture: "Лекция",
  practice: "Практика",
  exam: "Экзамен",
  review: "Повторение",
};

export const REVISION_LABELS: Record<string, string> = {
  paste: "вставка",
  delete: "удаление",
  drop: "перетаскивание",
  insert: "правка",
};

/** "…" + the tail of the unchanged prefix, the changed middle, and the head of the suffix. */
function context(prefix: string, middle: string, suffix: string, middleLimit = 700) {
  const beforeChars = prefix.slice(-180);
  const afterChars = suffix.slice(0, 180);
  const clamp = (s: string) => (s.length > middleLimit ? `${s.slice(0, middleLimit - 1)}…` : s);
  return {
    prefix: (prefix.length > beforeChars.length ? "…" : "") + beforeChars,
    changed: clamp(middle),
    suffix: afterChars + (suffix.length > afterChars.length ? "…" : ""),
  };
}

export type DraftDiff = {
  before: { prefix: string; changed: string; suffix: string };
  after: { prefix: string; changed: string; suffix: string };
  changed: boolean;
};

/** Word-friendly before/after diff for a draft revision: only the changed span is highlighted. */
export function draftDiff(before: string, after: string): DraftDiff {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  const beforeChanged = before.slice(start, before.length - end);
  const afterChanged = after.slice(start, after.length - end);
  const suffix = before.slice(before.length - end);
  return {
    before: context(before.slice(0, start), beforeChanged, suffix),
    after: context(after.slice(0, start), afterChanged, suffix),
    changed: beforeChanged !== afterChanged,
  };
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  return d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function signed(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}
