import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { logTool, math, type ToolProps } from "./shared";

export function Calculator() {
  const [expr, setExpr] = useState("");
  const [history, setHistory] = useState<{ e: string; r: string }[]>([]);
  const scope = useRef<Record<string, unknown>>({});
  function calc() {
    if (!expr.trim()) return;
    let r: string;
    try {
      const v = math.evaluate(expr, scope.current);
      r = typeof v === "function" ? "функция определена" : math.format(v, { precision: 12 });
    } catch (e: any) {
      r = "Ошибка: " + e.message;
    }
    setHistory((h) => [{ e: expr, r }, ...h].slice(0, 30));
    logTool("calculator", { expr: expr.slice(0, 200) });
    setExpr("");
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <input value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && calc()}
        placeholder="2*sin(pi/6) + sqrt(16), x = 5, x^2, 5 km to mile" />
      <div className="row" style={{ gap: 4 }}>
        {["sin(", "cos(", "log(", "sqrt(", "^", "pi", "e", "!"].map((s) => (
          <button key={s} className="btn sm" onClick={() => setExpr((x) => x + s)}>{s}</button>
        ))}
        <button className="btn sm primary" onClick={calc}>=</button>
      </div>
      {history.length > 0 && (
        <div className="tool-out">
          {history.map((h, i) => <div key={i}>{h.e} <b>= {h.r}</b></div>)}
        </div>
      )}
    </div>
  );
}

export function Units() {
  const [value, setValue] = useState("1");
  const [from, setFrom] = useState("km");
  const [to, setTo] = useState("m");
  let result = "";
  try {
    result = math.format(math.unit(Number(value), from).to(to), { precision: 10 });
  } catch (e: any) {
    result = "—";
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
        <input value={value} onChange={(e) => { setValue(e.target.value); logTool("units"); }} style={{ width: 80 }} />
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="из" />
        <span>→</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="в" />
      </div>
      <div className="tool-out">{result}</div>
      <div className="small muted">Примеры единиц: m, cm, inch, kg, lb, N, J, W, kWh, V, A, ohm, degC, degF, km/h, m/s, Pa, atm, mol</div>
    </div>
  );
}

export function QuickNotes({ courseId, nodeId }: ToolProps) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} placeholder="Мысль, формула, вопрос к наставнику…" />
      <button className="btn sm" disabled={!text.trim()} onClick={async () => {
        await api.post("/notes", { title: text.split("\n")[0].slice(0, 60), content: text, course_id: courseId, node_id: nodeId });
        logTool("notes");
        setSaved(true);
        setText("");
      }}>{saved ? "✓ Сохранено в профиль" : "Сохранить в заметки"}</button>
    </div>
  );
}

export function Timer() {
  const [mode, setMode] = useState<"stopwatch" | "countdown">("stopwatch");
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const [minutes, setMinutes] = useState(25);
  useEffect(() => {
    if (!running) return;
    const start = Date.now() - (mode === "stopwatch" ? ms : minutes * 60000 - ms);
    const t = setInterval(() => {
      const elapsed = Date.now() - start;
      if (mode === "stopwatch") setMs(elapsed);
      else {
        const left = minutes * 60000 - elapsed;
        setMs(Math.max(0, left));
        if (left <= 0) setRunning(false);
      }
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, mode]);
  const shown = mode === "countdown" && !running && ms === 0 ? minutes * 60000 : ms;
  const fmt = `${String(Math.floor(shown / 60000)).padStart(2, "0")}:${String(Math.floor((shown % 60000) / 1000)).padStart(2, "0")}`;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 4 }}>
        <button className={`btn sm ${mode === "stopwatch" ? "primary" : ""}`} onClick={() => { setMode("stopwatch"); setMs(0); setRunning(false); }}>Секундомер</button>
        <button className={`btn sm ${mode === "countdown" ? "primary" : ""}`} onClick={() => { setMode("countdown"); setMs(0); setRunning(false); }}>Таймер</button>
        {mode === "countdown" && <input type="number" value={minutes} min={1} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 64 }} />}
      </div>
      <div className="center" style={{ fontFamily: "var(--mono)", fontSize: 32, fontWeight: 700 }}>{fmt}</div>
      <div className="row" style={{ gap: 4, justifyContent: "center" }}>
        <button className="btn sm primary" onClick={() => { if (mode === "countdown" && ms === 0) setMs(minutes * 60000); setRunning((r) => !r); logTool("timer"); }}>{running ? "Пауза" : "Старт"}</button>
        <button className="btn sm" onClick={() => { setRunning(false); setMs(0); }}>Сброс</button>
      </div>
    </div>
  );
}

