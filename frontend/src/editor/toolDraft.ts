import type { FormulaSpec } from "../tools/formula";
import type { CustomToolDto } from "../tools/custom";

import { iconName, type IconName } from "../components/Icon";

export type ToolKind = "formula" | "html";

/** What the builder edits before it is saved. */
export type Draft = {
  id?: number;
  name: string;
  icon: string;
  description: string;
  kind: ToolKind;
  spec: FormulaSpec;
  code: string;
  height: number;
  origin: "manual" | "ai";
  prompt: string;
  enabled: boolean;
};

export const DEFAULT_HEIGHT = 360;

export function blankDraft(kind: ToolKind): Draft {
  return {
    name: "", icon: kind === "formula" ? "calculator" : "puzzle", description: "", kind, spec: { inputs: [], outputs: [], notes: "" },
    code: "", height: DEFAULT_HEIGHT, origin: "manual", prompt: "", enabled: true,
  };
}

export function draftOf(t: CustomToolDto): Draft {
  return {
    id: t.id, name: t.name, icon: iconName(t.icon, t.kind === "formula" ? "calculator" : "puzzle"), description: t.description, kind: t.kind, origin: t.origin, prompt: t.prompt, enabled: t.enabled,
    spec: t.kind === "formula" ? { inputs: t.spec.inputs ?? [], outputs: t.spec.outputs ?? [], notes: t.spec.notes ?? "" } : { inputs: [], outputs: [], notes: "" },
    code: t.code, height: t.kind === "html" ? t.spec.height ?? DEFAULT_HEIGHT : DEFAULT_HEIGHT,
  };
}

export function payloadOf(d: Draft) {
  return {
    name: d.name.trim(), icon: iconName(d.icon, d.kind === "formula" ? "calculator" : "puzzle"), description: d.description, kind: d.kind, origin: d.origin, prompt: d.prompt, enabled: d.enabled,
    spec: d.kind === "formula" ? d.spec : { height: d.height }, code: d.kind === "html" ? d.code : "",
  };
}

export const TOOL_ICON_LABELS: Partial<Record<IconName, string>> = {
  calculator: "Калькулятор", puzzle: "Головоломка", zap: "Электричество", triangle: "Треугольник",
  ruler: "Линейка", chart: "График", microscope: "Микроскоп", flask: "Колба", dna: "ДНК",
  telescope: "Телескоп", temperature: "Температура", scale: "Весы", bulb: "Лампочка", dice: "Кубики",
  wallet: "Кошелёк", bars: "Диаграмма", route: "Маршрут", timer: "Таймер", music: "Музыка",
  file: "Документ", brain: "Мышление", tools: "Инструменты", circle: "Окружность", rocket: "Движение",
};

export type Preset = { id: string; icon: string; name: string; description: string; spec: FormulaSpec };

const f = (key: string, label: string, unit: string, def: number) => ({ key, label, unit, default: def });
const o = (key: string, label: string, unit: string, expr: string, decimals = 2) => ({ key, label, unit, expr, decimals });

