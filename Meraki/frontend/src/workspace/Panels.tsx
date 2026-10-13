import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Markdown from "../components/Markdown";
import { Modal } from "../components/ui";
import { tracker, TypingRecorder, textareaHandlers } from "../telemetry/tracker";
import { useWorkspace } from "./context";

export type TaskT = {
  id: number; title: string; statement: string; kind: string; language: string; concept: string; bloom: string; scaffold: string;
  starter_files: string[]; status: string; score: number | null; feedback: string; hints: string[]; confidence: number | null;
};

const SCAFFOLD: Record<string, string> = {
  worked: "разобранный пример", predict: "предскажи", modify: "измени", make: "создай", transfer: "перенос", interleaved: "повторение",
};
const BLOOM: Record<string, string> = {
  remember: "вспомнить", understand: "понять", apply: "применить", analyze: "анализ", evaluate: "оценка", create: "создание",
};
const KIND: Record<string, string> = { code: "💻 код", text: "✍️ ответ", calc: "🧮 расчёт", canvas: "🖌 холст" };

function useAttachments(task: TaskT | undefined) {
  const ws = useWorkspace()!;
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [withCanvas, setWithCanvas] = useState(false);
  useEffect(() => {
    if (!task) return;
    const init: Record<string, boolean> = {};
    task.starter_files.forEach((p) => (init[p] = true));
    if (ws.activePath) init[ws.activePath] = true;
    setSelected(init);
    setWithCanvas(task.kind === "canvas");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);
  async function collect() {
    const files = [];
    for (const p of Object.keys(selected).filter((k) => selected[k] && ws.files.includes(k))) {
      files.push({ path: p, content: await ws.readFile(p) });
    }
    return { files, canvas: withCanvas ? ws.canvasSummary() : "" };
  }
  const ui = (
    <details className="small" style={{ marginTop: 6 }}>
      <summary className="muted" style={{ cursor: "pointer" }}>
        Приложить: {Object.values(selected).filter(Boolean).length} файл(ов){withCanvas ? " + холст" : ""}
      </summary>
      <div className="col" style={{ gap: 2, marginTop: 4 }}>
        <label className="checkbox"><input type="checkbox" checked={withCanvas} onChange={(e) => setWithCanvas(e.target.checked)} /> холст (описание рисунка)</label>
        {ws.files.filter((f) => !f.endsWith(".keep")).map((f) => (
          <label key={f} className="checkbox">
            <input type="checkbox" checked={!!selected[f]} onChange={(e) => setSelected((s) => ({ ...s, [f]: e.target.checked }))} /> {f}
          </label>
        ))}
      </div>
    </details>
  );
  return { collect, ui };
}

function TaskMeta({ t }: { t: TaskT }) {
  return (
    <div className="row" style={{ gap: 4, marginTop: 4 }}>
      <span className="badge">{KIND[t.kind] ?? t.kind}</span>
      {t.scaffold && <span className="badge accent">{SCAFFOLD[t.scaffold] ?? t.scaffold}</span>}
      {t.bloom && <span className="badge">Блум: {BLOOM[t.bloom] ?? t.bloom}</span>}
    </div>
  );
}

// ---------------- practice ----------------

export function PracticePanel({ tasks, generating, onReload, onMore, onActive }: {
  tasks: TaskT[]; generating: boolean; onReload: () => void; onMore: () => void; onActive: (id: number | null) => void;
}) {
  const ws = useWorkspace()!;
  const [activeId, setActiveId] = useState<number | null>(tasks[0]?.id ?? null);
  const task = tasks.find((t) => t.id === activeId) ?? tasks[0];
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [hintsShown, setHintsShown] = useState<Record<number, number>>({});
  const [confidence, setConfidence] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collect, ui } = useAttachments(task);
  const target = task ? `answer:${task.id}` : "answer";
  const rec = useMemo(() => new TypingRecorder(target, "answer"), [target]);
  const handlers = useMemo(() => textareaHandlers(rec, target, "answer"), [rec, target]);

  useEffect(() => {
    onActive(task?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  // starter files are created together with new tasks
  useEffect(() => {
    if (tasks.length) ws.refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  if (!tasks.length) {
    return (
      <div className="ws-section">
        {generating ? (
          <div className="loading-block"><span className="spinner" /><div>Наставник готовит задания под твой уровень…</div></div>
        ) : (
          <div className="col"><div className="muted small">Заданий пока нет.</div><button className="btn primary" onClick={onMore}>Сгенерировать задания</button></div>
        )}
      </div>
    );
  }

  async function submit() {
    if (!task) return;
    setBusy(true);
    setError(null);
    rec.flush();
    try {
      const { files, canvas } = await collect();
      await api.post(`/tasks/${task.id}/submit`, { answer: answers[task.id] ?? "", files, canvas, confidence: confidence[task.id] });
      tracker.log("task_submit", `task:${task.id}`, { files: files.length, canvas: !!canvas, confidence: confidence[task.id] });
      onReload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = task ? hintsShown[task.id] ?? 0 : 0;
  const graded = tasks.filter((t) => t.status === "graded").length;

  return (
    <div>
      <div className="ws-section">
        <div className="ws-section-title">📋 Задания ({graded}/{tasks.length} проверено)</div>
        {tasks.map((t, i) => (
          <div key={t.id} className={`task-item ${t.id === task?.id ? "active" : ""}`} onClick={() => setActiveId(t.id)}>
            <div className="row" style={{ gap: 6 }}>
              <span className="ttitle" style={{ flex: 1 }}>{i + 1}. {t.title}</span>
              {t.score != null && <span className={`badge ${t.score >= 60 ? "success" : "warning"}`}>{Math.round(t.score)}</span>}
            </div>
            {t.id === task?.id && <TaskMeta t={t} />}
          </div>
        ))}
        <button className="btn sm ghost" onClick={onMore} disabled={generating}>
          {generating ? <><span className="spinner" /> готовлю…</> : "+ ещё задания"}
        </button>
      </div>
      {task && (
        <div className="ws-section task-detail">
          <Markdown>{task.statement}</Markdown>
          {task.starter_files.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              {task.starter_files.map((p) => <button key={p} className="btn sm" onClick={() => ws.openFile(p)}>📄 {p.split("/").pop()}</button>)}
            </div>
          )}
          {task.kind === "canvas" && <button className="btn sm mt" onClick={ws.showCanvas}>🖌 Открыть холст</button>}

          {task.hints.slice(0, shown).map((h, i) => <div key={i} className="hint">💡 {h}</div>)}
          {shown < task.hints.length && (
            <button className="btn sm ghost mt" onClick={() => {
              setHintsShown((s) => ({ ...s, [task.id]: shown + 1 }));
              tracker.log("hint_open", `task:${task.id}`, { index: shown + 1 });
            }}>💡 Подсказка {shown + 1}/{task.hints.length}</button>
          )}

          <label className="field mt">
            Ответ / пояснение решения
            <textarea rows={4} value={answers[task.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [task.id]: e.target.value }))}
              placeholder={task.kind === "code" ? "Кратко: как работает твоё решение (код приложи файлом)" : "Твой ответ и ход рассуждений"} {...handlers} />
          </label>
          {ui}
          <div className="small muted mt">Насколько ты уверен(а) в решении?</div>
          <div className="confidence">
            {[1, 2, 3, 4, 5].map((v) => (
              <button key={v} className={confidence[task.id] === v ? "on" : ""} onClick={() => setConfidence((c) => ({ ...c, [task.id]: v }))}
                title={["", "наугад", "сомневаюсь", "наполовину", "скорее уверен", "уверен"][v]}>{v}</button>
            ))}
          </div>
          {error && <div className="alert error mt">{error}</div>}
          <button className="btn primary mt" style={{ width: "100%" }} onClick={submit} disabled={busy || !confidence[task.id]}>
            {busy ? <><span className="spinner" /> наставник проверяет…</> : task.status === "graded" ? "Сдать повторно" : "Сдать на проверку"}
          </button>
          {task.feedback && (
            <div className="card mt" style={{ padding: 12 }}>
              <div className="row mb"><b>Проверка</b><span className="spacer" />
                {task.score != null && <span className={`badge ${task.score >= 60 ? "success" : "warning"}`}>{Math.round(task.score)}/100</span>}</div>
              <Markdown>{task.feedback}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- exam ----------------

export type AttemptT = {
  id: number; status: string; time_limit_min: number; started_at: string; tasks: TaskT[];
};

export function ExamPanel({ attempt, onSubmitted, onActive }: { attempt: AttemptT; onSubmitted: () => void; onActive: (id: number | null) => void }) {
  const ws = useWorkspace()!;
  const draftKey = `meraki_exam_${attempt.id}`;
  const [answers, setAnswers] = useState<Record<number, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [activeId, setActiveId] = useState(attempt.tasks[0]?.id);
  const task = attempt.tasks.find((t) => t.id === activeId) ?? attempt.tasks[0];
  const deadline = new Date(attempt.started_at).getTime() + attempt.time_limit_min * 60000;
  const [left, setLeft] = useState(() => Math.max(0, deadline - Date.now()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collect, ui } = useAttachments(task);
  const target = task ? `answer:${task.id}` : "answer";
  const rec = useMemo(() => new TypingRecorder(target, "answer"), [target]);
  const handlers = useMemo(() => textareaHandlers(rec, target, "answer"), [rec, target]);
  const [attachments, setAttachments] = useState<Record<number, { files: { path: string; content: string }[]; canvas: string }>>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    onActive(task?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(answers));
    } catch {
      /* ignore */
    }
  }, [answers, draftKey]);

  useEffect(() => {
    const tick = () => setLeft(Math.max(0, deadline - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [deadline]);

  // auto-submit only when the time limit has really run out
  useEffect(() => {
    if (left === 0 && Date.now() >= deadline && !busy && attempt.status === "in_progress") submit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  async function snapshot() {
    if (!task) return attachments;
    const current = await collect();
    const next = { ...attachments, [task.id]: current };
    setAttachments(next);
    return next;
  }

  async function submit(auto = false) {
    setConfirming(false);
    setBusy(true);
    setError(null);
    rec.flush();
    try {
      const att = await snapshot();
      const payload: Record<string, unknown> = {};
      for (const t of attempt.tasks) {
        const a = att[t.id] ?? { files: [], canvas: "" };
        if (!att[t.id]) {
          for (const p of t.starter_files) if (ws.files.includes(p)) a.files.push({ path: p, content: await ws.readFile(p) });
          if (t.kind === "canvas") a.canvas = ws.canvasSummary();
        }
        payload[String(t.id)] = { answer: answers[t.id] ?? "", files: a.files, canvas: a.canvas };
      }
      tracker.log("exam_submit", `attempt:${attempt.id}`, { auto });
      await tracker.flush(); // flags must reach the server before grading reads them
      await api.post(`/exams/${attempt.id}/submit`, { answers: payload });
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      onSubmitted();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");

  return (
    <div>
      <div className="ws-section">
        <div className="row">
          <div className="ws-section-title" style={{ margin: 0 }}>🎓 Экзамен</div>
          <span className="spacer" />
          <span className={`exam-timer ${left < 5 * 60000 ? "low" : ""}`}>{mm}:{ss}</span>
        </div>
        <div className="small muted mt">
          Без помощника и подсказок. Вставки из буфера и необычно быстрый ввод фиксируются — по таким фрагментам после экзамена будут уточняющие вопросы.
        </div>
      </div>
      <div className="ws-section">
        {attempt.tasks.map((t, i) => (
          <div key={t.id} className={`task-item ${t.id === task?.id ? "active" : ""}`}
            onClick={async () => { await snapshot(); setActiveId(t.id); }}>
            <div className="row" style={{ gap: 6 }}>
              <span className="ttitle" style={{ flex: 1 }}>{i + 1}. {t.title}</span>
              {(answers[t.id] ?? "").trim() && <span className="badge success">✓</span>}
            </div>
            {t.id === task?.id && <TaskMeta t={t} />}
          </div>
        ))}
      </div>
      {task && (
        <div className="ws-section task-detail">
          <Markdown>{task.statement}</Markdown>
          {task.starter_files.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              {task.starter_files.map((p) => <button key={p} className="btn sm" onClick={() => ws.openFile(p)}>📄 {p.split("/").pop()}</button>)}
            </div>
          )}
          <label className="field mt">
            Ответ
            <textarea rows={5} value={answers[task.id] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [task.id]: e.target.value }))} {...handlers} />
          </label>
          {ui}
          {error && <div className="alert error mt">{error}</div>}
          <button className="btn success mt" style={{ width: "100%" }} onClick={() => setConfirming(true)} disabled={busy}>
            {busy ? <><span className="spinner" /> отправляю…</> : "Сдать экзамен"}
          </button>
        </div>
      )}
      {confirming && (
        <Modal title="Сдать экзамен?" onClose={() => setConfirming(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirming(false)}>Ещё поработаю</button>
            <button className="btn success" onClick={() => submit(false)}>Сдать</button>
          </>}>
          <p>Изменить ответы после сдачи нельзя.</p>
          <p className="small muted">Заданий без текстового ответа: {attempt.tasks.filter((t) => !(answers[t.id] ?? "").trim()).length}. Файлы задания и холст приложатся автоматически.</p>
        </Modal>
      )}
    </div>
  );
}
