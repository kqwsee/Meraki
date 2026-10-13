/**
 * Tool instances that live on the canvas: identity and geometry (owned by Workspace) plus the
 * per-instance state bag (kept in a module map).
 *
 * The bag is deliberately outside React state: typing into a widget must not re-render the
 * workspace, and only one debounced canvas save has to be scheduled. `useToolState` is a drop-in
 * replacement for `useState` — without an instance provider (i.e. in the dock) it behaves exactly
 * like `useState`, so the same component serves both places.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToolInstance = {
  id: string;
  toolId: string;
  /** Scene coordinates of the widget's top-left corner. */
  x: number;
  y: number;
  /** Screen pixels; widgets keep a constant size while the canvas zooms. `null` height = fit content. */
  w: number;
  h: number | null;
  z: number;
  collapsed?: boolean;
  state?: Record<string, unknown>;
};

export const MAX_INSTANCES = 12;
const MAX_INSTANCE_BYTES = 16_000;

const DEFAULT_W = 360;

export function newInstance(toolId: string, x: number, y: number, z: number): ToolInstance {
  return { id: `w_${Math.random().toString(36).slice(2, 9)}`, toolId, x: Math.round(x), y: Math.round(y), w: DEFAULT_W, h: null, z };
}

// ---------- module store ----------
const bags = new Map<string, Record<string, unknown>>();
const summaries = new Map<string, () => string>();
let dirtyListener: (() => void) | null = null;

/** CanvasBoard registers the debounced save here; widget edits call it through `markDirty`. */
export function setDirtyListener(cb: (() => void) | null) {
  dirtyListener = cb;
}

function markDirty() {
  dirtyListener?.();
}

/** Replaces the store with the instances loaded from the canvas (also clears stale bags). */
export function seedBags(list: readonly ToolInstance[]) {
  bags.clear();
  summaries.clear();
  for (const inst of list) bags.set(inst.id, { ...(inst.state ?? {}) });
}

export function dropBag(id: string) {
  bags.delete(id);
  summaries.delete(id);
}

export function bagOf(id: string) {
  return bags.get(id) ?? {};
}

/** Instances with their current state, ready to be persisted next to the scene elements. */
export function snapshotInstances(list: readonly ToolInstance[]): ToolInstance[] {
  return list.map((inst) => ({ ...inst, state: bags.get(inst.id) ?? {} }));
}

function setBagValue(id: string, key: string, value: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    console.warn(`[tool ${id}] значение «${key}» не сериализуется — не сохраняю`);
    return false;
  }
  if (json.length > MAX_INSTANCE_BYTES) {
    console.warn(`[tool ${id}] значение «${key}» больше ${MAX_INSTANCE_BYTES} байт — не сохраняю`);
    return false;
  }
  bags.set(id, { ...bags.get(id), [key]: value });
  return true;
}

/** One-line description of a widget's state for the AI. Tools can register a richer one. */
export function describeInstanceState(inst: ToolInstance, toolName: string): string {
  const custom = summaries.get(inst.id)?.().trim();
  if (custom) return custom;
  const bag = bags.get(inst.id) ?? {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (value == null || value === "") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) continue;
    parts.push(`${key}=${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
  }
  return parts.length ? `${toolName}: ${parts.join(", ")}` : toolName;
}

// ---------- React glue ----------
const InstanceCtx = createContext<string | null>(null);

export function ToolInstanceProvider({ id, children }: { id: string; children: ReactNode }) {
  return <InstanceCtx.Provider value={id}>{children}</InstanceCtx.Provider>;
}

/** The current widget's id, or `null` when the tool is rendered in the dock. */
export const useToolInstanceId = () => useContext(InstanceCtx);

export function useToolState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const id = useContext(InstanceCtx);
  const [value, setValue] = useState<T>(() => {
    if (!id) return initial;
    const bag = bags.get(id);
    return bag && key in bag ? (bag[key] as T) : initial;
  });
  const ref = useRef(value);
  ref.current = value;

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(ref.current) : next;
      ref.current = v;
      setValue(v);
      // the listener is invoked outside the state updater so updaters stay pure
      if (id && setBagValue(id, key, v)) markDirty();
    },
    [id, key],
  );

  return [value, set];
}

/** Registers how this widget should be described to the AI (falls back to a dump of the state bag). */
export function useToolSummary(fn: () => string) {
  const id = useContext(InstanceCtx);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!id) return;
    summaries.set(id, () => ref.current());
    return () => {
      summaries.delete(id);
    };
  }, [id]);
}
