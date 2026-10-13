/**
 * Shared viewport of the Excalidraw canvas (scroll/zoom) plus the imperative API handle.
 *
 * Widget overlays are anchored to scene coordinates, so they must follow pan and zoom. Doing that
 * through React state would re-render the whole workspace on every wheel tick, so the viewport lives
 * in a module and is applied to the DOM imperatively: CanvasBoard feeds it from `onScrollChange`,
 * CanvasWidgets registers a sync callback that rewrites widget transforms.
 */
import { viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";

export type Viewport = { scrollX: number; scrollY: number; zoom: number };
export type ScenePoint = { x: number; y: number };

export const viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };

type ApiLike = { getAppState: () => any };
let api: ApiLike | null = null;
let sync: (() => void) | null = null;

export function setCanvasApi(next: ApiLike | null) {
  api = next;
}

export function setViewport(next: Viewport) {
  viewport.scrollX = next.scrollX;
  viewport.scrollY = next.scrollY;
  viewport.zoom = next.zoom;
  sync?.();
}

/** Widgets register their imperative transformer here; `null` unregisters. */
export function registerViewportSync(fn: (() => void) | null) {
  sync = fn;
}

/**
 * Position of a widget's top-left on screen, relative to the canvas container.
 * The container has no padding and the overlay covers it exactly, so the container offset cancels out.
 */
export function toScreen(x: number, y: number): { left: number; top: number } {
  return { left: (x + viewport.scrollX) * viewport.zoom, top: (y + viewport.scrollY) * viewport.zoom };
}

/** Screen (client) coordinates -> scene coordinates, e.g. for a pointer drop on the canvas. */
export function clientToScene(clientX: number, clientY: number): ScenePoint | null {
  if (!api) return null;
  const appState = api.getAppState();
  if (!appState) return null;
  const p = viewportCoordsToSceneCoords({ clientX, clientY }, appState as any);
  return { x: p.x, y: p.y };
}
