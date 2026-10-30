import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import GraphView, { type GEdge, type GNode } from "../components/GraphView";
import { DOMAIN_ICONS, ErrorBox, Loading, Modal, MODE_LABELS, Progress, STAGE_NAMES } from "../components/ui";

type Adventure = {
  id: number; kind: "side" | "recall" | "bridge"; status: "offered" | "active" | "done"; title: string; teaser: string; evidence: string;
  anchor_id: number | null; topic_id: number | null; node_id: number | null; score: number | null;
};
type CourseView = {
  id: number; title: string; description: string; summary: string; domain: string; domain_name: string; status: string;
  enrolled: boolean; is_author: boolean; progress: number; author: string;
  nodes: (GNode & { objectives: string[]; concepts: string[]; mode_reason: string })[];
  edges: { source: number; target: number }[];
  route: { message: string; replans: number; next_node_id: number | null };
  route_settings: { reorder: boolean; modes: boolean; bridges: boolean; adventures: boolean };
  adventures: { enabled: boolean; dev: boolean; items: Adventure[]; stats: { side_done: number; encounters_done: number } };
};

const ADV_ICON = { side: "✨", recall: "🎲", bridge: "🌉" } as const;
const ADV_NAME = { side: "Побочный квест", recall: "Случайная встреча", bridge: "Мостик на пути" } as const;

// with a fully fixed order every topic stays in place, so the pin carries no extra meaning
const withoutStalePins = (c: CourseView): CourseView =>
  c.route_settings.reorder ? c : { ...c, nodes: c.nodes.map((n) => ({ ...n, pinned: false })) };

