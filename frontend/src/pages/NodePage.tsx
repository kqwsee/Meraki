import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import Chat, { type Msg } from "../components/Chat";
import Markdown from "../components/Markdown";
import { ErrorBox, Loading, Modal, MODE_LABELS, STAGE_NAMES } from "../components/ui";
import { tracker, TypingRecorder, textareaHandlers } from "../telemetry/tracker";
import { ExamPanel, PracticePanel, type AttemptT, type TaskT } from "../workspace/Panels";
import Workspace from "../workspace/Workspace";

type Verification = { flag_id: number; question: string; fragment: string; kind: string; answer: string | null; understood?: boolean | null; comment?: string };
type Attempt = AttemptT & {
  raw_score: number | null; score: number | null; understanding: number | null; summary: string; weak_concepts: string[];
  verification: Verification[];
};
type State = {
  node: { id: number; title: string; summary: string; objectives: string[]; concepts: string[]; mode: string; personal: boolean };
  course: { id: number; title: string; domain: string; tools: string[] };
  progress: {
    stage: string; completed: boolean; assessment: any; practice_score: number | null; exam_score: number | null;
    exit_ticket: string; exit_ticket_feedback: string;
  };
  messages: Record<"prologue" | "lecture" | "practice", Msg[]>;
  practice_tasks: TaskT[];
  exam: Attempt | null;
  exam_history: { id: number; score: number | null; status: string }[];
  job: { kind: string; error: string | null } | null;
  pass_score: number;
};

const ORDER = ["prologue", "lecture", "practice", "exam"];
const FLAG_LABELS: Record<string, string> = {
  paste: "вставка из буфера",
  burst: "необычно быстрый ввод",
  bulk_insert: "текст введён целиком",
};
const JOB_TEXT: Record<string, string> = {
  practice_tasks: "Наставник составляет задания под твой уровень…",
  exam_start: "Наставник готовит экзамен с учётом твоей практики…",
  exam_grading: "Экзаменатор проверяет ответы…",
  exam_verify: "Наставник оценивает твои пояснения…",
};

