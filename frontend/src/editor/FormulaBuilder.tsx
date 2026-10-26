import { useRef } from "react";
import { defaultValues, evalFormula, explain, formulaHtml, type FormulaInput, type FormulaOutput, type FormulaSpec } from "../tools/formula";
import { FORMULA_FUNCTIONS, FORMULA_PRESETS, type Preset } from "./toolDraft";

const INPUT_KEYS = ["a", "b", "c", "d", "x", "y", "z", "t", "m", "k"];
const OUTPUT_KEYS = ["y", "z", "r", "s", "w", "q", "p", "v", "f", "g"];
const OPERATORS: [string, string][] = [["+", " + "], ["−", " - "], ["×", " * "], ["÷", " / "], ["^", "^"], ["(", "("], [")", ")"], ["√", "sqrt("], ["π", "pi"]];

const nextKey = (pool: string[], used: string[]) => pool.find((k) => !used.includes(k)) ?? `v${used.length + 1}`;

/** No-code formula editor: the quantities a learner types in, and the results computed from them. */
export default function FormulaBuilder({ spec, onChange, onPreset }: {
  spec: FormulaSpec; onChange: (spec: FormulaSpec) => void; onPreset: (p: Preset) => void;
}) {
  const refs = useRef<Record<number, HTMLInputElement | null>>({});
  const used = [...spec.inputs.map((i) => i.key), ...spec.outputs.map((o) => o.key)];
  const results = evalFormula(spec, defaultValues(spec));

  const setInput = (idx: number, patch: Partial<FormulaInput>) =>
    onChange({ ...spec, inputs: spec.inputs.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
  const setOutput = (idx: number, patch: Partial<FormulaOutput>) =>
    onChange({ ...spec, outputs: spec.outputs.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });

  function insert(idx: number, text: string) {
    const el = refs.current[idx];
    const expr = spec.outputs[idx].expr;
    const start = el?.selectionStart ?? expr.length, end = el?.selectionEnd ?? expr.length;
    setOutput(idx, { expr: expr.slice(0, start) + text + expr.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  const dupe = (key: string) => used.filter((k) => k === key).length > 1;

  return (
    <div className="col" style={{ gap: 18 }}>
      <div>
        <div className="eyebrow mb" style={{ marginBottom: 8 }}>Начать с шаблона</div>
        <div className="row" style={{ gap: 6 }}>
          {FORMULA_PRESETS.map((p) => (
            <button key={p.id} type="button" className="chip" title={p.description} onClick={() => onPreset(p)}>{p.icon} {p.name}</button>
          ))}
        </div>
      </div>

      <section>
        <h3 className="fb-title"><span className="step-no">1</span> Что вводит ученик</h3>
        {spec.inputs.length > 0 && (
          <div className="fb-head fb-in"><span>Обозначение</span><span>Название</span><span>Единица</span><span>По умолчанию</span><span /></div>
        )}
        {spec.inputs.map((i, idx) => (
          <div key={idx} className="fb-row fb-in">
            <input value={i.key} onChange={(e) => setInput(idx, { key: e.target.value.trim() })} placeholder="a" aria-label="Обозначение"
              className={dupe(i.key) ? "bad" : ""} spellCheck={false} />
            <input value={i.label} onChange={(e) => setInput(idx, { label: e.target.value })} placeholder="Сторона a" aria-label="Название" />
            <input value={i.unit} onChange={(e) => setInput(idx, { unit: e.target.value })} placeholder="см" aria-label="Единица" />
            <input type="number" step="any" value={Number.isFinite(i.default) ? i.default : ""} aria-label="Значение по умолчанию"
              onChange={(e) => setInput(idx, { default: e.target.value === "" ? NaN : Number(e.target.value) })} />
            <button className="icon-btn" title="Убрать величину" onClick={() => onChange({ ...spec, inputs: spec.inputs.filter((_, k) => k !== idx) })}>✕</button>
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 8 }} disabled={spec.inputs.length >= 12}
          onClick={() => onChange({ ...spec, inputs: [...spec.inputs, { key: nextKey(INPUT_KEYS, used), label: "", unit: "", default: 1 }] })}>
          ＋ Добавить величину
        </button>
      </section>

      <section>
        <h3 className="fb-title"><span className="step-no">2</span> Что считаем</h3>
        {spec.outputs.length === 0 && <p className="small muted" style={{ marginTop: 0 }}>Результат — это формула из введённых величин. Например: <code>sqrt(a^2 + b^2)</code>.</p>}
        {spec.outputs.map((o, idx) => {
          const res = results[o.key];
          const vars = [...spec.inputs.map((i) => i.key), ...spec.outputs.slice(0, idx).map((x) => x.key)].filter(Boolean);
          const tex = o.expr.trim() ? formulaHtml(o) : null;
          return (
            <div key={idx} className="fb-out">
              <div className="fb-row fb-outhead">
                <input value={o.key} onChange={(e) => setOutput(idx, { key: e.target.value.trim() })} placeholder="c" aria-label="Обозначение результата"
                  className={dupe(o.key) ? "bad" : ""} spellCheck={false} />
                <input value={o.label} onChange={(e) => setOutput(idx, { label: e.target.value })} placeholder="Название результата" aria-label="Название результата" />
                <input value={o.unit} onChange={(e) => setOutput(idx, { unit: e.target.value })} placeholder="см" aria-label="Единица результата" />
                <select value={o.decimals} onChange={(e) => setOutput(idx, { decimals: Number(e.target.value) })} aria-label="Знаков после запятой" title="Знаков после запятой">
                  {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} зн.</option>)}
                </select>
                <button className="icon-btn" title="Убрать результат" onClick={() => onChange({ ...spec, outputs: spec.outputs.filter((_, k) => k !== idx) })}>✕</button>
              </div>
              <div className="fb-expr">
                <span className="eq">{o.key || "?"} =</span>
                <input ref={(el) => { refs.current[idx] = el; }} value={o.expr} onChange={(e) => setOutput(idx, { expr: e.target.value })}
                  placeholder="sqrt(a^2 + b^2)" spellCheck={false} className={res?.error ? "bad" : ""} aria-label="Формула" />
              </div>
              <div className="fb-chips">
                {vars.map((v) => <button key={v} type="button" className="chip var" onClick={() => insert(idx, v)} title="Вставить величину">{v}</button>)}
                <span className="sep" />
                {OPERATORS.map(([label, text]) => <button key={label} type="button" className="chip" onClick={() => insert(idx, text)}>{label}</button>)}
                <select className="chip-select" value="" aria-label="Функции" onChange={(e) => { if (e.target.value) insert(idx, e.target.value); }}>
                  <option value="">ƒ функция…</option>
                  {FORMULA_FUNCTIONS.map(([text, label]) => <option key={text} value={text}>{label}</option>)}
                </select>
              </div>
              <div className="fb-live">
                {res?.error ? <span className="err">⚠ {explain(res.error)}</span> : o.expr.trim() ? <span>При значениях по умолчанию: <b>{res?.text}{o.unit && res?.text !== "—" ? ` ${o.unit}` : ""}</b></span> : <span className="muted">Введите формулу</span>}
                {tex && !res?.error && <span className="fb-tex" dangerouslySetInnerHTML={{ __html: tex }} />}
              </div>
            </div>
          );
        })}
        <button className="btn sm" style={{ marginTop: 8 }} disabled={spec.outputs.length >= 12}
          onClick={() => onChange({ ...spec, outputs: [...spec.outputs, { key: nextKey(OUTPUT_KEYS, used), label: "", unit: "", expr: "", decimals: 2 }] })}>
          ＋ Добавить результат
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Степень — <code>^</code>, дробь — <code>/</code>, углы в радианах (<code>sin(30 deg)</code> — в градусах). Следующий результат может использовать предыдущие.
        </p>
      </section>

      <section>
        <h3 className="fb-title"><span className="step-no">3</span> Подсказка для ученика</h3>
        <textarea rows={3} value={spec.notes} onChange={(e) => onChange({ ...spec, notes: e.target.value })}
          placeholder="Что считает инструмент и как им пользоваться. Например: «Теорема Пифагора: c² = a² + b²»" />
      </section>
    </div>
  );
}
