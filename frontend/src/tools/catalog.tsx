/**
 * The tools a learner sees: the built-in ones plus the course author's own. The workspace wraps itself
 * in this provider, so the dock, the canvas widgets and the AI description of the canvas all resolve
 * tool ids (`calculator`, `custom_12`) the same way.
 */
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import { CustomToolView, type CustomToolDto } from "./custom";
import { TOOLS, type ToolDef } from "./registry";
import type { ToolProps } from "./shared";

export type ToolCatalog = { all: ToolDef[]; byId: Record<string, ToolDef>; customIds: string[] };

const index = (all: ToolDef[], customIds: string[]): ToolCatalog => ({ all, byId: Object.fromEntries(all.map((t) => [t.id, t])), customIds });
const BUILT_IN = index(TOOLS, []);

const Ctx = createContext<ToolCatalog>(BUILT_IN);
export const useToolCatalog = () => useContext(Ctx);

export function toolDefOf(c: CustomToolDto): ToolDef {
  const component: ComponentType<ToolProps> = () => <CustomToolView tool={c} />;
  return {
    id: c.tool_id, name: c.name, icon: c.icon || "🧩", domains: [], keywords: `${c.name} ${c.description}`, component, custom: true,
    description: c.description,
  };
}

export function ToolCatalogProvider({ custom, children }: { custom: CustomToolDto[]; children: ReactNode }) {
  // component identities must stay stable between polls of the topic state, or open tools would remount and lose their input
  const signature = JSON.stringify(custom.map((c) => [c.id, c.name, c.icon, c.kind, c.spec, c.code, c.description]));
  const value = useMemo(() => {
    const defs = custom.map(toolDefOf);
    return index([...defs, ...TOOLS], defs.map((d) => d.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
