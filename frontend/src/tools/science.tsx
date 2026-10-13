import { useMemo, useState } from "react";
import { logTool } from "./shared";

// ---------- DNA / RNA ----------
const CODONS: Record<string, string> = {};
const BASES = "UCAG";
const AA = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG";
let k = 0;
for (const a of BASES) for (const b of BASES) for (const c of BASES) CODONS[a + b + c] = AA[k++];

export function Dna() {
  const [seq, setSeq] = useState("ATGGCCATTGTAATGGGCCGCTGAAAGGGTGCCCGATAG");
  const s = seq.toUpperCase().replace(/[^ACGTU]/g, "");
  const isRna = s.includes("U") && !s.includes("T");
  const dna = isRna ? s.replace(/U/g, "T") : s;
  const comp = dna.replace(/[ACGT]/g, (c) => ({ A: "T", T: "A", C: "G", G: "C" })[c]!);
  const mrna = dna.replace(/T/g, "U");
  const gc = dna.length ? ((dna.match(/[GC]/g)?.length ?? 0) / dna.length) * 100 : 0;
  let protein = "";
  for (let i = 0; i + 3 <= mrna.length; i += 3) protein += CODONS[mrna.slice(i, i + 3)] ?? "?";
  return (
    <div className="col" style={{ gap: 6 }}>
      <textarea rows={3} value={seq} onChange={(e) => { setSeq(e.target.value); logTool("dna"); }} style={{ fontFamily: "var(--mono)" }} />
      <div className="tool-out">
        Длина: {dna.length} н.{"\n"}GC-состав: {gc.toFixed(1)}%{"\n"}
        Комплементарная (3'→5'): {comp}{"\n"}Обратно-комплементарная: {comp.split("").reverse().join("")}{"\n"}
        мРНК: {mrna}{"\n"}Белок (рамка 1): {protein} {"\n"}(* — стоп-кодон, M — старт)
      </div>
    </div>
  );
}

// ---------- Punnett square ----------
function gametes(genotype: string): string[] {
  const pairs = genotype.match(/[A-Za-z]{2}/g) ?? [];
  return pairs.reduce<string[]>((acc, pair) => acc.flatMap((g) => [g + pair[0], g + pair[1]]), [""]);
}
const normalize = (g: string) =>
  (g.match(/../g) ?? []).map((p) => p.split("").sort((x, y) => (x.toLowerCase() === y.toLowerCase() ? (x < y ? -1 : 1) : 0)).join("")).join("");

