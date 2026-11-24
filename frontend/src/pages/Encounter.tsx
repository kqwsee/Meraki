import { Icon } from "../components/Icon";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import { ErrorBox, Loading } from "../components/ui";
import { tracker, TypingRecorder, textareaHandlers } from "../telemetry/tracker";

type Question = { id: string; kind: string; question: string; concept: string; reference?: string };
type Result = {
  score: number; remembered: boolean; summary: string; weak_concepts: string[];
  items: { id: string; question: string; answer: string; score: number; feedback: string }[];
};
type Encounter = {
  id: number; course_id: number; kind: "recall" | "bridge" | "side"; status: string; title: string; teaser: string;
  topic_title: string; target_title: string;
  content: { intro: string; explainer: string; concept: string; questions: Question[] } | null;
  result: Result | null;
};

const KIND_LABEL: Record<string, string> = { recall: "Случайная встреча", bridge: "Мостик на пути" };
const Q_LABEL: Record<string, string> = { recall: "Вспомни", transfer: "Примени по-новому", check: "Проверь себя" };

export default function EncounterPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [e, setE] = useState<Encounter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(async () => {
    try {
      let v = await api.get<Encounter>(`/adventures/${id}`);
      if (v.kind === "side") return nav("/courses", { replace: true });
      if (!v.content && (v.status === "offered" || v.status === "active")) {
        setPreparing(true); // opened by a direct link: the content has not been made yet
        await api.post(`/adventures/${id}/accept`);
        v = await api.get<Encounter>(`/adventures/${id}`);
      }
      setE(v);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPreparing(false);
    }
  }, [id, nav]);

  useEffect(() => {
    load();
    tracker.setContext({ nodeId: null, stage: "encounter" });
  }, [load]);

  const recs = useMemo(
    () => Object.fromEntries((e?.content?.questions ?? []).map((q) => [q.id, new TypingRecorder(`encounter:${q.id}`, "answer")])),
    [e?.content?.questions],
  );

  if (!e) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading text={preparing ? "Наставник готовит встречу…" : undefined} />;
  const back = <Link className="btn" to={`/courses/${e.course_id}`}>← К графу курса</Link>;

  if (e.status === "dismissed" || e.status === "expired") {
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <div className="card center">
          <span className="icon-frame mb"><Icon name="history" /></span>
          <p className="muted">Эта встреча уже закончилась: {e.status === "dismissed" ? "ты от неё ушёл(а)" : "она ушла с карты"}.</p>
          {back}
        </div>
      </div>
    );
  }

  const done = e.status === "done" && e.result;
  const questions = e.content?.questions ?? [];

  async function submit() {
    setBusy(true);
    setError(null);
    Object.values(recs).forEach((r) => r.flush());
    await tracker.flush();
    try {
      setE(await api.post<Encounter>(`/adventures/${id}/submit`, { answers }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!confirm("Уйти от встречи? Она исчезнет с карты.")) return;
    try {
      await api.post(`/adventures/${id}/dismiss`);
      nav(`/courses/${e!.course_id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="row mb">
        <div>
          <div className="eyebrow">{KIND_LABEL[e.kind]} · не входит в лидерборд и прогресс</div>
          <h1 style={{ margin: "4px 0 0" }}>{e.title}</h1>
        </div>
        <span className="spacer" />
        {back}
      </div>
      <ErrorBox error={error} />
      {e.content?.intro && <p style={{ fontSize: 16 }}>{e.content.intro}</p>}

      {e.kind === "bridge" && e.content?.explainer && (
        <div className="card">
          <div className="small muted mb">«{e.topic_title}» → «{e.target_title}»</div>
          <Markdown>{e.content.explainer}</Markdown>
        </div>
      )}

      {done ? (
        <>
          <div className="card row" style={{ gap: 24 }}>
            <div className="center">
              <div className="score-big" style={{ color: e.result!.remembered ? "var(--success)" : "var(--warning)" }}>{Math.round(e.result!.score)}</div>
              <div className="small muted">из 100</div>
            </div>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0 }}>{e.result!.remembered ? "Тема с тобой" : "Есть что освежить"}</h2>
              <Markdown>{e.result!.summary}</Markdown>
              {e.result!.weak_concepts.length > 0 && (
                <div className="row" style={{ gap: 4 }}>
                  <span className="small">Повторить:</span>
                  {e.result!.weak_concepts.map((c) => <span key={c} className="badge warning">{c}</span>)}
                </div>
              )}
            </div>
          </div>
          {questions.map((q, i) => {
            const item = e.result!.items.find((x) => x.id === q.id);
            return (
              <div key={q.id} className="card">
                <div className="row mb" style={{ gap: 8 }}>
                  <b>{i + 1}. {Q_LABEL[q.kind] ?? "Вопрос"}</b>
                  {item && <span className={`badge ${item.score >= 60 ? "success" : "warning"}`}>{Math.round(item.score)}</span>}
                </div>
                <Markdown>{q.question}</Markdown>
                {item?.answer && <p className="small"><b>Твой ответ:</b> {item.answer}</p>}
                {item?.feedback && <div className="alert"><Markdown>{item.feedback}</Markdown></div>}
                {q.reference && <details className="mt"><summary className="small" style={{ cursor: "pointer" }}>Эталонный ответ</summary><Markdown>{q.reference}</Markdown></details>}
              </div>
            );
          })}
          <p className="small muted">Твои карточки повторения по этой теме сдвинуты по результату: удачная встреча отодвигает их, неудачная вернёт раньше.</p>
          {back}
        </>
      ) : (
        <>
          {questions.map((q, i) => (
            <div key={q.id} className="card">
              <div className="small muted mb">{i + 1}. {Q_LABEL[q.kind] ?? "Вопрос"}</div>
              <Markdown>{q.question}</Markdown>
              <textarea
                rows={4} value={answers[q.id] ?? ""} placeholder="Отвечай по памяти, своими словами…"
                onChange={(ev) => setAnswers((a) => ({ ...a, [q.id]: ev.target.value }))}
                {...textareaHandlers(recs[q.id], `encounter:${q.id}`, "answer")}
              />
            </div>
          ))}
          <div className="row mt">
            <button className="btn primary lg" disabled={busy || !questions.some((q) => (answers[q.id] ?? "").trim())} onClick={submit}>
              {busy ? <><span className="spinner" /> проверяю…</> : "Ответить"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={leave}>Уйти от встречи</button>
          </div>
        </>
      )}
    </div>
  );
}
