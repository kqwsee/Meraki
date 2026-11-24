import { useEffect, useMemo, useRef, useState } from "react";
import { api, streamPost } from "../api";
import { TypingRecorder, textareaHandlers } from "../telemetry/tracker";
import Markdown from "./Markdown";

export type Msg = { id: number | string; role: "user" | "assistant"; content: string };

type Props = {
  nodeId: number;
  courseId: number;
  stage: "prologue" | "lecture" | "practice";
  initial: Msg[];
  autoStart?: boolean;
  compact?: boolean;
  placeholder?: string;
  copySource?: string;
  /** Message opened from the talent evidence page: scroll to it and mark it. */
  focusMessageId?: number | null;
};

export default function Chat({
  nodeId, courseId, stage, initial, autoStart, compact, placeholder, copySource = "tutor", focusMessageId = null,
}: Props) {
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const target = `chat:${stage}`;
  const rec = useMemo(() => new TypingRecorder(target, "chat"), [target]);
  const handlers = useMemo(() => textareaHandlers(rec, target, "chat"), [rec, target]);

  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // arriving from a talent-evidence link: centre the exact message instead of jumping to the end
  useEffect(() => {
    if (focusMessageId == null) return;
    const el = document.getElementById(`message-${focusMessageId}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusMessageId, messages.length]);

  // the input grows with the text (up to the CSS max-height) instead of a fixed two-line box
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [draft]);

  async function send(content: string | null) {
    setBusy(true);
    setError(null);
    const typing = content !== null ? rec.takeStats() : undefined;
    const tempId = `a${Date.now()}`;
    setMessages((m) => [
      ...m,
      ...(content !== null ? [{ id: `u${Date.now()}`, role: "user" as const, content }] : []),
      { id: tempId, role: "assistant", content: "" },
    ]);
    try {
      await streamPost(`/nodes/${nodeId}/chat/${stage}`, { content, typing }, (ev) => {
        if (ev.type === "delta") {
          setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, content: x.content + ev.text } : x)));
        } else if (ev.type === "error") {
          setError(ev.message);
        } else if (ev.type === "done" && ev.message) {
          setMessages((m) => m.map((x) => (x.id === tempId ? { ...x, id: ev.message.id } : x)));
        }
      });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setMessages((m) => m.filter((x) => !(x.id === tempId && !x.content)));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoStart && !started.current && initial.length === 0) {
      started.current = true;
      send(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, initial.length]);

  function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    rec.sync("");
    setDraft("");
    send(text);
  }

  async function saveNote(m: Msg) {
    const firstLine = m.content.split("\n").find((l) => l.trim()) ?? "Заметка";
    await api.post("/notes", {
      title: firstLine.replace(/^#+\s*/, "").slice(0, 80),
      content: m.content,
      course_id: courseId,
      node_id: nodeId,
    });
    setSaved((s) => ({ ...s, [String(m.id)]: true }));
  }

  return (
    <div className={`chat ${compact ? "chat-compact" : ""}`}>
      <div className="chat-messages" ref={scroller} data-copy-source={copySource}>
        {messages.map((m) => (
          <div
            key={m.id}
            id={typeof m.id === "number" ? `message-${m.id}` : undefined}
            className={`msg ${m.role}${focusMessageId != null && m.id === focusMessageId ? " focus" : ""}`}
          >
            {m.role === "assistant" ? (
              m.content ? (
                <>
                  <Markdown>{m.content}</Markdown>
                  {!busy && typeof m.id === "number" && !compact && (
                    <div className="msg-actions">
                      <button className="btn sm ghost" disabled={saved[String(m.id)]} onClick={() => saveNote(m)}>
                        {saved[String(m.id)] ? "✓ В заметках" : "☆ В заметки"}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <span className="row muted"><span className="spinner" /> наставник думает…</span>
              )
            ) : (
              m.content
            )}
          </div>
        ))}
        {error && <div className="alert error">{error}</div>}
      </div>
      <div className="chat-input">
        <textarea
          ref={input}
          value={draft}
          rows={1}
          placeholder={placeholder ?? "Напиши ответ или вопрос… (Enter — отправить, Shift+Enter — новая строка)"}
          onChange={(e) => setDraft(e.target.value)}
          {...handlers}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={busy}
        />
        <button className="btn primary" onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? <span className="spinner" /> : "Отправить"}
        </button>
      </div>
    </div>
  );
}