export default function NodePage() {
  const { nodeId } = useParams();
  const id = Number(nodeId);
  const [st, setSt] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<number | null>(null);
  const [exitModal, setExitModal] = useState(false);
  const [examModal, setExamModal] = useState(false);

  const load = useCallback(() => api.get<State>(`/nodes/${id}/state`).then(setSt).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const jobRunning = !!st?.job && !st.job.error;
  useEffect(() => {
    if (!jobRunning) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [jobRunning, load]);

  const current = st?.progress.stage ?? "prologue";
  const viewing = view ?? (current === "done" ? "exam" : current);

  useEffect(() => {
    if (!st || viewing === "exam") return; // ExamStage owns the exam context (task + attempt)
    tracker.setContext({
      nodeId: id,
      stage: viewing,
      taskId: viewing === "practice" || viewing === "exam" ? activeTask : null,
      attemptId: viewing === "exam" && st.exam?.status === "in_progress" ? st.exam.id : null,
    });
  }, [id, viewing, activeTask, st]);

  async function advance(to: string, extra: Record<string, unknown> = {}) {
    setBusy(to);
    setError(null);
    try {
      await api.post(`/nodes/${id}/advance`, { to, ...extra });
      await load();
      setView(to);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function job(url: string, body?: unknown, thenView?: string) {
    setError(null);
    try {
      await api.post(url, body);
      await load();
      if (thenView) setView(thenView);
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (!st) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;
  const curIdx = current === "done" ? 4 : ORDER.indexOf(current);
  const mode = MODE_LABELS[st.node.mode];

  return (
    <>
      <div className="learn-header">
        <Link to={`/courses/${st.course.id}`} className="btn sm ghost" title="К графу курса">←</Link>
        <div style={{ minWidth: 0 }}>
          <div className="crumb">{st.course.title}</div>
          <div className="row" style={{ gap: 8 }}>
            <span className="topic">{st.node.title}</span>
            {mode && <span className={`badge ${mode.cls}`}>{mode.label}</span>}
            {st.progress.completed && <span className="badge success">✓ тема пройдена</span>}
          </div>
        </div>
        <span className="spacer" />
        <div className="stepper">
          {ORDER.map((s, i) => (
            <span key={s} style={{ display: "contents" }}>
              {i > 0 && <span className="step-arrow">›</span>}
              <span
                className={`step ${i < curIdx ? "done" : i === curIdx ? "current" : "locked"} ${viewing === s ? "viewing" : ""}`}
                onClick={() => i <= curIdx && setView(s)}
              >
                <span className="num">{i < curIdx ? "✓" : i + 1}</span>
                {STAGE_NAMES[s]}
              </span>
            </span>
          ))}
        </div>
      </div>
      {error && <div style={{ padding: "8px 20px" }}><ErrorBox error={error} /></div>}
      {st.job?.error && (
        <div style={{ padding: "8px 20px" }}>
          <div className="alert error">Не получилось: {st.job.error}. Попробуй ещё раз.</div>
        </div>
      )}

      {(viewing === "prologue" || viewing === "lecture") && (
        <div className="chat-page">
          <Chat
            key={viewing}
            nodeId={id}
            courseId={st.course.id}
            stage={viewing as "prologue" | "lecture"}
            initial={st.messages[viewing as "prologue" | "lecture"]}
            autoStart={viewing === current}
            placeholder={viewing === "prologue" ? "Отвечай как думаешь — это не экзамен…" : undefined}
          />
          <aside className="chat-side">
            {viewing === "prologue" ? (
              <>
                <h3>Пролог</h3>
                <p className="small muted">
                  Наставник поговорит с тобой о чём-то близком к теме, чтобы понять, что ты уже знаешь и как рассуждаешь. Ошибаться можно —
                  к твоим догадкам вернёмся на лекции.
                </p>
              </>
            ) : (
              <>
                <h3>Лекция</h3>
                <p className="small muted">Объяснение порциями. Задавай вопросы, отвечай на проверочные — так материал запоминается лучше.</p>
                {st.progress.assessment?.overall_level != null && (
                  <div className="alert small mb">
                    Стартовый уровень по прологу: <b>{Math.round(st.progress.assessment.overall_level * 100)}%</b>
                    {st.progress.assessment.misconceptions?.length > 0 && <> · разберём заблуждения: {st.progress.assessment.misconceptions.join("; ")}</>}
                  </div>
                )}
              </>
            )}
            <h3 className="mt">Цели темы</h3>
            <ul className="small" style={{ paddingLeft: 18 }}>{st.node.objectives.map((o) => <li key={o}>{o}</li>)}</ul>
            <div className="row" style={{ gap: 4 }}>{st.node.concepts.map((c) => <span key={c} className="badge">{c}</span>)}</div>
            <div className="col mt">
              {viewing === "prologue" && current === "prologue" && (
                <button className="btn primary" onClick={() => advance("lecture")} disabled={!!busy}>
                  {busy === "lecture" ? <><span className="spinner" /> подвожу итоги…</> : "К лекции →"}
                </button>
              )}
              {viewing === "lecture" && current === "lecture" && (
                <button className="btn primary" onClick={() => setExitModal(true)} disabled={!!busy}>
                  {busy === "practice" ? <><span className="spinner" /> составляю конспект…</> : "К практике →"}
                </button>
              )}
              {st.node.mode === "fast" && (current === "prologue" || current === "lecture") && (
                <button className="btn" onClick={() => confirm("Сдать тему экстерном — сразу экзамен без лекции и практики?") && advance("exam")} disabled={!!busy}>
                  ⚡ Сдать экстерном
                </button>
              )}
              {viewing !== current && current !== "done" && (
                <button className="btn ghost" onClick={() => setView(null)}>Вернуться к этапу «{STAGE_NAMES[current]}»</button>
              )}
            </div>
            {viewing === "lecture" && st.progress.exit_ticket_feedback && (
              <div className="card mt" style={{ padding: 12 }}>
                <b className="small">Твой пересказ — комментарий наставника</b>
                <p className="small">{st.progress.exit_ticket_feedback}</p>
              </div>
            )}
          </aside>
        </div>
      )}

      {viewing === "practice" && (
        <Workspace
          courseId={st.course.id} nodeId={id} stage="practice" tools={st.course.tools} domain={st.course.domain}
          taskPanel={
            <>
              <PracticePanel
                tasks={st.practice_tasks}
                generating={st.job?.kind === "practice_tasks" && !st.job.error}
                onReload={load}
                onMore={() => job(`/nodes/${id}/practice/more`, {})}
                onActive={setActiveTask}
              />
              {current === "practice" && st.practice_tasks.length > 0 && (
                <div className="ws-section">
                  <button className="btn primary" style={{ width: "100%" }} onClick={() => setExamModal(true)} disabled={jobRunning}>
                    {st.job?.kind === "exam_start" && !st.job.error ? <><span className="spinner" /> готовлю экзамен…</> : "К экзамену →"}
                  </button>
                </div>
              )}
            </>
          }
          helper={<Chat key="practice" nodeId={id} courseId={st.course.id} stage="practice" initial={st.messages.practice} compact copySource="tutor"
            placeholder="Спроси помощника: что непонятно, где застрял(а)…" />}
        />
      )}

      {viewing === "exam" && <ExamStage st={st} id={id} onReload={load} onJob={job} onPractice={() => setView("practice")} />}

      {exitModal && (
        <ExitTicket
          onClose={() => setExitModal(false)}
          onSubmit={(text) => {
            setExitModal(false);
            advance("practice", { exit_ticket: text });
          }}
        />
      )}
      {examModal && (
        <Modal title="Перейти к экзамену?" onClose={() => setExamModal(false)}
          footer={<>
            <button className="btn" onClick={() => setExamModal(false)}>Ещё потренируюсь</button>
            <button className="btn primary" onClick={() => { setExamModal(false); advance("exam"); }}>Начать экзамен</button>
          </>}>
          <p>На экзамене нет помощника и подсказок, есть ограничение по времени. Инструменты и рабочее пространство остаются.</p>
          <p className="small muted">Экзамен составляется с учётом твоей практики: понятия, где ты работал(а) не сам(а), будут проверены внимательнее.</p>
          {st.progress.practice_score != null && <p>Средний балл практики: <b>{Math.round(st.progress.practice_score)}</b></p>}
        </Modal>
      )}
    </>
  );
}

function ExitTicket({ onClose, onSubmit }: { onClose: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  const rec = useMemo(() => new TypingRecorder("exit_ticket", "answer"), []);
  const handlers = useMemo(() => textareaHandlers(rec, "exit_ticket", "answer"), [rec]);
  return (
    <Modal title="Выходной билет" onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={() => onSubmit("")}>Пропустить</button>
        <button className="btn primary" disabled={text.trim().length < 15} onClick={() => { rec.flush(); onSubmit(text); }}>К практике →</button>
      </>}>
      <p>Перескажи своими словами главное из лекции — 3–5 предложений, не подглядывая.</p>
      <p className="small muted">Свободное припоминание — один из самых эффективных способов закрепить материал. Наставник прокомментирует, что упущено.</p>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} autoFocus {...handlers} />
    </Modal>
  );
}

function ExamStage({ st, id, onReload, onJob, onPractice }: {
  st: State; id: number; onReload: () => void; onJob: (url: string, body?: unknown, view?: string) => void; onPractice: () => void;
}) {
  const [activeTask, setActiveTask] = useState<number | null>(null);
  const ex = st.exam;
  const runningJob = st.job && !st.job.error ? st.job.kind : null;

  useEffect(() => {
    tracker.setContext({ nodeId: id, stage: "exam", taskId: activeTask, attemptId: ex?.status === "in_progress" ? ex.id : null });
  }, [id, activeTask, ex?.id, ex?.status]);

  if (runningJob && JOB_TEXT[runningJob]) return <Loading text={JOB_TEXT[runningJob]} />;
  if (!ex) {
    return (
      <div className="page"><div className="empty">
        Экзамен ещё не начат. <button className="btn primary" onClick={() => onJob(`/nodes/${id}/exam/retry`)}>Начать экзамен</button>
      </div></div>
    );
  }
  if (ex.status === "in_progress") {
    return (
      <Workspace courseId={st.course.id} nodeId={id} stage="exam" tools={st.course.tools} domain={st.course.domain}
        deadline={ex.started_at} timeLimitMin={ex.time_limit_min}
        taskPanel={<ExamPanel attempt={ex} onSubmitted={onReload} onActive={setActiveTask} />} />
    );
  }
  if (ex.status === "verifying") return <VerifyView attempt={ex} onDone={onReload} />;
  return <ResultView st={st} ex={ex} id={id} onJob={onJob} onPractice={onPractice} />;
}

function VerifyView({ attempt, onDone }: { attempt: Attempt; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recs = useMemo(() => Object.fromEntries(attempt.verification.map((v) => [v.flag_id, new TypingRecorder(`verify:${v.flag_id}`, "answer")])), [attempt]);
  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <h1>Защита решения</h1>
      <p className="muted">
        Экзамен проверен. В некоторых местах система заметила вставку из буфера обмена или необычно быстрый ввод — это не обвинение,
        а повод убедиться, что решение понятно тебе самому. Ответь коротко своими словами.
      </p>
      <ErrorBox error={error} />
      {attempt.verification.map((v, i) => {
        const handlers = textareaHandlers(recs[v.flag_id], `verify:${v.flag_id}`, "answer");
        return (
          <div className="card" key={v.flag_id}>
            <div className="row mb"><b>Вопрос {i + 1}</b><span className="badge">{FLAG_LABELS[v.kind] ?? v.kind}</span></div>
            <div className="md"><pre>{v.fragment}</pre></div>
            <Markdown>{v.question}</Markdown>
            <textarea rows={4} value={answers[v.flag_id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [v.flag_id]: e.target.value }))} {...handlers} />
          </div>
        );
      })}
      <button className="btn primary lg mt" disabled={busy || attempt.verification.some((v) => !(answers[v.flag_id] ?? "").trim())}
        onClick={async () => {
          setBusy(true);
          Object.values(recs).forEach((r) => r.flush());
          await tracker.flush();
          try {
            await api.post(`/exams/${attempt.id}/verify`, { answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v])) });
            onDone();
          } catch (e: any) {
            setError(e.message);
            setBusy(false);
          }
        }}>
        {busy ? <span className="spinner" /> : "Отправить пояснения"}
      </button>
    </div>
  );
}