export default function CoursePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [c, setC] = useState<CourseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<Adventure | null>(null);
  const [taking, setTaking] = useState(false);

  // an older backend that does not know about adventures simply shows none
  const noAdventures = { enabled: false, dev: false, items: [], stats: { side_done: 0, encounters_done: 0 } };
  const load = useCallback(
    () => api.get<CourseView>(`/courses/${id}`).then((v) => setC(withoutStalePins({ ...v, adventures: v.adventures ?? noAdventures }))).catch((e) => setError(e.message)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  // right after a passed topic the tutor is still deciding what to put on the map: look again a few times
  const enrolled = !!c?.enrolled && !!c?.adventures.enabled;
  useEffect(() => {
    if (!enrolled) return;
    let left = 6;
    const t = setInterval(() => (left-- > 0 ? load() : clearInterval(t)), 10000);
    return () => clearInterval(t);
  }, [enrolled, load]);

  // side quests and encounters on the map: markers for the unanswered ones, dashed links to where they hang
  const { graphNodes, graphEdges, open } = useMemo(() => {
    if (!c) return { graphNodes: [] as GNode[], graphEdges: [] as GEdge[], open: [] as Adventure[] };
    const open = c.adventures.items.filter((a) => a.status === "offered" || (a.status === "active" && a.kind !== "side"));
    const present = new Set(c.nodes.map((n) => n.id));
    const titleOf = (nid: number | null) => c.nodes.find((n) => n.id === nid)?.title ?? "";
    const markers: GNode[] = open.map((a) => ({
      // a bridge is named after both topics: on the map the short form is enough
      id: -a.id, title: a.kind === "bridge" ? `Мостик к «${titleOf(a.anchor_id)}»` : a.title, summary: a.teaser, kind: a.kind === "side" ? "side" : "encounter", encounter: a.kind === "side" ? undefined : a.kind,
      adventureId: a.id, offered: a.status === "offered", unlocked: true, personal: true, rank: null,
    }));
    const edges: GEdge[] = [...c.edges];
    for (const n of c.nodes) if (n.kind === "side" && n.parent_id && present.has(n.parent_id)) edges.push({ source: n.parent_id, target: n.id, soft: "side" });
    for (const a of open) {
      if (!a.anchor_id || !present.has(a.anchor_id)) continue;
      if (a.kind === "bridge") edges.push({ source: -a.id, target: a.anchor_id, soft: "event" });
      else edges.push({ source: a.anchor_id, target: -a.id, soft: a.kind === "side" ? "side" : "event" });
    }
    return { graphNodes: [...c.nodes, ...markers], graphEdges: edges, open };
  }, [c]);

  if (!c) return error ? <ErrorBox error={error} /> : <Loading />;
  const topics = c.nodes.filter((n) => n.kind !== "side");
  const quests = c.nodes.filter((n) => n.kind === "side");
  const ordered = [...topics].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const adv = c.adventures;

  const select = (n: GNode) => {
    if (!c.enrolled) return;
    if (n.adventureId) {
      const a = adv.items.find((x) => x.id === n.adventureId);
      if (a) setOffer(a);
      return;
    }
    if (n.unlocked || n.completed) nav(`/learn/${n.id}`);
  };

  async function take(a: Adventure) {
    setTaking(true);
    setError(null);
    try {
      const r = await api.post<{ kind: string; node_id?: number; adventure_id?: number }>(`/adventures/${a.id}/accept`);
      nav(r.kind === "side" ? `/learn/${r.node_id}` : `/encounters/${a.id}`);
    } catch (e: any) {
      setError(e.message);
      setTaking(false);
    }
  }

  async function leave(a: Adventure) {
    try {
      await api.post(`/adventures/${a.id}/dismiss`);
      setOffer(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function rollDice() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/courses/${c!.id}/adventures/roll`);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="row mb" style={{ alignItems: "flex-start", gap: 16 }}>
        <span className="domain-ico" style={{ width: 52, height: 52, fontSize: 26, borderRadius: 14 }}>{DOMAIN_ICONS[c.domain] ?? "🎓"}</span>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="eyebrow">{c.domain_name}</div>
          <h1 style={{ margin: "4px 0 6px" }}>{c.title}</h1>
          <div className="muted small">автор {c.author} · {topics.filter((n) => !n.personal).length} тем</div>
        </div>
        <Link className="btn" to={`/courses/${c.id}/leaderboard`}>🏆 Лидерборд</Link>
        {c.is_author && <Link className="btn" to={`/courses/${c.id}/edit`}>Редактировать</Link>}
        {!c.enrolled && c.status === "ready" && (
          <button className="btn primary lg" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.post(`/courses/${c.id}/enroll`); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>Записаться на курс</button>
        )}
      </div>
      <ErrorBox error={error} />
      <p className="muted" style={{ maxWidth: 820, fontSize: 15.5 }}>{c.summary || c.description}</p>

      {c.enrolled && (
        <div className="card grid-bg mb mt">
          <div className="row" style={{ alignItems: "flex-end", gap: 24 }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="eyebrow">Прогресс по курсу</div>
              <div className="row" style={{ alignItems: "baseline", gap: 10, margin: "6px 0 12px" }}>
                <span className="score-big" style={{ fontSize: 44 }}>{Math.round(c.progress)}%</span>
                <span className="muted small">пройдено</span>
              </div>
              <Progress value={c.progress} />
            </div>
            {c.route.next_node_id && (
              <div className="col" style={{ gap: 8, minWidth: 240 }}>
                <span className="muted small">Следующая тема</span>
                <b style={{ color: "var(--text-strong)" }}>{c.nodes.find((n) => n.id === c.route.next_node_id)?.title}</b>
                <Link className="btn primary" to={`/learn/${c.route.next_node_id}`}>Продолжить →</Link>
              </div>
            )}
          </div>
          {c.route.message && (
            <div className="alert mt">
              <b>🧭 Твой маршрут{c.route.replans ? ` · перестроен ${c.route.replans} раз` : ""}</b>
              <div style={{ marginTop: 4 }}>{c.route.message}</div>
            </div>
          )}
        </div>
      )}

      {c.enrolled && adv.enabled && (
        <div className="card adv-card mb">
          <div className="row" style={{ gap: 12 }}>
            <div>
              <div className="eyebrow">Приключения</div>
              <div className="small muted">
                Необязательное: сверхматериал по твоему интересу и встречи со старыми темами. В рейтинг и процент прохождения не входит.
              </div>
            </div>
            <span className="spacer" />
            {adv.dev && (
              <button className="btn sm ghost" disabled={busy} onClick={rollDice} title="Только для разработки: бросить кубик сразу">
                {busy ? <span className="spinner" /> : "🎲 Бросить кубик"}
              </button>
            )}
          </div>
          {open.length === 0 && quests.filter((q) => !q.completed).length === 0 ? (
            <p className="small muted" style={{ margin: "10px 0 0" }}>
              Сейчас на карте тихо. Когда ты пройдёшь ещё пару тем, здесь может появиться побочный квест или старая тема окликнет тебя.
            </p>
          ) : (
            <div className="adv-list">
              {open.map((a) => (
                <div key={a.id} className={`adv-row ${a.kind}`}>
                  <span className="adv-ico">{ADV_ICON[a.kind]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small muted">{ADV_NAME[a.kind]}{a.status === "active" ? " · начата" : ""}</div>
                    <b style={{ color: "var(--text-strong)" }}>{a.title}</b>
                    <div className="small muted">{a.teaser}</div>
                  </div>
                  <button className="btn sm" onClick={() => setOffer(a)}>{a.status === "active" ? "Продолжить" : "Посмотреть"}</button>
                </div>
              ))}
              {quests.filter((q) => !q.completed).map((q) => (
                <div key={q.id} className="adv-row side">
                  <span className="adv-ico">✨</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small muted">Побочный квест · в процессе</div>
                    <b style={{ color: "var(--text-strong)" }}>{q.title}</b>
                  </div>
                  <Link className="btn sm" to={`/learn/${q.id}`}>Продолжить</Link>
                </div>
              ))}
            </div>
          )}
          {(adv.stats.side_done > 0 || adv.stats.encounters_done > 0) && (
            <div className="small muted" style={{ marginTop: 10 }}>
              ✨ Квестов пройдено: <b>{adv.stats.side_done}</b> · 🎲 Встреч: <b>{adv.stats.encounters_done}</b>
            </div>
          )}
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px", alignItems: "start" }}>
        <GraphView nodes={graphNodes} edges={graphEdges} nextId={c.route.next_node_id} onSelect={select} />
        <div className="card" style={{ padding: 18 }}>
          <div className="eyebrow mb">Темы маршрута</div>
          <div className="route">
            {ordered.map((n, i) => {
              const mode = n.mode && MODE_LABELS[n.mode];
              const clickable = c.enrolled && (n.unlocked || n.completed);
              const isNext = n.id === c.route.next_node_id;
              return (
                <div key={n.id}
                  className={`route-step ${n.completed ? "done" : ""} ${isNext ? "next" : ""} ${c.enrolled && !clickable ? "locked" : ""}`}
                  onClick={() => clickable && select(n)} title={n.mode_reason || n.summary}>
                  <span className="route-num">{n.completed ? "✓" : i + 1}</span>
                  {n.cover && <img className="route-cover" src={n.cover} alt="" />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="route-title">
                      {n.title}
                      {n.pinned && <span title="Автор закрепил тему на этом месте"> 📌</span>}
                    </div>
                    {((n.stage && !n.completed) || mode || (c.enrolled && !n.unlocked && !n.completed)) && (
                      <div className="row" style={{ gap: 4, marginTop: 6 }}>
                        {n.stage && !n.completed && <span className="badge accent">{STAGE_NAMES[n.stage]}</span>}
                        {mode && <span className={`badge ${mode.cls}`}>{mode.label}</span>}
                        {c.enrolled && !n.unlocked && !n.completed && <span className="badge">🔒 закрыта</span>}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {offer && (
        <Modal
          title={`${ADV_ICON[offer.kind]} ${ADV_NAME[offer.kind]}`}
          onClose={() => !taking && setOffer(null)}
          footer={taking ? undefined : (
            <>
              <button className="btn ghost" onClick={() => setOffer(null)}>Закрыть</button>
              <button className="btn" onClick={() => leave(offer)}>{offer.status === "active" ? "Уйти от встречи" : "Не сейчас"}</button>
              <button className="btn primary" onClick={() => take(offer)}>
                {offer.status === "active" ? "Продолжить" : offer.kind === "side" ? "Принять квест →" : "Принять встречу →"}
              </button>
            </>
          )}
        >
          <h3 style={{ margin: "0 0 6px" }}>{offer.title}</h3>
          <p>{offer.teaser}</p>
          {offer.kind === "side" && offer.evidence && <p className="small muted">Почему тебе это предложили: {offer.evidence}</p>}
          <p className="small muted">
            {offer.kind === "side"
              ? "Это тупиковая ветка: две части (лекция и один вызов), без экзамена. Ничего не открывает, не меняет маршрут и не входит в лидерборд."
              : "Это займёт 3–5 минут. На прогресс по курсу и лидерборд не влияет; результат только подстроит твои карточки повторения."}
          </p>
          {taking && <div className="row muted"><span className="spinner" /> {offer.kind === "side" ? "Открываю квест…" : "Наставник готовит встречу…"}</div>}
        </Modal>
      )}
    </div>
  );
}