export function Punnett() {
  const [p1, setP1] = useState("AaBb");
  const [p2, setP2] = useState("AaBb");
  const g1 = gametes(p1);
  const g2 = gametes(p2);
  const valid = p1.length === p2.length && p1.length % 2 === 0 && g1.length > 0 && g1.length <= 16;
  const counts: Record<string, number> = {};
  const pheno: Record<string, number> = {};
  if (valid)
    for (const a of g1)
      for (const b of g2) {
        const child = normalize(a.split("").map((ch, i) => ch + b[i]).join(""));
        counts[child] = (counts[child] ?? 0) + 1;
        const ph = (child.match(/../g) ?? []).map((p) => (p[0] === p[0].toUpperCase() ? p[0].toUpperCase() + "_" : p)).join("");
        pheno[ph] = (pheno[ph] ?? 0) + 1;
      }
  const total = g1.length * g2.length;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
        <input value={p1} onChange={(e) => { setP1(e.target.value); logTool("punnett"); }} />
        <span>×</span>
        <input value={p2} onChange={(e) => setP2(e.target.value)} />
      </div>
      {!valid ? <div className="small muted">Введи генотипы одинаковой длины парами аллелей, например Aa или AaBb.</div> : (
        <>
          {g1.length <= 4 && (
            <table className="md" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              <tbody>
                <tr><th></th>{g2.map((g, i) => <th key={i}>{g}</th>)}</tr>
                {g1.map((a, i) => (
                  <tr key={i}><th>{a}</th>{g2.map((b, j) => <td key={j}>{normalize(a.split("").map((ch, x) => ch + b[x]).join(""))}</td>)}</tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="tool-out">
            Генотипы:{"\n"}{Object.entries(counts).map(([g, c]) => `${g}: ${c}/${total}`).join("\n")}{"\n\n"}
            Фенотипы (_ — любой аллель):{"\n"}{Object.entries(pheno).map(([g, c]) => `${g}: ${c}/${total}`).join("\n")}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- periodic table data ----------
// symbol:name(ru):mass ; Z = index + 1
const RAW =
  "H:Водород:1.008 He:Гелий:4.0026 Li:Литий:6.94 Be:Бериллий:9.0122 B:Бор:10.81 C:Углерод:12.011 N:Азот:14.007 O:Кислород:15.999 F:Фтор:18.998 Ne:Неон:20.180 " +
  "Na:Натрий:22.990 Mg:Магний:24.305 Al:Алюминий:26.982 Si:Кремний:28.085 P:Фосфор:30.974 S:Сера:32.06 Cl:Хлор:35.45 Ar:Аргон:39.948 K:Калий:39.098 Ca:Кальций:40.078 " +
  "Sc:Скандий:44.956 Ti:Титан:47.867 V:Ванадий:50.942 Cr:Хром:51.996 Mn:Марганец:54.938 Fe:Железо:55.845 Co:Кобальт:58.933 Ni:Никель:58.693 Cu:Медь:63.546 Zn:Цинк:65.38 " +
  "Ga:Галлий:69.723 Ge:Германий:72.630 As:Мышьяк:74.922 Se:Селен:78.971 Br:Бром:79.904 Kr:Криптон:83.798 Rb:Рубидий:85.468 Sr:Стронций:87.62 Y:Иттрий:88.906 Zr:Цирконий:91.224 " +
  "Nb:Ниобий:92.906 Mo:Молибден:95.95 Tc:Технеций:98 Ru:Рутений:101.07 Rh:Родий:102.91 Pd:Палладий:106.42 Ag:Серебро:107.87 Cd:Кадмий:112.41 In:Индий:114.82 Sn:Олово:118.71 " +
  "Sb:Сурьма:121.76 Te:Теллур:127.60 I:Иод:126.90 Xe:Ксенон:131.29 Cs:Цезий:132.91 Ba:Барий:137.33 La:Лантан:138.91 Ce:Церий:140.12 Pr:Празеодим:140.91 Nd:Неодим:144.24 " +
  "Pm:Прометий:145 Sm:Самарий:150.36 Eu:Европий:151.96 Gd:Гадолиний:157.25 Tb:Тербий:158.93 Dy:Диспрозий:162.50 Ho:Гольмий:164.93 Er:Эрбий:167.26 Tm:Тулий:168.93 Yb:Иттербий:173.05 " +
  "Lu:Лютеций:174.97 Hf:Гафний:178.49 Ta:Тантал:180.95 W:Вольфрам:183.84 Re:Рений:186.21 Os:Осмий:190.23 Ir:Иридий:192.22 Pt:Платина:195.08 Au:Золото:196.97 Hg:Ртуть:200.59 " +
  "Tl:Таллий:204.38 Pb:Свинец:207.2 Bi:Висмут:208.98 Po:Полоний:209 At:Астат:210 Rn:Радон:222 Fr:Франций:223 Ra:Радий:226 Ac:Актиний:227 Th:Торий:232.04 " +
  "Pa:Протактиний:231.04 U:Уран:238.03 Np:Нептуний:237 Pu:Плутоний:244 Am:Америций:243 Cm:Кюрий:247 Bk:Берклий:247 Cf:Калифорний:251 Es:Эйнштейний:252 Fm:Фермий:257 " +
  "Md:Менделевий:258 No:Нобелий:259 Lr:Лоуренсий:266 Rf:Резерфордий:267 Db:Дубний:268 Sg:Сиборгий:269 Bh:Борий:270 Hs:Хассий:277 Mt:Мейтнерий:278 Ds:Дармштадтий:281 " +
  "Rg:Рентгений:282 Cn:Коперниций:285 Nh:Нихоний:286 Fl:Флеровий:289 Mc:Московий:290 Lv:Ливерморий:293 Ts:Теннессин:294 Og:Оганесон:294";

export type Element = { z: number; symbol: string; name: string; mass: number; row: number; col: number };

export const ELEMENTS: Element[] = RAW.split(" ").map((e, i) => {
  const [symbol, name, mass] = e.split(":");
  const z = i + 1;
  let row: number, col: number;
  if (z === 1) [row, col] = [1, 1];
  else if (z === 2) [row, col] = [1, 18];
  else if (z <= 10) [row, col] = [2, z <= 4 ? z - 2 : z + 8];
  else if (z <= 18) [row, col] = [3, z <= 12 ? z - 10 : z];
  else if (z <= 36) [row, col] = [4, z - 18];
  else if (z <= 54) [row, col] = [5, z - 36];
  else if (z >= 57 && z <= 71) [row, col] = [9, z - 54];
  else if (z >= 89 && z <= 103) [row, col] = [10, z - 86];
  else if (z <= 86) [row, col] = [6, z <= 56 ? z - 54 : z - 68];
  else [row, col] = [7, z <= 88 ? z - 86 : z - 100];
  return { z, symbol, name, mass: Number(mass), row, col };
});
const BY_SYMBOL = Object.fromEntries(ELEMENTS.map((e) => [e.symbol, e]));

// ---------- molar mass ----------
function parseFormula(formula: string): Record<string, number> {
  const parts = formula.replace(/\s/g, "").split(/[·*.]/);
  const total: Record<string, number> = {};
  for (const part of parts) {
    const m = part.match(/^(\d+)(.*)$/);
    const mult = m ? Number(m[1]) : 1;
    const body = m ? m[2] : part;
    let i = 0;
    const group = (): Record<string, number> => {
      const counts: Record<string, number> = {};
      while (i < body.length && body[i] !== ")") {
        let sub: Record<string, number>;
        if (body[i] === "(" || body[i] === "[") {
          i++;
          sub = group();
          i++;
        } else {
          const sym = body.slice(i).match(/^[A-Z][a-z]?/);
          if (!sym || !BY_SYMBOL[sym[0]]) throw new Error(`неизвестный элемент около «${body.slice(i, i + 2)}»`);
          i += sym[0].length;
          sub = { [sym[0]]: 1 };
        }
        const num = body.slice(i).match(/^\d+/);
        const n = num ? Number(num[0]) : 1;
        if (num) i += num[0].length;
        for (const [el, c] of Object.entries(sub)) counts[el] = (counts[el] ?? 0) + c * n;
      }
      return counts;
    };
    for (const [el, c] of Object.entries(group())) total[el] = (total[el] ?? 0) + c * mult;
  }
  return total;
}

export function Molar() {
  const [formula, setFormula] = useState("CuSO4·5H2O");
  const result = useMemo(() => {
    try {
      const counts = parseFormula(formula);
      const rows = Object.entries(counts).map(([el, n]) => ({ el, n, m: BY_SYMBOL[el].mass * n }));
      const M = rows.reduce((a, r) => a + r.m, 0);
      return { rows, M };
    } catch (e: any) {
      return { error: e.message as string };
    }
  }, [formula]);
  return (
    <div className="col" style={{ gap: 6 }}>
      <input value={formula} onChange={(e) => { setFormula(e.target.value); logTool("molar"); }} placeholder="H2SO4, Ca(OH)2, CuSO4·5H2O" />
      <div className="tool-out">
        {"error" in result ? `Ошибка: ${result.error}` : (
          <>
            M = {result.M.toFixed(3)} г/моль{"\n"}
            {result.rows.map((r) => `${r.el}: ${r.n} × ${BY_SYMBOL[r.el].mass} = ${r.m.toFixed(3)} (${((r.m / result.M) * 100).toFixed(1)}%)`).join("\n")}
          </>
        )}
      </div>
    </div>
  );
}

export function Periodic() {
  const [sel, setSel] = useState<Element | null>(null);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(18, 1fr)", gap: 1, fontSize: 8 }}>
        {ELEMENTS.map((e) => (
          <div key={e.z} onClick={() => { setSel(e); logTool("periodic", { el: e.symbol }); }} title={`${e.z} ${e.name}`}
            style={{
              gridRow: e.row, gridColumn: e.col, cursor: "pointer", textAlign: "center", padding: "1px 0", borderRadius: 2,
              background: sel?.z === e.z ? "var(--accent)" : e.row >= 9 ? "#fdf2f8" : e.col <= 2 ? "#fef3c7" : e.col >= 13 ? "#dcfce7" : "#e0e7ff",
              color: sel?.z === e.z ? "#fff" : "#1c2033", fontWeight: 600,
            }}>
            {e.symbol}
          </div>
        ))}
      </div>
      {sel && (
        <div className="tool-out">
          {sel.z}. {sel.symbol} — {sel.name}{"\n"}Атомная масса: {sel.mass}{"\n"}
          {sel.row <= 7 ? `Период ${sel.row}, группа ${sel.col}` : sel.row === 9 ? "Лантаноид (период 6)" : "Актиноид (период 7)"}
        </div>
      )}
    </div>
  );
}
