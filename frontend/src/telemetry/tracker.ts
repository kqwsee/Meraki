/**
 * Records learner actions for the AI tutor and for self-reliance analysis.
 * Keystroke features follow writing-process research (see docs/TYPING_ANALYTICS.md):
 * typing segments, >=2 s cognitive pauses, sentence-start pauses, revisions, rhythm variability, pastes.
 */
import { api } from "../api";

export type TrackContext = { nodeId?: number | null; stage?: string; taskId?: number | null; attemptId?: number | null };
type Ev = { type: string; target?: string; data?: Record<string, unknown>; task_id?: number | null };

const SEGMENT_GAP_MS = 5000;
const COGNITIVE_PAUSE_MS = 2000;

class Tracker {
  sessionId: string | null = null;
  private ctx: TrackContext = {};
  private queue: Ev[] = [];
  private timer: number | null = null;
  private lastCopy: { text: string; source: string } | null = null;
  private awaySince: number | null = null;
  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      this.sessionId = sessionStorage.getItem("meraki_session");
    } catch {
      this.sessionId = null;
    }
    if (!this.sessionId) {
      try {
        const res = await api.post<{ session_id: string }>("/sessions");
        this.sessionId = res.session_id;
        try {
          sessionStorage.setItem("meraki_session", res.session_id);
        } catch {
          /* ignore */
        }
      } catch {
        this.started = false;
        return;
      }
    }
    this.timer = window.setInterval(() => this.flush(), 8000);
    document.addEventListener("copy", this.onCopy, true);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("pagehide", this.onHide);
  }

  async end() {
    this.flush();
    if (this.sessionId) await api.beacon(`/sessions/${this.sessionId}/end`, {});
    try {
      sessionStorage.removeItem("meraki_session");
    } catch {
      /* ignore */
    }
    this.sessionId = null;
    this.started = false;
    if (this.timer) window.clearInterval(this.timer);
    document.removeEventListener("copy", this.onCopy, true);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("pagehide", this.onHide);
  }

  setContext(ctx: TrackContext) {
    const same =
      ctx.nodeId === this.ctx.nodeId && ctx.stage === this.ctx.stage && ctx.taskId === this.ctx.taskId && ctx.attemptId === this.ctx.attemptId;
    if (same) return;
    this.flush();
    this.ctx = ctx;
    if (ctx.stage) this.log("stage_enter", ctx.stage);
  }

  get context() {
    return this.ctx;
  }

  log(type: string, target = "", data: Record<string, unknown> = {}) {
    this.queue.push({ type, target, data, task_id: this.ctx.taskId ?? null });
    if (this.queue.length >= 60) this.flush();
  }

  /** Sends queued events; await it when the server must see them before the next request (exam submit). */
  flush(): Promise<unknown> {
    if (!this.sessionId || !this.queue.length) return Promise.resolve();
    const events = this.queue;
    this.queue = [];
    return api.beacon("/telemetry", {
      session_id: this.sessionId,
      node_id: this.ctx.nodeId ?? null,
      stage: this.ctx.stage ?? "",
      task_id: this.ctx.taskId ?? null,
      attempt_id: this.ctx.attemptId ?? null,
      events,
    });
  }

  /** Where clipboard text came from: own workspace, the tutor chat, or outside the app. */
  pasteSource(text: string): string {
    if (this.lastCopy && this.lastCopy.text.trim() === text.trim()) return this.lastCopy.source;
    return "external";
  }

  logPaste(target: string, surface: string, text: string) {
    this.log("paste", target, { chars: text.length, text: text.slice(0, 2000), surface, source: this.pasteSource(text) });
  }

  private onCopy = (e: ClipboardEvent) => {
    const text = window.getSelection()?.toString() ?? "";
    const el = e.target instanceof Element ? e.target.closest("[data-copy-source]") : null;
    const source = el ? `internal:${el.getAttribute("data-copy-source")}` : "internal:other";
    if (text) this.lastCopy = { text, source };
  };

  private onBlur = () => {
    this.awaySince = Date.now();
  };

  private onFocus = () => {
    if (this.awaySince) {
      const away = Date.now() - this.awaySince;
      this.awaySince = null;
      if (away > 1500) this.log("visibility", "window", { hidden: false, away_ms: away });
    }
  };

  private onHide = () => {
    this.flush();
  };
}

export const tracker = new Tracker();

/** A paste or deletion inside one draft: the text before and after it, for the talent evidence page. */
export type DraftRevision = { kind: "paste" | "delete" | "drop" | "insert"; before: string; after: string };

/** One continuous typing run in one field. */
export class TypingRecorder {
  private target: string;
  private surface: string;
  private start = 0;
  private last = 0;
  private chars = 0;
  private backspaces = 0;
  private pauses = 0;
  private sentencePauses = 0;
  private ikis: number[] = [];
  private text = "";
  private lastChar = "";
  /** last DOM value of the wired field, so a paste/delete can be diffed against it */
  lastValue = "";
  private revisions: DraftRevision[] = [];
  /** totals since the last takeStats() — attached to chat messages */
  private total = { chars: 0, ms: 0, pauses_2s: 0, backspaces: 0 };

  constructor(target: string, surface: string) {
    this.target = target;
    this.surface = surface;
  }

  /** Keep the recorder in sync with programmatic value changes (e.g. the composer is cleared on send). */
  sync(value: string) {
    this.lastValue = value;
  }