export const FORMULA_PRESETS: Preset[] = [
  {
    id: "ohm", icon: "zap", name: "Закон Ома", description: "Ток и мощность по напряжению и сопротивлению.",
    spec: { inputs: [f("U", "Напряжение", "В", 12), f("R", "Сопротивление", "Ом", 4)], outputs: [o("I", "Сила тока", "А", "U / R", 3), o("P", "Мощность", "Вт", "U * I")], notes: "I = U / R, P = U · I" },
  },
  {
    id: "circle", icon: "circle", name: "Окружность", description: "Площадь и длина окружности по радиусу.",
    spec: { inputs: [f("r", "Радиус", "см", 5)], outputs: [o("S", "Площадь круга", "см²", "pi * r^2"), o("L", "Длина окружности", "см", "2 * pi * r")], notes: "" },
  },
  {
    id: "pythagoras", icon: "triangle", name: "Гипотенуза", description: "Гипотенуза, площадь и периметр прямоугольного треугольника по катетам.",
    spec: {
      inputs: [f("a", "Катет a", "см", 3), f("b", "Катет b", "см", 4)],
      outputs: [o("c", "Гипотенуза c", "см", "sqrt(a^2 + b^2)"), o("S", "Площадь", "см²", "a * b / 2"), o("P", "Периметр", "см", "a + b + c")],
      notes: "Теорема Пифагора: c² = a² + b²",
    },
  },
  {
    id: "motion", icon: "rocket", name: "Равноускоренное движение", description: "Скорость и путь за время t.",
    spec: {
      inputs: [f("v0", "Начальная скорость", "м/с", 2), f("a", "Ускорение", "м/с²", 1.5), f("t", "Время", "с", 10)],
      outputs: [o("v", "Конечная скорость", "м/с", "v0 + a * t"), o("s", "Пройденный путь", "м", "v0 * t + a * t^2 / 2")],
      notes: "v = v₀ + a·t, s = v₀·t + a·t²/2",
    },
  },
  {
    id: "interest", icon: "wallet", name: "Сложные проценты", description: "Сумма вклада через n лет.",
    spec: {
      inputs: [f("P", "Начальная сумма", "₽", 100000), f("p", "Ставка", "% в год", 8), f("n", "Срок", "лет", 5)],
      outputs: [o("A", "Итоговая сумма", "₽", "P * (1 + p / 100)^n"), o("gain", "Доход", "₽", "A - P")],
      notes: "A = P · (1 + p/100)ⁿ",
    },
  },
  {
    id: "bmi", icon: "scale", name: "Индекс массы тела", description: "ИМТ по массе и росту.",
    spec: { inputs: [f("m", "Масса", "кг", 70), f("h", "Рост", "м", 1.75)], outputs: [o("bmi", "ИМТ", "кг/м²", "m / h^2", 1)], notes: "ИМТ = масса / рост²" },
  },
];

export const FORMULA_FUNCTIONS: [string, string][] = [
  ["sqrt(", "sqrt — квадратный корень"], ["abs(", "abs — модуль"], ["sin(", "sin — синус (радианы)"], ["cos(", "cos — косинус"], ["tan(", "tan — тангенс"],
  ["asin(", "asin — арксинус"], ["acos(", "acos — арккосинус"], ["atan(", "atan — арктангенс"], ["log(", "log — натуральный логарифм"],
  ["log10(", "log10 — десятичный логарифм"], ["exp(", "exp — e в степени"], ["round(", "round — округлить"], ["floor(", "floor — вниз"],
  ["ceil(", "ceil — вверх"], ["min(", "min — наименьшее"], ["max(", "max — наибольшее"], ["pow(", "pow — степень"], ["factorial(", "factorial — факториал"],
];

export const HTML_TEMPLATE = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Мой инструмент</title></head>
<body>
  <h3 style="margin:0 0 8px">Квадрат числа</h3>
  <label>Число: <input id="x" type="number" value="3" step="any"></label>
  <button id="go">Посчитать</button>
  <p id="out" style="font-size:18px"></p>

  <script>
    var x = document.getElementById('x'), out = document.getElementById('out');
    if (Meraki.state.x !== undefined) x.value = Meraki.state.x;   // вернуть сохранённое состояние

    function run() {
      var v = parseFloat(x.value);
      out.textContent = 'Квадрат: ' + (v * v);
      Meraki.save({ x: x.value });                                // запомнить ввод (холст, повторное открытие)
      Meraki.describe('x = ' + x.value + ', квадрат = ' + (v * v)); // что увидит ИИ-наставник при проверке
    }
    document.getElementById('go').onclick = run;
    run();
  </script>
</body>
</html>
`;

export const AI_EXAMPLES = [
  "Калькулятор дозы лекарства по массе тела: масса, доза мг/кг, число приёмов в сутки",
  "Симулятор маятника: ползунки длины и массы, анимация и период колебаний",
  "Тренажёр перевода чисел между двоичной, десятичной и шестнадцатеричной системами",
  "Конвертер валют по курсам, которые ученик вводит сам, с историей расчётов",
];
