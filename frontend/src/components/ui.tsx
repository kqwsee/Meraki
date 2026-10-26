import type { ReactNode } from "react";

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
        {footer && <div className="row mt" style={{ justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Loading({ text }: { text?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner" />
      {text && <div>{text}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert error mb">{error}</div>;
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" aria-label={`${Math.round(value)}%`}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const DOMAIN_ICONS: Record<string, string> = {
  it: "💻",
  engineering: "⚙️",
  physics: "🔭",
  math: "📐",
  biology: "🧬",
  chemistry: "⚗️",
  humanities: "📚",
  general: "🎓",
};

export const STAGE_NAMES: Record<string, string> = {
  prologue: "Пролог",
  lecture: "Лекция",
  practice: "Практика",
  exam: "Экзамен",
  done: "Пройдено",
};

export const MODE_LABELS: Record<string, { label: string; cls: string }> = {
  fast: { label: "⚡ ускоренно", cls: "success" },
  deep: { label: "🔍 углублённо", cls: "warning" },
  bridge: { label: "🌉 мостик", cls: "bridge" },
  side: { label: "✨ побочный квест", cls: "side" },
};
