import {
  ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Atom, Binary, BookOpen, Brain,
  Braces, Calculator, ChartColumn, ChartLine, Check, ChevronRight, Circle,
  CircleHelp, CircuitBoard, ClipboardCheck, Code, Compass, Database, Dices,
  Dna, Download, FileText, Flag, FlaskConical, Folder, FolderOpen, GraduationCap, Grip,
  History, House, Image, Lightbulb, Link, Lock, LogOut, Maximize,
  Microscope, Minus, Music, Network, NotebookPen, Palette, Pin, Play,
  Plus, Puzzle, RefreshCw, Rocket, Route, Ruler, Scale, Search, Settings,
  SlidersHorizontal, Target, Telescope, Thermometer, Timer, TriangleAlert,
  TriangleRight, Trophy, Upload, UserRound, Wallet, Wrench, X, Zap,
  type LucideIcon,
} from "lucide-react";

const icons = {
  arrowLeft: ArrowLeft, arrowRight: ArrowRight, arrowUp: ArrowUp, external: ArrowUpRight,
  atom: Atom, binary: Binary, book: BookOpen, brain: Brain, braces: Braces,
  calculator: Calculator, bars: ChartColumn, chart: ChartLine, check: Check,
  chevron: ChevronRight, circle: Circle, help: CircleHelp, circuit: CircuitBoard,
  exam: ClipboardCheck, code: Code, compass: Compass, database: Database,
  dice: Dices, dna: Dna, download: Download, file: FileText, flag: Flag, flask: FlaskConical,
  folder: Folder, folderOpen: FolderOpen, graduation: GraduationCap, grid: Grip,
  history: History, home: House, image: Image, bulb: Lightbulb,
  link: Link, lock: Lock, logout: LogOut, expand: Maximize,
  microscope: Microscope, minus: Minus, music: Music, graph: Network, note: NotebookPen,
  palette: Palette, pin: Pin, play: Play, plus: Plus, puzzle: Puzzle, refresh: RefreshCw,
  rocket: Rocket, route: Route, ruler: Ruler, scale: Scale, search: Search,
  settings: Settings, sliders: SlidersHorizontal, target: Target, telescope: Telescope,
  temperature: Thermometer, timer: Timer, warning: TriangleAlert, triangle: TriangleRight,
  trophy: Trophy, upload: Upload, user: UserRound, wallet: Wallet, tools: Wrench,
  close: X, zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

// Values from older tool drafts, generated tools and talent responses.
const legacy: Record<string, IconName> = {
  "\u{1F9EE}": "calculator", "\u{1F9E9}": "puzzle", "\u{26A1}": "zap", "\u{1F4D0}": "triangle", "\u{1F4CF}": "ruler",
  "\u{1F4C8}": "chart", "\u{1F52C}": "microscope", "\u{1F9EA}": "flask", "\u{1F9EC}": "dna", "\u{2697}": "flask", "\u{2699}": "settings",
  "\u{1F52D}": "telescope", "\u{1F321}": "temperature", "\u{2696}": "scale", "\u{1F50B}": "zap", "\u{1F4A1}": "bulb",
  "\u{1F3B2}": "dice", "\u{1F4B0}": "wallet", "\u{1F4CA}": "bars", "\u{1F5FA}": "route", "\u{1F570}": "timer", "\u{1F3B5}": "music",
  "\u{1F524}": "file", "\u{1F9E0}": "brain", "\u{1F6E0}": "tools", "\u{2B55}": "circle", "\u{1F680}": "rocket", "\u{1F4BB}": "code",
  "\u{1F4DA}": "book", "\u{1F3A8}": "palette", "\u{1F9EB}": "grid", "\u{1F4DD}": "note", "\u{1F39B}": "sliders",
};

export function iconName(value: string | undefined, fallback: IconName = "puzzle"): IconName {
  const key = value?.trim().replace(/[\uFE0E\uFE0F]/g, "") ?? "";
  if (Object.hasOwn(icons, key)) return key as IconName;
  return Object.hasOwn(legacy, key) ? legacy[key] : fallback;
}

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  const Glyph = icons[iconName(name)];
  return <Glyph size={18} strokeWidth={1.5} className={`icon ${className}`} aria-hidden="true" focusable="false" />;
}