function ResultView({ st, ex, id, onJob, onPractice }: {
  st: State; ex: Attempt; id: number; onJob: (url: string, body?: unknown, view?: string) => void; onPractice: () => void;
}) {
  const passed = (ex.score ?? 0) >= st.pass_score;
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="card row" style={{ gap: 24 }}>
        <div className="center">
          <div className="score-big" style={{ color: passed ? "var(--success)" : "var(--warning)" }}>{Math.round(ex.score ?? 0)}</div>
          <div className="small muted">из 100</div>
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0 }}>{passed ? "Тема сдана! 🎉" : "Пока не сдано"}</h2>
          <div className="small muted">
            Порог {st.pass_score}. Баллы за задания: {Math.round(ex.raw_score ?? 0)}
            {ex.understanding != null && <> · понимание при защите решения: {Math.round(ex.understanding * 100)}%</>}
          </div>
          {ex.weak_concepts.length > 0 && (
            <div className="row mt" style={{ gap: 4 }}>
              <span className="small">Повторить:</span>
              {ex.weak_concepts.map((c) => <span key={c} className="badge warning">{c}</span>)}
            </div>
          )}
        </div>
      </div>
      {ex.summary && <div className="card"><Markdown>{ex.summary}</Markdown></div>}
      {passed ? (
        <div className="alert success">🧭 Наставник обновляет твой профиль и перестраивает маршрут по курсу с учётом этой темы.</div>
      ) : (
        <div className="alert warning">Это нормально: ошибки на экзамене показывают, что стоит доработать. Потренируй слабые места и пересдай.</div>
      )}
      <div className="row mt mb">
        <Link className="btn primary" to={`/courses/${st.course.id}`}>К графу курса</Link>
        {!passed && (
          <>
            <button className="btn" onClick={() => { onJob(`/nodes/${id}/practice/more`, { focus: ex.weak_concepts }); onPractice(); }}>
              Доработать слабые места
            </button>
            <button className="btn" onClick={() => onJob(`/nodes/${id}/exam/retry`)}>Пересдать экзамен</button>
          </>
        )}
      </div>
      <h3>Разбор заданий</h3>
      {ex.tasks.map((t, i) => (
        <details key={t.id} className="card" open={i === 0}>
          <summary style={{ cursor: "pointer" }}>
            <b>{i + 1}. {t.title}</b>{" "}
            {t.score != null && <span className={`badge ${t.score >= 60 ? "success" : "warning"}`}>{Math.round(t.score)}</span>}
          </summary>
          <div className="mt"><Markdown>{t.statement}</Markdown></div>
          {t.feedback && <div className="alert mt"><Markdown>{t.feedback}</Markdown></div>}
        </details>
      ))}
      {ex.verification.length > 0 && (
        <>
          <h3 className="mt">Защита решения</h3>
          {ex.verification.map((v) => (
            <div key={v.flag_id} className="card">
              <div className="small muted">{v.question}</div>
              <p>{v.answer}</p>
              <span className={`badge ${v.understood ? "success" : "warning"}`}>{v.understood ? "понимает" : "есть пробел"}</span> <span className="small">{v.comment}</span>
            </div>
          ))}
        </>
      )}
      {st.exam_history.length > 0 && (
        <p className="small muted mt">Предыдущие попытки: {st.exam_history.map((h) => `${h.score != null ? Math.round(h.score) : "—"}`).join(", ")}</p>
      )}
    </div>
  );
}
