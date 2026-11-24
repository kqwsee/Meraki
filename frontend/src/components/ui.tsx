import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function Modal({ title, onClose, children, footer, wide, action, className }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
  /** Take up ~70% of the viewport (width and height) — for reading long content like notes. */
  wide?: boolean;
  /** Small link/button in the top-right corner of the title row (e.g. "Подробнее →"). */
  action?: ReactNode;
  /** Extra class on the dialog, for content that needs its own width (see .modal-graph-history). */
  className?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement);
  const titleId = useId();

  useEffect(() => {
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const panel = dialog.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [title]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className={`modal ${wide ? "wide" : ""} ${className ?? ""}`}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key !== "Tab") return;
          const panel = e.currentTarget;
          const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
            'a[href], button, input, textarea, select, summary, [tabindex]:not([tabindex="-1"])',
          )).filter((el) => !el.matches(":disabled") && el.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || (e.shiftKey && (document.activeElement === first || document.activeElement === panel))) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {action && <div className="modal-action">{action}</div>}
          <button className="btn sm ghost modal-close" type="button" aria-label="Закрыть окно" onClick={onClose}><Icon name="close" /></button>
        </div>
        {children}
        {footer && <div className="row mt" style={{ justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Loading({ text }: { text?: string }) {
  return (
    <div className="loading-block" role="status" aria-label={text ? undefined : "Загрузка"}>
      <span className="spinner" aria-hidden="true" />
      {text && <div>{text}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="alert error mb" role="alert">{error}</div>;
}

export function Progress({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(100, value));
  return (
    <div className="progress" role="progressbar" aria-label="Прогресс" aria-valuenow={Math.round(percent)}>
      <div style={{ width: `${percent}%` }} />
    </div>
  );
}

export const DOMAIN_ICONS: Record<string, IconName> = {
  it: "code",
  engineering: "settings",
  physics: "telescope",
  math: "triangle",
  biology: "dna",
  chemistry: "flask",
  humanities: "book",
  general: "graduation",
};

export const STAGE_NAMES: Record<string, string> = {
  prologue: "Пролог",
  lecture: "Лекция",
  practice: "Практика",
  exam: "Экзамен",
  done: "Пройдено",
};

export const MODE_LABELS: Record<string, { label: string; cls: string }> = {
  fast: { label: "ускоренно", cls: "success" },
  deep: { label: "углублённо", cls: "warning" },
  bridge: { label: "мостик", cls: "bridge" },
  side: { label: "побочный квест", cls: "side" },
};
