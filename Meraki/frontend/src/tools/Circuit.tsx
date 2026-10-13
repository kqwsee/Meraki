import { useMemo, useState } from "react";
import { useWorkspace } from "../workspace/context";
import { useToolInstanceId, useToolState, useToolSummary } from "./instance";
import { logTool } from "./shared";

type Kind = "wire" | "resistor" | "battery" | "switch" | "lamp";
type P = [number, number];
type Comp = { id: number; kind: Kind; a: P; b: P; value: number; closed?: boolean };

const KINDS: Record<Kind, { label: string; unit: string; def: number }> = {
  wire: { label: "Провод", unit: "", def: 0 },
  resistor: { label: "Резистор", unit: "Ом", def: 100 },
  battery: { label: "Источник", unit: "В", def: 9 },
  switch: { label: "Ключ", unit: "", def: 0 },
  lamp: { label: "Лампа", unit: "Ом", def: 50 },
};
const COLS = 9;
const ROWS = 6;
const CELL = 30;
const key = (p: P) => `${p[0]},${p[1]}`;

type Result = { error?: string; volts?: Record<string, number>; current?: Record<number, number> };

/** Modified nodal analysis for a linear DC circuit. */
function solve(comps: Comp[]): Result {
  const batteries = comps.filter((c) => c.kind === "battery");
  if (!batteries.length) return { error: "Добавь источник питания" };
  const parent: Record<string, string> = {};
  const find = (k: string): string => (parent[k] === undefined || parent[k] === k ? (parent[k] = k) : (parent[k] = find(parent[k])));
  const union = (x: string, y: string) => (parent[find(x)] = find(y));
  comps.forEach((c) => { find(key(c.a)); find(key(c.b)); });
  comps.filter((c) => c.kind === "wire" || (c.kind === "switch" && c.closed)).forEach((c) => union(key(c.a), key(c.b)));
  const ground = find(key(batteries[0].a));
  const nodes = [...new Set(Object.keys(parent).map(find))].filter((n) => n !== ground);
  const idx = Object.fromEntries(nodes.map((n, i) => [n, i]));
  const n = nodes.length;
  const m = batteries.length;
  const size = n + m;
  const A = Array.from({ length: size }, () => new Array(size).fill(0));
  const z = new Array(size).fill(0);
  const at = (node: string) => (node === ground ? -1 : idx[node]);
  for (let i = 0; i < n; i++) A[i][i] += 1e-9; // gmin keeps floating nodes solvable
  for (const c of comps) {
    if (c.kind !== "resistor" && c.kind !== "lamp") continue;
    const g = 1 / Math.max(c.value, 1e-6);
    const p = at(find(key(c.a)));
    const q = at(find(key(c.b)));
    if (p >= 0) A[p][p] += g;
    if (q >= 0) A[q][q] += g;
    if (p >= 0 && q >= 0) { A[p][q] -= g; A[q][p] -= g; }
  }
  for (let k = 0; k < m; k++) {
    const c = batteries[k];
    const plus = find(key(c.b));
    const minus = find(key(c.a));
    if (plus === minus) return { error: `Короткое замыкание источника ${c.value} В` };
    const p = at(plus);
    const q = at(minus);
    if (p >= 0) { A[p][n + k] += 1; A[n + k][p] += 1; }
    if (q >= 0) { A[q][n + k] -= 1; A[n + k][q] -= 1; }
    z[n + k] = c.value;
  }
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < size; col++) {
    let piv = col;
    for (let r = col + 1; r < size; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return { error: "Схема не решается: проверь соединения (возможно, параллельные источники)" };
    [A[col], A[piv]] = [A[piv], A[col]];
    [z[col], z[piv]] = [z[piv], z[col]];
    for (let r = 0; r < size; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let cc = col; cc < size; cc++) A[r][cc] -= f * A[col][cc];
      z[r] -= f * z[col];
    }
  }
  const x = z.map((v, i) => v / A[i][i]);
  const volts: Record<string, number> = {};
  Object.keys(parent).forEach((p) => {
    const r = find(p);
    volts[p] = r === ground ? 0 : x[idx[r]];
  });
  const current: Record<number, number> = {};
  for (const c of comps) {
    if (c.kind === "resistor" || c.kind === "lamp") current[c.id] = (volts[key(c.a)] - volts[key(c.b)]) / Math.max(c.value, 1e-6);
  }
  batteries.forEach((c, k) => (current[c.id] = -x[n + k]));
  return { volts, current };
}