export function NumBase() {
  const [value, setValue] = useState("255");
  const [base, setBase] = useState(10);
  const n = useMemo(() => {
    const clean = value.trim().replace(/^0[xbo]/i, "");
    if (!clean) return null;
    try {
      const v = BigInt.asIntN(64, BigInt(base === 10 ? clean : (base === 16 ? "0x" : base === 2 ? "0b" : "0o") + clean));
      return v;
    } catch {
      return null;
    }
  }, [value, base]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
        <input value={value} onChange={(e) => { setValue(e.target.value); logTool("numbase"); }} />
        <select value={base} onChange={(e) => setBase(Number(e.target.value))} style={{ width: 90 }}>
          <option value={2}>bin</option><option value={8}>oct</option><option value={10}>dec</option><option value={16}>hex</option>
        </select>
      </div>
      <div className="tool-out">
        {n === null ? "Некорректное число" : (
          <>
            DEC: {n.toString(10)}{"\n"}BIN: {n.toString(2)}{"\n"}OCT: {n.toString(8)}{"\n"}HEX: {n.toString(16).toUpperCase()}
          </>
        )}
      </div>
    </div>
  );
}

export function JsonTool() {
  const [text, setText] = useState('{"name": "Meraki", "tags": ["ai", "learning"]}');
  const [out, setOut] = useState("");
  const run = (indent: number | undefined) => {
    try {
      setOut(JSON.stringify(JSON.parse(text), null, indent));
    } catch (e: any) {
      setOut("Ошибка: " + e.message);
    }
    logTool("json");
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: "var(--mono)" }} />
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => run(2)}>Форматировать</button>
        <button className="btn sm" onClick={() => run(undefined)}>Сжать</button>
      </div>
      {out && <div className="tool-out">{out}</div>}
    </div>
  );
}

export function RegexTool() {
  const [pattern, setPattern] = useState("(\\d{3})-(\\d{2})");
  const [flags, setFlags] = useState("g");
  const [text, setText] = useState("Коды: 123-45, 678-90 и 111-2");
  let result: string;
  try {
    const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
    const matches = [...text.matchAll(re)];
    result = matches.length
      ? matches.map((m, i) => `#${i + 1} «${m[0]}» @${m.index}` + (m.length > 1 ? `  группы: ${m.slice(1).map((g) => JSON.stringify(g)).join(", ")}` : "")).join("\n")
      : "Совпадений нет";
  } catch (e: any) {
    result = "Ошибка: " + e.message;
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
        <input value={pattern} onChange={(e) => { setPattern(e.target.value); logTool("regex"); }} style={{ fontFamily: "var(--mono)" }} />
        <input value={flags} onChange={(e) => setFlags(e.target.value)} style={{ width: 50 }} />
      </div>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="tool-out">{result}</div>
    </div>
  );
}

export function TextStats() {
  const [text, setText] = useState("");
  const words = text.match(/[\p{L}\p{N}'-]+/gu) ?? [];
  const sentences = text.split(/[.!?…]+\s/).filter((s) => s.trim()).length || (text.trim() ? 1 : 0);
  const freq: Record<string, number> = {};
  words.forEach((w) => {
    const k = w.toLowerCase();
    if (k.length > 3) freq[k] = (freq[k] ?? 0) + 1;
  });
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const avg = words.length ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); logTool("textstats"); }} placeholder="Вставь или напиши текст" />
      <div className="tool-out">
        Символов: {text.length}{"\n"}Слов: {words.length}{"\n"}Предложений: {sentences}{"\n"}
        Средняя длина слова: {avg.toFixed(1)}{"\n"}Слов в предложении: {sentences ? (words.length / sentences).toFixed(1) : 0}{"\n"}
        Время чтения: ~{Math.max(1, Math.round(words.length / 180))} мин{"\n"}
        Частые слова: {top.map(([w, c]) => `${w}(${c})`).join(", ") || "—"}
      </div>
    </div>
  );
}
