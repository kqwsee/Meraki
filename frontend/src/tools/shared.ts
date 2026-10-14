import { all, create } from "mathjs";
import { tracker } from "../telemetry/tracker";

export const math = create(all, {});

export type ToolProps = { courseId: number; nodeId: number };

let lastLog: Record<string, number> = {};
/**
 * Tool usage is part of the learner's action record (throttled to one event per 3 s per tool).
 * Widgets pass their instance id, so two copies of the same tool on the canvas don't share the window.
 */
export function logTool(tool: string, data: Record<string, unknown> = {}) {
  const key = typeof data.instance === "string" && data.instance ? `${tool}:${data.instance}` : tool;
  const now = Date.now();
  if (now - (lastLog[key] ?? 0) < 3000) return;
  lastLog = { ...lastLog, [key]: now };
  tracker.log("tool_use", tool, data);
}
