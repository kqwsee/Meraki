import { Icon } from "../components/Icon";
/**
 * Course editor step "Наглядность": the AI drafts visuals for every topic's lecture, the author checks each one
 * (approve / edit / redo / delete) and adds pictures with descriptions and topic covers. Learners only see what
 * the author approved; drafts stay here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AssetDto, VisualDto } from "../visuals/types";
import ImagePicker from "./ImagePicker";
import VisualCard, { SAMPLES, VisualForm } from "./VisualCard";
import { plural, type CourseFull, type TopicNode } from "./types";

export type VisualsJob = { running: boolean; total: number; done: number; failed: number; errors: string[]; current: string[] };
export type VisualsState = {
  items: VisualDto[];
  job: VisualsJob | null;
  image_queries: Record<string, string[]>;
  covers: Record<string, { asset_id: number; url: string }>;
};

type Picker = { purpose: "visual" | "cover"; replace?: VisualDto; query?: string };

const byPosition = (a: VisualDto, b: VisualDto) => a.position - b.position || a.id - b.id;

export default function VisualsStep({ course, order, state, setState, reload, focusNodeId, onError }: {
  course: CourseFull;
  order: TopicNode[];
  state: VisualsState;
  setState: (fn: (s: VisualsState) => VisualsState) => void;
  reload: () => Promise<void>;
  focusNodeId?: number;
  onError: (msg: string) => void;
}) {
  const [active, setActive] = useState<number | null>(focusNodeId ?? order[0]?.id ?? null);
  const [wishesOpen, setWishesOpen] = useState(false);
  const [wishes, setWishes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [creating, setCreating] = useState<VisualDto | null>(null);
  const [autoEdit, setAutoEdit] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sawRunning = useRef(false);

  useEffect(() => {
    if (active == null || !order.some((n) => n.id === active)) setActive(order[0]?.id ?? null);
  }, [order, active]);
  useEffect(() => { if (focusNodeId) setActive(focusNodeId); }, [focusNodeId]);
  useEffect(() => { setCreating(null); setWishesOpen(false); setNotice(null); }, [active]);

  // the "all topics" job runs on the server: poll until it is done
  const running = !!state.job?.running;
  useEffect(() => {
    if (!running) return;
    sawRunning.current = true;
    const t = setInterval(() => { reload().catch(() => undefined); }, 3000);
    return () => clearInterval(t);
  }, [running, reload]);

  const byNode = useMemo(() => {
    const map = new Map<number | null, VisualDto[]>();
    for (const v of state.items) map.set(v.node_id, [...(map.get(v.node_id) ?? []), v]);
    for (const list of map.values()) list.sort(byPosition);
    return map;
  }, [state.items]);
  const count = (id: number) => {
    const list = byNode.get(id) ?? [];
    return { approved: list.filter((v) => v.status === "approved").length, drafts: list.filter((v) => v.status !== "approved").length };
  };
  const total = { approved: state.items.filter((v) => v.status === "approved" && v.node_id != null).length, drafts: state.items.filter((v) => v.status !== "approved" && v.node_id != null).length };
  const topic = order.find((n) => n.id === active) ?? null;
  const mine = active != null ? byNode.get(active) ?? [] : [];
  const lost = byNode.get(null) ?? [];
  const drafts = mine.filter((v) => v.status !== "approved").length;
  const cover = active != null ? state.covers[String(active)] : undefined;
  const queries = active != null ? state.image_queries[String(active)] ?? [] : [];

  function upsert(v: VisualDto) {
    setState((s) => ({ ...s, items: s.items.some((x) => x.id === v.id) ? s.items.map((x) => (x.id === v.id ? v : x)) : [...s.items, v] }));
  }
  const removeLocal = (id: number) => setState((s) => ({ ...s, items: s.items.filter((x) => x.id !== id) }));

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try { await fn(); } catch (e: any) { onError(e.message); } finally { setBusy(null); }
  }

  const generate = () => act("gen", async () => {
    if (active == null) return;
    const r = await api.post<{ items: VisualDto[]; image_queries: string[] }>(`/nodes/${active}/visuals/generate`, { wishes });
    setState((s) => ({ ...s, items: [...s.items, ...r.items], image_queries: { ...s.image_queries, [String(active)]: r.image_queries } }));
    setWishesOpen(false);
    setWishes("");
    setNotice(`ИИ подготовил ${r.items.length} ${plural(r.items.length, "материал", "материала", "материалов")}. Проверьте каждый: ученики увидят только одобренные.`);
  });

  const generateAll = () => act("all", async () => {
    await api.post(`/courses/${course.id}/visuals/generate-all`, {});
    await reload();
  });

  const dropQuery = (q: string) => act("query", async () => {
    if (active == null) return;
    const r = await api.put<{ image_queries: string[] }>(`/nodes/${active}/image-queries`, { queries: queries.filter((x) => x !== q) });
    setState((s) => ({ ...s, image_queries: { ...s.image_queries, [String(active)]: r.image_queries } }));
  });

  const approveAll = () => act("approve", async () => {
    if (active == null) return;
    const r = await api.post<{ approved: number; skipped: number }>(`/courses/${course.id}/visuals/approve`, { node_id: active });
    await reload();
    setNotice(`Одобрено: ${r.approved}.` + (r.skipped ? ` ${r.skipped} ${plural(r.skipped, "картинка ждёт", "картинки ждут", "картинок ждут")} описания.` : ""));
  });

  async function move(id: number, dir: -1 | 1) {
    const list = [...mine];
    const i = list.findIndex((v) => v.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const positions = new Map(list.map((v, k) => [v.id, k]));
    setState((s) => ({ ...s, items: s.items.map((v) => (positions.has(v.id) ? { ...v, position: positions.get(v.id)! } : v)) }));
    try {
      await api.put(`/courses/${course.id}/visuals/order`, { ids: list.map((v) => v.id) });
    } catch (e: any) {
      onError(e.message);
      await reload();
    }
  }

  async function pick(asset: AssetDto) {
    const p = picker;
    setPicker(null);
    if (!p || active == null) return;
    await act("pick", async () => {
      if (p.purpose === "cover") {
        await api.put(`/nodes/${active}/cover`, { asset_id: asset.id });
        await reload();
      } else if (p.replace) {
        upsert(await api.patch<VisualDto>(`/visuals/${p.replace.id}`, { asset_id: asset.id }));
      } else {
        const v = await api.post<VisualDto>(`/courses/${course.id}/visuals`, {
          node_id: active, kind: "image", asset_id: asset.id, title: asset.title || "", description: "", approve: false,
        });
        upsert(v);
        setAutoEdit(v.id);
      }
    });
  }

  function newOwn() {
    if (active == null) return;
    setCreating({
      id: -1, node_id: active, kind: "mermaid", title: "", description: "", code: SAMPLES.mermaid.code, data: {}, status: "draft",
      origin: "author", position: 0, asset_id: null, asset: null,
    });
  }

  if (!order.length) {
    return <div className="card"><h2>Наглядность</h2><p className="muted">Сначала постройте граф тем: наглядность готовится к лекции каждой темы.</p></div>;
  }

  const job = state.job;
  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: "1 1 360px" }}>
            <h2 style={{ marginBottom: 6 }}>Наглядность к лекциям</h2>
            <p className="small muted" style={{ margin: 0 }}>
              ИИ готовит к каждой теме схемы, диаграммы, интерактив и примеры во встроенных инструментах. Ученики видят <b>только то, что вы одобрили</b>:
              наставник покажет это в нужный момент лекции и не будет рисовать ничего своего. Картинки добавляете вы, с описанием: по нему наставник поймёт, что на них.
            </p>
            <div className="row small" style={{ gap: 8, marginTop: 10 }}>
              <span className="badge success">✓ одобрено {total.approved}</span>
              <span className={`badge ${total.drafts ? "warning" : ""}`}>ждут проверки {total.drafts}</span>
            </div>
          </div>
          <button className="btn primary" disabled={running || !!busy} onClick={generateAll}
            title="ИИ подготовит материалы ко всем темам, где их ещё нет. Это займёт несколько минут.">
            {busy === "all" ? <span className="spinner" /> : "Подготовить для всех тем без наглядности"}
          </button>
        </div>
        {job?.running && (
          <div className="alert mt">
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" />
              <b>ИИ готовит наглядность: {job.done + job.failed} из {job.total}</b>
              {job.current.length > 0 && <span className="small muted">сейчас: {job.current.join(", ")}</span>}
            </div>
            <div className="vis-progress"><span style={{ width: `${((job.done + job.failed) / Math.max(1, job.total)) * 100}%` }} /></div>
            <div className="small muted">Можно проверять уже готовые темы, не дожидаясь остальных.</div>
          </div>
        )}
        {job && !job.running && sawRunning.current && (
          <div className={`alert mt ${job.failed ? "warning" : "success"}`}>
            Готово: {job.done} {plural(job.done, "тема", "темы", "тем")}{job.failed ? `, не получилось: ${job.failed} (можно повторить в карточке темы)` : ""}.
            {job.errors.length > 0 && <details className="small"><summary>Подробности</summary>{job.errors.map((e) => <div key={e}>{e}</div>)}</details>}
          </div>
        )}
      </div>

      <div className="vis-layout mt">
        <div className="card vis-topics">
          <div className="eyebrow mb">Темы</div>
          {order.map((n, i) => {
            const c = count(n.id);
            const cv = state.covers[String(n.id)];
            return (
              <button key={n.id} className={`vis-topic ${n.id === active ? "on" : ""}`} onClick={() => setActive(n.id)}>
                {cv ? <img className="vis-topic-cover" src={cv.url} alt="" /> : <span className="vis-topic-num">{i + 1}</span>}
                <span className="t">{n.title}</span>
                {c.drafts > 0 && <span className="badge warning" title="Ждут проверки">{c.drafts}</span>}
                {c.approved > 0 && <span className="badge success" title="Одобрено">✓{c.approved}</span>}
              </button>
            );
          })}
          {lost.length > 0 && (
            <div className="mt">
              <div className="pins-group-title"><span className="warn">Не привязано к теме · {lost.length}</span></div>
              <p className="small faint" style={{ margin: "4px 0 8px" }}>Остались после перестройки графа или удаления темы. Ученики их не видят.</p>
              {lost.map((v) => (
                <div key={v.id} className="vis-lost">
                  <span className="t small">{v.title || "Без подписи"}</span>
                  <select className="mat-kind" value="" onChange={(e) => e.target.value && act("attach", async () => upsert(await api.patch<VisualDto>(`/visuals/${v.id}`, { node_id: Number(e.target.value) })))}>
                    <option value="">к теме…</option>
                    {order.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
                  </select>
                  <button className="btn sm ghost" title="Удалить" onClick={() => confirm("Удалить материал?") && act("del", async () => { await api.del(`/visuals/${v.id}`); removeLocal(v.id); })}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {topic && (
          <div className="vis-main">
            <div className="card">
              <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
                <div className="vis-cover">
                  {cover ? <img src={cover.url} alt="Обложка темы" /> : <span className="faint small">нет обложки</span>}
                </div>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <h3 style={{ margin: "0 0 4px" }}>{topic.title}</h3>
                  {topic.summary && <p className="small muted" style={{ margin: 0 }}>{topic.summary}</p>}
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <button className="btn sm" onClick={() => setPicker({ purpose: "cover" })} disabled={!!busy}>{cover ? "Сменить обложку" : "＋ Обложка темы"}</button>
                    {cover && <button className="btn sm ghost" disabled={!!busy} onClick={() => act("cover", async () => { await api.put(`/nodes/${topic.id}/cover`, { asset_id: null }); await reload(); })}>Убрать</button>}
                    <span className="small faint">видна на карте курса и в карточке темы</span>
                  </div>
                </div>
              </div>

              <div className="row mt" style={{ gap: 8 }}>
                <button className="btn primary" disabled={!!busy || running} onClick={() => setWishesOpen((o) => !o)}>Подготовить с ИИ</button>
                <button className="btn" disabled={!!busy} onClick={() => setPicker({ purpose: "visual" })}><Icon name="image" /> Картинка</button>
                <button className="btn" disabled={!!busy || !!creating} onClick={newOwn}>＋ Своя схема</button>
                <span className="spacer" />
                {drafts > 0 && (
                  <button className="btn success" disabled={!!busy} onClick={approveAll} title="Одобрить все черновики этой темы, которые вы просмотрели">
                    {busy === "approve" ? <span className="spinner" /> : `✓ Одобрить все черновики (${drafts})`}
                  </button>
                )}
              </div>
              {wishesOpen && (
                <div className="vis-redo mt">
                  <textarea rows={2} value={wishes} onChange={(e) => setWishes(e.target.value)} maxLength={2000}
                    placeholder="Пожелания (необязательно): «нужна схема жизненного цикла», «без интерактива», «сравни три алгоритма сортировки»…" />
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    <span className="small faint" style={{ flex: 1 }}>{mine.some((v) => v.origin === "ai") ? "ИИ добавит новые материалы к уже готовым и не будет их повторять." : "ИИ предложит 3–6 материалов разных видов."}</span>
                    <button className="btn ghost sm" onClick={() => setWishesOpen(false)} disabled={busy === "gen"}>Отмена</button>
                    <button className="btn primary sm" onClick={generate} disabled={busy === "gen"}>
                      {busy === "gen" ? <><span className="spinner" /> ИИ готовит… до минуты</> : "Подготовить"}
                    </button>
                  </div>
                </div>
              )}
              {queries.length > 0 && (
                <div className="row small mt" style={{ gap: 6 }}>
                  <span className="muted" title="Настоящее фото из Википедии, которое может помочь понять тему. Само ничего не добавляется">
                    Можно добавить фото из Википедии, ИИ советует поискать:
                  </span>
                  {queries.map((q) => (
                    <span key={q} className="query-chip">
                      <button className="pins-chip" onClick={() => setPicker({ purpose: "visual", query: q })} title="Найти картинки по этому запросу"><Icon name="search" /> {q}</button>
                      <button className="query-chip-x" onClick={() => dropQuery(q)} title="Не подходит — убрать подсказку" aria-label={`Убрать подсказку «${q}»`}>×</button>
                    </span>
                  ))}
                </div>
              )}
              {notice && <div className="alert small mt">{notice}</div>}
            </div>

            {creating && (
              <div className="vis-card draft">
                <div className="vis-card-head"><b>Новый материал</b></div>
                <VisualForm visual={creating} courseId={course.id} onCancel={() => setCreating(null)} onSaved={(v) => { upsert(v); setCreating(null); }} />
              </div>
            )}

            {mine.length === 0 && !creating ? (
              <div className="card vis-empty">
                <p className="muted" style={{ margin: 0 }}>
                  У этой темы пока нет наглядности. Нажмите «Подготовить с ИИ»: ИИ предложит 3–6 материалов, а вы проверите каждый. Или добавьте свою картинку или схему.
                </p>
              </div>
            ) : (
              mine.map((v, i) => (
                <VisualCard key={v.id} visual={v} courseId={course.id} first={i === 0} last={i === mine.length - 1} autoEdit={autoEdit === v.id}
                  onChange={upsert} onDelete={removeLocal} onMove={move} onPickImage={(x) => setPicker({ purpose: "visual", replace: x })} />
              ))
            )}
          </div>
        )}
      </div>

      {picker && (
        <ImagePicker courseId={course.id} purpose={picker.purpose} queries={queries} initialQuery={picker.query} onPick={pick} onClose={() => setPicker(null)} />
      )}
    </>
  );
}