  /** Remember what a paste/delete did to the draft; the last few travel with the message. */
  recordRevision(kind: DraftRevision["kind"], before: string, after: string) {
    if (before === after) return;
    const b = before.slice(0, 2000);
    const a = after.slice(0, 2000);
    if (b === a) return;
    // a run of backspaces arrives as one input event per character; keep it as a single edit
    const last = this.revisions[this.revisions.length - 1];
    if (last && last.kind === kind && last.after === b) {
      last.after = a;
      return;
    }
    this.revisions.push({ kind, before: b, after: a });
    if (this.revisions.length > 8) this.revisions = this.revisions.slice(-8);
  }

  setTarget(target: string) {
    if (target !== this.target) {
      this.flush();
      this.target = target;
    }
  }

  typed(inserted: string, now = performance.now()) {
    if (!inserted) return;
    if (this.chars > 0 && now - this.last > SEGMENT_GAP_MS) this.flush();
    if (this.chars === 0 && this.backspaces === 0) {
      this.start = now;
    } else {
      const iki = now - this.last;
      this.ikis.push(iki);
      if (iki >= COGNITIVE_PAUSE_MS) {
        this.pauses++;
        if (!this.lastChar || /[.!?\n]\s*$/.test(this.lastChar) || this.lastChar === "\n") this.sentencePauses++;
      }
    }
    this.last = now;
    this.chars += inserted.length;
    if (this.text.length < 2000) this.text += inserted;
    this.lastChar = inserted.slice(-1);
  }

  deleted(count = 1, now = performance.now()) {
    if (this.chars === 0 && this.backspaces === 0) this.start = now;
    this.backspaces += count;
    this.last = now;
  }

  flush() {
    if (this.chars === 0) {
      this.reset();
      return;
    }
    const ms = Math.max(1, Math.round(this.last - this.start));
    const typingIkis = this.ikis.filter((x) => x < COGNITIVE_PAUSE_MS);
    const mean = typingIkis.reduce((a, b) => a + b, 0) / Math.max(1, typingIkis.length);
    const sd = Math.sqrt(typingIkis.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, typingIkis.length));
    const data = {
      chars: this.chars,
      ms,
      backspaces: this.backspaces,
      pauses_2s: this.pauses,
      sentence_pauses: this.sentencePauses,
      iki_median: Math.round(median(typingIkis)),
      iki_cv: mean > 0 ? Math.round((sd / mean) * 100) / 100 : 0,
      surface: this.surface,
      text: this.text.slice(0, 2000),
    };
    tracker.log("type_segment", this.target, data);
    this.total.chars += this.chars;
    this.total.ms += ms;
    this.total.pauses_2s += this.pauses;
    this.total.backspaces += this.backspaces;
    this.reset();
  }

  /** Flush and return typing stats accumulated since the previous call. */
  takeStats() {
    this.flush();
    const s = { ...this.total, revisions: this.revisions };
    this.total = { chars: 0, ms: 0, pauses_2s: 0, backspaces: 0 };
    this.revisions = [];
    return s;
  }

  private reset() {
    this.chars = 0;
    this.backspaces = 0;
    this.pauses = 0;
    this.sentencePauses = 0;
    this.ikis = [];
    this.text = "";
    this.lastChar = "";
  }
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Wire a <textarea>/<input> to a TypingRecorder via the native InputEvent stream.
 * inputType works for physical keyboards, mobile/IME composition and dictation alike
 * (keydown does not: Android keyboards report key "Unidentified").
 */
export function textareaHandlers(rec: TypingRecorder, target: string, surface: string) {
  return {
    onInput: (e: React.FormEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      const ie = e.nativeEvent as InputEvent;
      const kind = ie.inputType ?? "";
      const before = rec.lastValue;
      const after = e.currentTarget.value;
      if (kind.startsWith("delete")) {
        rec.recordRevision("delete", before, after);
        rec.deleted();
      } else if (kind === "insertFromPaste") {
        rec.recordRevision("paste", before, after); // logged by onPaste for the clipboard source
      } else if (kind === "insertFromDrop") {
        rec.recordRevision("drop", before, after);
      } else if (kind === "insertLineBreak" || kind === "insertParagraph") rec.typed("\n");
      else if (kind === "insertCompositionText") rec.typed((ie.data ?? "").slice(-1));
      else if (kind.startsWith("insert")) {
        const data = ie.data ?? "";
        // one keystroke inserts 1 char; a long single insert is autocorrect, dictation or injected text
        if (data.length > 3) {
          rec.recordRevision("insert", before, after);
          tracker.log("bulk_insert", target, {
            chars: data.length, text: data.slice(0, 2000), surface,
            via: kind === "insertReplacementText" ? "autocorrect" : "insert",
          });
        } else if (data) rec.typed(data);
      }
      rec.sync(after);
    },
    onPaste: (e: React.ClipboardEvent) => {
      const text = e.clipboardData.getData("text");
      if (text) tracker.logPaste(target, surface, text);
    },
    onDrop: (e: React.DragEvent) => {
      const text = e.dataTransfer.getData("text");
      if (text) tracker.log("bulk_insert", target, { chars: text.length, text: text.slice(0, 2000), via: "drop", surface });
    },
    onBlur: () => rec.flush(),
  };
}