export function describeCircuit(comps: Comp[], res: Result): string {
  const lines = ["Электрическая схема (узлы — точки сетки x,y):"];
  for (const c of comps) {
    const v = KINDS[c.kind];
    let s = `- ${v.label} ${key(c.a)} → ${key(c.b)}`;
    if (c.kind === "battery") s += ` ${c.value} В (− у ${key(c.a)}, + у ${key(c.b)})`;
    if (c.kind === "resistor" || c.kind === "lamp") s += ` ${c.value} Ом`;
    if (c.kind === "switch") s += c.closed ? " (замкнут)" : " (разомкнут)";
    if (res.current?.[c.id] !== undefined) s += `; ток ${Math.abs(res.current[c.id]).toFixed(4)} А`;
    if (res.volts && (c.kind === "resistor" || c.kind === "lamp")) s += `; напряжение ${Math.abs(res.volts[key(c.a)] - res.volts[key(c.b)]).toFixed(3)} В`;
    lines.push(s);
  }
  if (res.error) lines.push(`Расчёт: ${res.error}`);
  return lines.join("\n");
}

export default function Circuit() {
  const ws = useWorkspace();
  const instanceId = useToolInstanceId();
  const [comps, setComps] = useToolState<Comp[]>("comps", [
    { id: 1, kind: "battery", a: [1, 4], b: [1, 1], value: 9 },
    { id: 2, kind: "wire", a: [1, 1], b: [4, 1], value: 0 },
    { id: 3, kind: "resistor", a: [4, 1], b: [7, 1], value: 100 },
    { id: 4, kind: "lamp", a: [7, 1], b: [7, 4], value: 50 },
    { id: 5, kind: "switch", a: [7, 4], b: [4, 4], value: 0, closed: true },
    { id: 6, kind: "wire", a: [4, 4], b: [1, 4], value: 0 },
  ]);
  const [tool, setTool] = useState<Kind>("wire");
  const [start, setStart] = useState<P | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [saved, setSaved] = useState("");
  const res = useMemo(() => solve(comps), [comps]);
  const selected = comps.find((c) => c.id === sel);
  // two circuits on one canvas must not overwrite each other's saved schema
  const fileBase = instanceId ? `circuits/schema-${instanceId.slice(0, 6)}` : "circuits/schema";

  // the tutor sees the actual netlist and the solved currents, not just "схема есть"
  useToolSummary(() => (comps.length ? describeCircuit(comps, res) : ""));

  function clickPoint(p: P) {
    if (!start) return setStart(p);
    if (key(start) !== key(p)) {
      setComps((cs) => [...cs, { id: Date.now(), kind: tool, a: start, b: p, value: KINDS[tool].def, closed: tool === "switch" ? true : undefined }]);
      logTool("circuit", { instance: instanceId ?? undefined, add: tool });
    }
    setStart(null);
  }

  const X = (x: number) => 15 + x * CELL;
  const Y = (y: number) => 15 + y * CELL;

  function drawComp(c: Comp) {
    const [x1, y1, x2, y2] = [X(c.a[0]), Y(c.a[1]), X(c.b[0]), Y(c.b[1])];
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const isSel = c.id === sel;
    const stroke = isSel ? "#4f46e5" : "#1f2937";
    const I = Math.abs(res.current?.[c.id] ?? 0);
    const glow = c.kind === "lamp" ? Math.min(1, (I * I * c.value) / 2) : 0;
    return (
      <g key={c.id} onClick={(e) => { e.stopPropagation(); setSel(c.id); }} style={{ cursor: "pointer" }}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
        {c.kind === "wire" ? (
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2.5} />
        ) : (
          <>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2.5} />
            <g transform={`translate(${mx},${my}) rotate(${ang})`}>
              {c.kind === "resistor" && <rect x={-12} y={-6} width={24} height={12} fill="#fff" stroke={stroke} strokeWidth={2} />}
              {c.kind === "battery" && (<><rect x={-6} y={-10} width={12} height={20} fill="#fff" stroke="none" /><line x1={-4} y1={-10} x2={-4} y2={10} stroke={stroke} strokeWidth={2} /><line x1={4} y1={-5} x2={4} y2={5} stroke={stroke} strokeWidth={4} /></>)}
              {c.kind === "lamp" && (<><circle r={9} fill={`rgba(250, 204, 21, ${0.15 + 0.85 * glow})`} stroke={stroke} strokeWidth={2} /><line x1={-6} y1={-6} x2={6} y2={6} stroke={stroke} /><line x1={-6} y1={6} x2={6} y2={-6} stroke={stroke} /></>)}
              {c.kind === "switch" && (<><rect x={-10} y={-8} width={20} height={16} fill="#fff" stroke="none" /><circle cx={-8} r={2.5} fill={stroke} /><circle cx={8} r={2.5} fill={stroke} /><line x1={-8} y1={0} x2={8} y2={c.closed ? 0 : -9} stroke={stroke} strokeWidth={2} /></>)}
            </g>
            {c.kind !== "switch" && (
              <text x={mx} y={my - 13} fontSize={9} textAnchor="middle" fill="#4b5563">
                {c.value}{KINDS[c.kind].unit === "Ом" ? "Ω" : "V"}{res.current?.[c.id] !== undefined ? ` ${(I * 1000).toFixed(1)}мА` : ""}
              </text>
            )}
          </>
        )}
      </g>
    );
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 3 }}>
        {(Object.keys(KINDS) as Kind[]).map((k) => (
          <button key={k} className={`btn sm ${tool === k ? "primary" : ""}`} onClick={() => { setTool(k); setStart(null); }}>{KINDS[k].label}</button>
        ))}
      </div>
      <div className="small muted">Выбери элемент и кликни две точки сетки. Клик по элементу — выделить.</div>
      <svg width="100%" viewBox={`0 0 ${30 + (COLS - 1) * CELL} ${30 + (ROWS - 1) * CELL}`} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "#fff" }}
        onClick={() => setSel(null)}>
        {comps.map(drawComp)}
        {Array.from({ length: COLS * ROWS }, (_, i) => {
          const p: P = [i % COLS, Math.floor(i / COLS)];
          const isStart = start && key(start) === key(p);
          return (
            <circle key={i} cx={X(p[0])} cy={Y(p[1])} r={isStart ? 5 : 3} fill={isStart ? "#4f46e5" : "#cbd5e1"} style={{ cursor: "crosshair" }}
              onClick={(e) => { e.stopPropagation(); clickPoint(p); }} />
          );
        })}
      </svg>
      {selected && (
        <div className="row" style={{ gap: 4 }}>
          <b className="small">{KINDS[selected.kind].label}</b>
          {(selected.kind === "resistor" || selected.kind === "lamp" || selected.kind === "battery") && (
            <input type="number" style={{ width: 80 }} value={selected.value}
              onChange={(e) => setComps((cs) => cs.map((c) => (c.id === sel ? { ...c, value: Number(e.target.value) } : c)))} />
          )}
          {selected.kind === "switch" && (
            <button className="btn sm" onClick={() => setComps((cs) => cs.map((c) => (c.id === sel ? { ...c, closed: !c.closed } : c)))}>
              {selected.closed ? "Разомкнуть" : "Замкнуть"}
            </button>
          )}
          <button className="btn sm danger" onClick={() => { setComps((cs) => cs.filter((c) => c.id !== sel)); setSel(null); }}>Удалить</button>
        </div>
      )}
      <div className="tool-out">
        {res.error ? res.error : comps.filter((c) => res.current?.[c.id] !== undefined).map((c) =>
          `${KINDS[c.kind].label} ${c.value}${KINDS[c.kind].unit}: I = ${(Math.abs(res.current![c.id]) * 1000).toFixed(2)} мА` +
          (c.kind !== "battery" ? `, U = ${Math.abs(res.volts![key(c.a)] - res.volts![key(c.b)]).toFixed(3)} В, P = ${(res.current![c.id] ** 2 * c.value * 1000).toFixed(1)} мВт` : ""),
        ).join("\n")}
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => { setComps([]); setSel(null); }}>Очистить</button>
        {ws && (
          <button className="btn sm primary" onClick={async () => {
            const path = `${fileBase}.txt`;
            await ws.writeFile(path, describeCircuit(comps, res));
            await ws.writeFile(`${fileBase}.json`, JSON.stringify(comps));
            logTool("circuit", { instance: instanceId ?? undefined, saved: comps.length });
            setSaved(path);
          }}>Сохранить в пространство</button>
        )}
        {saved && <span className="small muted">✓ {saved}</span>}
      </div>
    </div>
  );
}
