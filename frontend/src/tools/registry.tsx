import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { ToolProps } from "./shared";

export type ToolDef = {
  id: string; // shared with backend prompts.TOOL_CATALOG
  name: string;
  icon: string;
  domains: string[];
  keywords: string;
  component: LazyExoticComponent<ComponentType<ToolProps>> | ComponentType<ToolProps>;
  /** Made by the course author (not part of the built-in set). */
  custom?: boolean;
  description?: string;
};

const basic = () => import("./basic");
const code = () => import("./code");
const mathTools = () => import("./math");
const science = () => import("./science");

const pick = <M,>(loader: () => Promise<M>, name: keyof M) =>
  lazy(() => loader().then((m) => ({ default: m[name] as unknown as ComponentType<ToolProps> })));

export const TOOLS: ToolDef[] = [
  { id: "calculator", name: "Калькулятор", icon: "🧮", domains: ["general", "math", "physics", "engineering", "chemistry", "biology"], keywords: "вычисления формулы sin cos log", component: pick(basic, "Calculator") },
  { id: "units", name: "Конвертер единиц", icon: "📏", domains: ["physics", "engineering", "chemistry"], keywords: "единицы метры килограммы перевод", component: pick(basic, "Units") },
  { id: "notes", name: "Быстрые заметки", icon: "🗒️", domains: ["general", "humanities"], keywords: "заметка запись", component: pick(basic, "QuickNotes") },
  { id: "timer", name: "Таймер", icon: "⏱️", domains: ["general"], keywords: "время помодоро секундомер", component: pick(basic, "Timer") },
  { id: "python", name: "Python", icon: "🐍", domains: ["it", "math"], keywords: "код программирование интерпретатор", component: pick(code, "PythonTool") },
  { id: "javascript", name: "JavaScript", icon: "📜", domains: ["it"], keywords: "js код веб интерпретатор", component: pick(code, "JsTool") },
  { id: "sql", name: "SQL (SQLite)", icon: "🗃️", domains: ["it"], keywords: "база данных запрос select", component: pick(code, "SqlTool") },
  { id: "regex", name: "Регулярные выражения", icon: "🔎", domains: ["it"], keywords: "regex шаблон поиск", component: pick(basic, "RegexTool") },
  { id: "json", name: "JSON", icon: "🔧", domains: ["it"], keywords: "формат данные", component: pick(basic, "JsonTool") },
  { id: "numbase", name: "Системы счисления", icon: "🔢", domains: ["it", "math", "engineering"], keywords: "двоичная шестнадцатеричная bin hex", component: pick(basic, "NumBase") },
  { id: "plotter", name: "Графики функций", icon: "📈", domains: ["math", "physics", "engineering"], keywords: "график функция построить", component: pick(mathTools, "Plotter") },
  { id: "matrix", name: "Матрицы", icon: "🔲", domains: ["math", "engineering"], keywords: "определитель обратная линейная алгебра", component: pick(mathTools, "Matrix") },
  { id: "circuit", name: "Электрические схемы", icon: "🔌", domains: ["engineering", "physics"], keywords: "схема резистор ток напряжение ом", component: lazy(() => import("./Circuit")) },
  { id: "dna", name: "ДНК / РНК", icon: "🧬", domains: ["biology"], keywords: "ген последовательность белок кодон транскрипция", component: pick(science, "Dna") },
  { id: "punnett", name: "Решётка Пеннета", icon: "🧫", domains: ["biology"], keywords: "генетика скрещивание аллели менделя", component: pick(science, "Punnett") },
  { id: "molar", name: "Молярная масса", icon: "⚗️", domains: ["chemistry", "biology"], keywords: "химия формула моль вещество", component: pick(science, "Molar") },
  { id: "periodic", name: "Таблица Менделеева", icon: "🧪", domains: ["chemistry", "physics"], keywords: "элементы химия атом", component: pick(science, "Periodic") },
  { id: "textstats", name: "Анализ текста", icon: "📚", domains: ["humanities"], keywords: "слова символы чтение текст", component: pick(basic, "TextStats") },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
