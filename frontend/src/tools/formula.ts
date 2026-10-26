/**
 * Formula tools made by the course author: a no-code calculator described by a spec.
 * Expressions are math.js; they run on a separate, locked-down instance (no `import`, `createUnit`,
 * `evaluate`, `parse`… inside an expression), so a formula can never change the shared math engine.
 */
import katex from "katex";
import { all, create } from "mathjs";

export type FormulaInput = { key: string; label: string; unit: string; default: number; min?: number; max?: number };
export type FormulaOutput = { key: string; label: string; unit: string; expr: string; decimals: number };
export type FormulaSpec = { inputs: FormulaInput[]; outputs: FormulaOutput[]; notes: string };

const fm = create(all, {});
const evalExpr = fm.evaluate.bind(fm);
const parseExpr = fm.parse.bind(fm);
const blocked = () => {
  throw new Error("Эта функция недоступна в формулах");
};
fm.import(
  { import: blocked, createUnit: blocked, evaluate: blocked, parse: blocked, simplify: blocked, derivative: blocked, resolve: blocked, reviver: blocked },
  { override: true },
);

export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/;

/** True for names math.js already uses (constants such as e, pi, E, and functions such as sin, max). */
export const isTakenName = (key: string) => key in fm;

export type FormulaResult = { text: string; error?: string };

function formatValue(v: unknown, decimals: number): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    if (abs >= 1e9) return fm.format(v, { notation: "exponential", precision: 4 });
    const fixed = v.toFixed(decimals);
    // a small but non-zero value must not show as 0.00: keep three significant digits instead
    if (v !== 0 && Number(fixed) === 0) return abs < 1e-4 ? fm.format(v, { notation: "exponential", precision: 3 }) : String(Number(v.toPrecision(3)));
    return fixed;
  }
  if (typeof v === "boolean") return v ? "да" : "нет";
  if (v === undefined || v === null) return "—";
  if (typeof v === "function") throw new Error("Формула должна давать значение, а не функцию");
  return fm.format(v, { precision: 8 });
}

/** Results by output key. Outputs are evaluated in order and may use the inputs and the outputs before them. */
export function evalFormula(spec: FormulaSpec, values: Record<string, string | number>): Record<string, FormulaResult> {
  const scope: Record<string, unknown> = {};
  for (const i of spec.inputs) {
    const raw = values[i.key];
    scope[i.key] = raw === "" || raw === undefined ? NaN : Number(raw);
  }
  const out: Record<string, FormulaResult> = {};
  for (const o of spec.outputs) {
    try {
      const v = evalExpr(o.expr, scope);
      scope[o.key] = v;
      out[o.key] = { text: formatValue(v, o.decimals) };
    } catch (e: any) {
      scope[o.key] = NaN;
      out[o.key] = { text: "—", error: String(e?.message ?? e) };
    }
  }
  return out;
}

export function defaultValues(spec: FormulaSpec): Record<string, string> {
  return Object.fromEntries(spec.inputs.map((i) => [i.key, String(i.default)]));
}

/** Problems the author must fix (empty list = the tool is sound). Checked with the default values. */
export function formulaProblems(spec: FormulaSpec): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const check = (key: string, what: string) => {
    if (!KEY_RE.test(key)) problems.push(`${what} «${key || "?"}»: обозначение — латиница, цифры и _, начинается с буквы`);
    else if (isTakenName(key)) problems.push(`${what} «${key}»: это имя уже занято в math.js (константа или функция), возьмите другое`);
    else if (seen.has(key)) problems.push(`Обозначение «${key}» встречается дважды`);
    seen.add(key);
  };
  spec.inputs.forEach((i) => check(i.key, "Величина"));
  spec.outputs.forEach((o) => check(o.key, "Результат"));
  if (!spec.inputs.length) problems.push("Добавьте хотя бы одну вводимую величину");
  if (!spec.outputs.length) problems.push("Добавьте хотя бы один результат");
  const res = evalFormula(spec, defaultValues(spec));
  for (const o of spec.outputs) {
    if (!o.expr.trim()) problems.push(`У результата «${o.label || o.key}» нет формулы`);
    else if (res[o.key]?.error) problems.push(`«${o.label || o.key}»: ${explain(res[o.key].error!)}`);
  }
  return problems;
}

/** math.js error messages in words an author without code experience can act on. */
export function explain(message: string): string {
  const undef = message.match(/Undefined symbol (\S+)/);
  if (undef) return `в формуле неизвестное обозначение «${undef[1]}»: добавьте такую величину или поправьте формулу`;
  const fn = message.match(/Undefined function (\S+)/);
  if (fn) return `неизвестная функция «${fn[1]}»`;
  if (/Unexpected end of expression/i.test(message)) return "формула оборвана: не хватает числа или скобки";
  if (/Parenthesis \) expected|Value expected|Unexpected operator|Unexpected type/i.test(message)) return `ошибка в записи формулы (${message})`;
  return message;
}

/** The formula as KaTeX HTML ("c = √(a² + b²)"), or null when it does not parse. */
export function formulaHtml(o: FormulaOutput): string | null {
  try {
    const tex = parseExpr(o.expr).toTex({ parenthesis: "keep" });
    return katex.renderToString(`${o.key} = ${tex}`, { throwOnError: false, output: "html" });
  } catch {
    return null;
  }
}

export const emptySpec = (): FormulaSpec => ({ inputs: [], outputs: [], notes: "" });
