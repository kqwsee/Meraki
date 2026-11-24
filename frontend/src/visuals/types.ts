/** A picture of the course (backend services/assets.py). */
export type AssetDto = {
  id: number; url: string; filename: string; mime: string; size: number; width: number; height: number;
  source: "upload" | "material" | "web"; material_id: number | null; page: number | null;
  title: string; license: string; author: string; source_url: string; used: number;
};

export type VisualKind = "mermaid" | "svg" | "chart" | "scheme" | "html" | "tool" | "image";

/** Visual material of a lecture (backend services/visuals.py). Learners only ever get approved ones. */
export type VisualDto = {
  id: number; node_id: number | null; kind: VisualKind; title: string; description: string; code: string; data: any;
  status: "draft" | "approved"; origin: "ai" | "author"; position: number; asset_id: number | null; asset: AssetDto | null;
};

export const KIND_META: Record<VisualKind, { icon: string; name: string; hint: string }> = {
  mermaid: { icon: "graph", name: "Схема Mermaid", hint: "блок-схема, последовательность, состояния, mindmap" },
  svg: { icon: "note", name: "Рисунок SVG", hint: "устройство, геометрия, эскиз" },
  chart: { icon: "bars", name: "Диаграмма", hint: "столбцы, линии, круговая по данным" },
  scheme: { icon: "puzzle", name: "Схема-шаблон", hint: "шаги, цикл, хронология, сравнение, иерархия" },
  html: { icon: "sliders", name: "Интерактив", hint: "симуляция с ползунками" },
  tool: { icon: "tools", name: "Инструмент с примером", hint: "встроенный инструмент с готовым примером" },
  image: { icon: "image", name: "Картинка", hint: "ваша картинка с описанием" },
};
