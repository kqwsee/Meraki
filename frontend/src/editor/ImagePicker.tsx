import { Icon } from "../components/Icon";
/**
 * Picking a picture for a topic (as a lecture visual or as the topic's cover): the author's uploads, figures taken
 * out of the uploaded PDF/DOCX materials, or pictures from Russian or English Wikipedia articles (free files of
 * Wikimedia Commons; the author and license are kept and shown under the picture).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AssetDto } from "../visuals/types";

type Tab = "mine" | "material" | "web";
type WebHit = { title: string; thumb: string; url: string; page_url: string; license: string; author: string; width: number; height: number; article: string };
type Lang = "ru" | "en";

/** A query in Cyrillic is searched in the Russian Wikipedia, anything else in the English one. */
const langOf = (q: string): Lang => (/[а-яё]/i.test(q) ? "ru" : "en");

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(n / 1024))} КБ`);

export default function ImagePicker({ courseId, purpose, queries = [], initialQuery, onPick, onClose }: {
  courseId: number;
  purpose: "visual" | "cover";
  /** Searches the AI suggested for this topic. */
  queries?: string[];
  initialQuery?: string;
  onPick: (asset: AssetDto) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialQuery ? "web" : "mine");
  const [items, setItems] = useState<AssetDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState(initialQuery ?? queries[0] ?? "");
  const [source, setSource] = useState<Lang>(langOf(initialQuery ?? queries[0] ?? "а"));
  const [hits, setHits] = useState<WebHit[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ items: AssetDto[] }>(`/courses/${courseId}/assets`);
    setItems(r.items);
  }, [courseId]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(f.name));
    if (!list.length) { setError("Подойдут картинки PNG, JPEG, GIF или WebP"); return; }
    const form = new FormData();
    list.forEach((f) => form.append("files", f));
    setBusy("upload");
    setError(null);
    try {
      const r = await api.upload<{ items: AssetDto[] }>(`/courses/${courseId}/assets`, form);
      await load();
      if (r.items.length === 1) onPick(r.items[0]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function search(query = q, src = source) {
    if (query.trim().length < 2) return;
    setBusy("search");
    setError(null);
    setHits(null);
    try {
      const r = await api.get<{ items: WebHit[] }>(`/courses/${courseId}/images/search?source=${src}&q=${encodeURIComponent(query.trim())}`);
      setHits(r.items);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  useEffect(() => { if (initialQuery) search(initialQuery, langOf(initialQuery)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function take(hit: WebHit) {
    setBusy(hit.url);
    setError(null);
    try {
      const a = await api.post<AssetDto>(`/courses/${courseId}/assets/import`, {
        url: hit.url, title: hit.title, license: hit.license, author: hit.author, page_url: hit.page_url,
      });
      onPick(a);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(a: AssetDto) {
    if (!confirm(`Удалить картинку «${a.filename}» из курса?`)) return;
    try {
      await api.del(`/assets/${a.id}`);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const mine = (items ?? []).filter((a) => a.source !== "material");
  const fromMaterials = (items ?? []).filter((a) => a.source === "material");

  const grid = (list: AssetDto[], empty: string) => (
    items == null ? <div className="vis-loading"><span className="spinner" /></div> : list.length === 0 ? <p className="small muted">{empty}</p> : (
      <div className="img-grid">
        {list.map((a) => (
          <div key={a.id} className="img-tile">
            <button type="button" className="img-pick" onClick={() => onPick(a)} title={a.filename}>
              <img src={a.url} alt={a.filename} loading="lazy" />
            </button>
            <div className="img-meta small">
              <span className="t">{a.filename}</span>
              <span className="faint">{a.width}×{a.height} · {kb(a.size)}{a.used ? ` · используется ${a.used}` : ""}</span>
            </div>
            {!a.used && <button type="button" className="img-del" onClick={() => remove(a)} title="Удалить из курса" aria-label="Удалить">×</button>}
          </div>
        ))}
      </div>
    )
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal img-picker" role="dialog" aria-label="Выбор картинки">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{purpose === "cover" ? "Обложка темы" : "Картинка к лекции"}</h2>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose}>Закрыть</button>
        </div>
        <div className="tabs" style={{ marginBottom: 14 }}>
          <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>Мои картинки</button>
          <button className={tab === "material" ? "active" : ""} onClick={() => setTab("material")}>Из материалов{fromMaterials.length ? ` · ${fromMaterials.length}` : ""}</button>
          <button className={tab === "web" ? "active" : ""} onClick={() => setTab("web")}>Википедия</button>
        </div>
        {error && <div className="alert error small mb">{error}</div>}

        {tab === "mine" && (
          <>
            <div className={`drop ${over ? "over" : ""}`} role="button" tabIndex={0} style={{ padding: 20, marginBottom: 14 }}
              onClick={() => fileInput.current?.click()} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
              <span className="drop-ico">{busy === "upload" ? <span className="spinner" /> : <Icon name="image" />}</span>
              <b>Перетащите картинки сюда или нажмите, чтобы выбрать</b>
              <span className="small muted">PNG, JPEG, GIF, WebP до 15 МБ. Большие уменьшатся до 2400 пикселей.</span>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
            </div>
            {grid(mine, "Здесь будут ваши загруженные картинки и найденные в открытых библиотеках.")}
          </>
        )}

        {tab === "material" && (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              Рисунки достаются из PDF и DOCX при загрузке материала (мелкие значки пропускаются). Материалы, загруженные раньше,
              загрузите заново, чтобы достать из них рисунки.
            </p>
            {grid(fromMaterials, "В загруженных материалах рисунков не нашлось.")}
          </>
        )}

        {tab === "web" && (
          <>
            <form className="row" style={{ marginBottom: 10 }} onSubmit={(e) => { e.preventDefault(); search(); }}>
              <input value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.trim()) setSource(langOf(e.target.value)); }}
                placeholder="Что найти: «митохондрия», «закон Ома», «Ohm's law»…" style={{ flex: "1 1 260px" }} />
              <select value={source} onChange={(e) => { const s = e.target.value as Lang; setSource(s); if (hits) search(q, s); }} style={{ width: "auto" }}>
                <option value="ru">Русская Википедия</option>
                <option value="en">Английская Википедия</option>
              </select>
              <button className="btn primary" disabled={busy === "search" || q.trim().length < 2}>{busy === "search" ? <span className="spinner" /> : "Найти"}</button>
            </form>
            {queries.length > 0 && (
              <div className="row small" style={{ gap: 6, marginBottom: 12 }}>
                <span className="muted">ИИ советует поискать:</span>
                {queries.map((s) => <button key={s} type="button" className="pins-chip" onClick={() => { setQ(s); setSource(langOf(s)); search(s, langOf(s)); }}>{s}</button>)}
              </div>
            )}
            <p className="small faint" style={{ marginTop: 0 }}>
              Картинки из статей русской или английской Википедии, поэтому подписи на них по-русски или по-английски. Только свободные лицензии:
              автор и лицензия сохранятся и будут подписаны под картинкой.
            </p>
            {hits == null ? null : hits.length === 0 ? <p className="small muted">Ничего не нашлось. Попробуйте запрос короче, как название статьи, или другую Википедию.</p> : (
              <div className="img-grid">
                {hits.map((h) => (
                  <div key={h.url} className="img-tile">
                    <button type="button" className="img-pick" onClick={() => take(h)} disabled={!!busy} title={`${h.title}\n${h.author}`}>
                      <img src={h.thumb} alt={h.title} loading="lazy" referrerPolicy="no-referrer" />
                      {busy === h.url && <span className="img-busy"><span className="spinner" /></span>}
                    </button>
                    <div className="img-meta small">
                      <span className="t">{h.title || "Без названия"}</span>
                      {h.article && <span className="faint">из статьи «{h.article}»</span>}
                      <span className="faint">{h.license || "лицензия не указана"}{h.author ? ` · ${h.author}` : ""}</span>
                      {h.page_url && <a className="faint" href={h.page_url} target="_blank" rel="noopener noreferrer">страница <Icon name="external" /></a>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
