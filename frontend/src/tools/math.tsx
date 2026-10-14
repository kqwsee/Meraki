import { useEffect, useRef, useState } from "react";
import { useToolState } from "./instance";
import { logTool, math } from "./shared";

const COLORS = ["#2f8f84", "#c2474d", "#5a6fb0", "#b8862f", "#7a5fb0"];

export function Plotter() {
  const [fns, setFns] = useToolState("fns", "sin(x)\nx^2/10");
  const [range, setRange] = useToolState("range", { x0: -10, x1: 10 });
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const W = (c.width = c.clientWidth * 2);
    const H = (c.height = 440);
    ctx.clearRect(0, 0, W, H);
    const compiled: { f: (x: number) => number; color: string }[] = [];
    setError("");
    fns.split("\n").map((s) => s.trim()).filter(Boolean).forEach((src, i) => {
      try {
        const code = math.compile(src.replace(/^y\s*=\s*/, ""));
        compiled.push({ f: (x: number) => Number(code.evaluate({ x })), color: COLORS[i % COLORS.length] });
      } catch (e: any) {
        setError(`«${src}»: ${e.message}`);
      }
    });
    const { x0, x1 } = range;
    let ymin = Infinity;
    let ymax = -Infinity;
    const N = 400;
    const samples = compiled.map(({ f }) =>
      Array.from({ length: N + 1 }, (_, i) => {
        const x = x0 + ((x1 - x0) * i) / N;
        const y = f(x);
        if (Number.isFinite(y)) {
          ymin = Math.min(ymin, y);
          ymax = Math.max(ymax, y);
        }
        return y;
      }),
    );
    if (!Number.isFinite(ymin)) { ymin = -1; ymax = 1; }
    if (ymax - ymin < 1e-9) { ymin -= 1; ymax += 1; }
    const pad = (ymax - ymin) * 0.08;
    ymin -= pad; ymax += pad;
    const sx = (x: number) => ((x - x0) / (x1 - x0)) * W;
    const sy = (y: number) => H - ((y - ymin) / (ymax - ymin)) * H;
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.font = "20px sans-serif";
    ctx.fillStyle = "#6b7280";
    for (let i = 0; i <= 10; i++) {
      const gx = x0 + ((x1 - x0) * i) / 10;
      ctx.beginPath(); ctx.moveTo(sx(gx), 0); ctx.lineTo(sx(gx), H); ctx.stroke();
      ctx.fillText(String(+gx.toFixed(2)), sx(gx) + 3, H - 6);
      const gy = ymin + ((ymax - ymin) * i) / 10;
      ctx.beginPath(); ctx.moveTo(0, sy(gy)); ctx.lineTo(W, sy(gy)); ctx.stroke();
      ctx.fillText(String(+gy.toFixed(2)), 3, sy(gy) - 3);
    }
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    if (x0 < 0 && x1 > 0) { ctx.beginPath(); ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), H); ctx.stroke(); }
    if (ymin < 0 && ymax > 0) { ctx.beginPath(); ctx.moveTo(0, sy(0)); ctx.lineTo(W, sy(0)); ctx.stroke(); }
    samples.forEach((ys, k) => {
      ctx.strokeStyle = compiled[k].color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      let pen = false;
      ys.forEach((y, i) => {
        const x = x0 + ((x1 - x0) * i) / N;
        if (!Number.isFinite(y)) { pen = false; return; }
        if (!pen) { ctx.moveTo(sx(x), sy(y)); pen = true; } else ctx.lineTo(sx(x), sy(y));
      });
      ctx.stroke();
    });
  }, [fns, range]);

  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={3} value={fns} onChange={(e) => { setFns(e.target.value); logTool("plotter"); }} placeholder="по одной функции от x в строке" style={{ fontFamily: "var(--mono)" }} />
      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
        <span className="small">x от</span>
        <input type="number" value={range.x0} onChange={(e) => setRange({ ...range, x0: Number(e.target.value) })} />
        <span className="small">до</span>
        <input type="number" value={range.x1} onChange={(e) => setRange({ ...range, x1: Number(e.target.value) })} />
      </div>
      {error && <div className="small" style={{ color: "var(--danger)" }}>{error}</div>}
      <canvas ref={canvas} style={{ width: "100%", height: 220, border: "1px solid var(--border)", borderRadius: 10, background: "#fff" }} />
    </div>
  );
}

export function Matrix() {
  const [a, setA] = useToolState("a", "1 2\n3 4");
  const [b, setB] = useToolState("b", "0 1\n1 0");
  const [expr, setExpr] = useToolState("expr", "A * B");
  const parse = (s: string) => s.trim().split("\n").map((r) => r.trim().split(/[\s,;]+/).map(Number));
  let out: string;
  try {
    const res = math.evaluate(expr, { A: math.matrix(parse(a)), B: math.matrix(parse(b)) });
    out = math.format(res, { precision: 6 }).replace(/\], \[/g, "]\n [");
  } catch (e: any) {
    out = "Ошибка: " + e.message;
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        <label className="field" style={{ flex: 1 }}>A<textarea rows={3} value={a} onChange={(e) => setA(e.target.value)} style={{ fontFamily: "var(--mono)" }} /></label>
        <label className="field" style={{ flex: 1 }}>B<textarea rows={3} value={b} onChange={(e) => setB(e.target.value)} style={{ fontFamily: "var(--mono)" }} /></label>
      </div>
      <input value={expr} onChange={(e) => { setExpr(e.target.value); logTool("matrix"); }} placeholder="A*B, det(A), inv(A), transpose(A), A+B" />
      <div className="tool-out">{out}</div>
    </div>
  );
}
