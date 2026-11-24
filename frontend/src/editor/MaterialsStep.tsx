import { Icon } from "../components/Icon";
import { useRef, useState } from "react";
import { api } from "../api";
import { guessKind, KIND_NAMES, plural, type CourseFull, type Excerpt } from "./types";

type Way = "files" | "url" | "text";

const ext = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)(?:\s|\(|$)/)?.[1] ?? "").toUpperCase();
const ICONS: Record<string, string> = { PDF: "book", DOCX: "book", TXT: "file", MD: "file" };

export default function MaterialsStep({ course, excerpts, reload, onError, openInPins }: {
  course: CourseFull;
  excerpts: Excerpt[];
  reload: () => Promise<void>;
  onError: (msg: string | null) => void;
  openInPins: (materialId: number) => void;
}) {
  const [way, setWay] = useState<Way>("files");
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    onError(null);
    let done = 0;
    try {
      for (const f of files) {
        setProgress(`Загружаю ${done + 1} из ${files.length}: ${f.name}`);
        const form = new FormData();
        form.append("kind", guessKind(f.name));
        form.append("files", f);
        await api.upload(`/courses/${course.id}/materials`, form);
        done++;
      }
    } catch (e: any) {
      onError(e.message);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
      if (done) await reload();
    }
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    onError(null);
    try { await fn(); await reload(); } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  }

  const pins = (id: number) => excerpts.filter((e) => e.material_id === id).length;
  const total = course.materials.reduce((s, m) => s + m.chars, 0);

  return (
    <div className="card">
      <h2>Материалы курса</h2>
      <p className="muted small" style={{ maxWidth: 680 }}>
        Учебники, конспекты, сборники задач. По ним ИИ строит граф тем, объясняет на лекциях и берёт задания для практики.
        Из любого материала можно выбрать абзацы, главы и задачи, которые ИИ обязан использовать почти без изменений: это следующий шаг.
      </p>

      <div className="tabs" style={{ maxWidth: 440, margin: "16px 0" }}>
        <button className={way === "files" ? "active" : ""} onClick={() => setWay("files")}><Icon name="file" /> Файлы</button>
        <button className={way === "url" ? "active" : ""} onClick={() => setWay("url")}><Icon name="link" /> Ссылка</button>
        <button className={way === "text" ? "active" : ""} onClick={() => setWay("text")}><Icon name="note" /> Текст</button>
      </div>

      {way === "files" && (
        <div
          className={`drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); upload(Array.from(e.dataTransfer.files)); }}
          onClick={() => !progress && input.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        >
          <input ref={input} type="file" multiple accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => upload(Array.from(e.target.files ?? []))} />
          {progress ? (
            <div className="row" style={{ justifyContent: "center" }}><span className="spinner" /> {progress}</div>
          ) : (
            <>
              <div className="drop-ico"><Icon name="upload" /></div>
              <b>Перетащите файлы сюда или нажмите, чтобы выбрать</b>
              <div className="small muted">PDF, Word (.docx), TXT, Markdown · до 40 МБ каждый. Тип материала определится по названию, его можно сменить ниже.</div>
            </>
          )}
        </div>
      )}

      {way === "url" && (
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… ссылка на PDF или страницу учебника"
            onKeyDown={(e) => e.key === "Enter" && url.trim() && run(async () => { await api.post(`/courses/${course.id}/materials/url`, { url, kind: guessKind(url) }); setUrl(""); })} />
          <button className="btn primary" disabled={!url.trim() || busy}
            onClick={() => run(async () => { await api.post(`/courses/${course.id}/materials/url`, { url, kind: guessKind(url) }); setUrl(""); })}>
            {busy ? <span className="spinner" /> : "Добавить"}
          </button>
        </div>
      )}

      {way === "text" && (
        <div className="col">
          <input placeholder="Название (например, «Глава 3. Циклы»)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={8} placeholder="Вставьте текст главы, конспекта или заданий…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="row">
            <button className="btn primary" disabled={!title.trim() || body.trim().length < 20 || busy}
              onClick={() => run(async () => { await api.post(`/courses/${course.id}/materials/text`, { title, text: body, kind: guessKind(title) }); setTitle(""); setBody(""); })}>
              {busy ? <span className="spinner" /> : "Добавить текст"}
            </button>
            <span className="small muted">{body.trim().length < 20 ? "Нужно хотя бы 20 знаков" : `${body.length.toLocaleString("ru-RU")} знаков`}</span>
          </div>
        </div>
      )}

      <div className="row mt" style={{ marginBottom: 8 }}>
        <div className="eyebrow">Загружено</div>
        {course.materials.length > 0 && (
          <span className="small muted">
            {course.materials.length} {plural(course.materials.length, "материал", "материала", "материалов")} · {(total / 1000).toFixed(1)} тыс. знаков
          </span>
        )}
      </div>
      {course.materials.length ? (
        <div className="mat-list">
          {course.materials.map((m) => (
            <div key={m.id} className="mat-row">
              <span className="mat-ico" title={ext(m.filename)}><Icon name={ICONS[ext(m.filename)] ?? "file"} /></span>
              <div className="mat-name">
                <div className="t" title={m.filename}>{m.filename}</div>
                <div className="small muted">{(m.chars / 1000).toFixed(1)} тыс. знаков{pins(m.id) ? ` · закреплено: ${pins(m.id)}` : ""}</div>
              </div>
              <select className="mat-kind" value={m.kind} aria-label="Тип материала"
                onChange={(e) => run(() => api.patch(`/courses/${course.id}/materials/${m.id}`, { kind: e.target.value }))}>
                {Object.entries(KIND_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="btn sm" onClick={() => openInPins(m.id)} title="Открыть текст и выбрать обязательные фрагменты"><Icon name="target" /> Выбрать фрагменты</button>
              <button className="icon-btn" title="Удалить материал" aria-label="Удалить материал"
                onClick={() => {
                  if (confirm(`Удалить «${m.filename}»?${pins(m.id) ? "\n\nЗакреплённые из него фрагменты останутся в курсе: их текст сохранён." : ""}`))
                    run(() => api.del(`/courses/${course.id}/materials/${m.id}`));
                }}>✕</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">Материалов пока нет. Граф можно построить и по одному описанию, но с материалами лекции и задания точнее.</div>
      )}
    </div>
  );
}
