import { all, create } from "mathjs";
import { tracker } from "../telemetry/tracker";

export const math = create(all, {});

export type ToolProps = { courseId: number; nodeId: number };

let lastLog: Record<string, number> = {};
/** Tool usage is part of the learner's action record (throttled to one event per 3 s per tool). */
export function logTool(tool: string, data: Record<string, unknown> = {}) {
  const now = Date.now();
  if (now - (lastLog[tool] ?? 0) < 3000) return;
  lastLog = { ...lastLog, [tool]: now };
  tracker.log("tool_use", tool, data);
}
