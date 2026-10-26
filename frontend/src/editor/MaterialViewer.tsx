import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Highlight = { start: number; end: number; cls: string; id?: number };
export type TextSelection = { start: number; end: number; text: string; rect: DOMRect; below: DOMRect };

type Block = { start: number; end: number };

const FIRST_BATCH = 120; // blocks rendered up front; the rest follows as the author scrolls
const BATCH = 120;

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let pos = 0;
  for (const m of text.matchAll(/\n{2,}/g)) {
    blocks.push({ start: pos, end: m.index! });
    pos = m.index! + m[0].length;
  }
  blocks.push({ start: pos, end: text.length });
  return blocks.filter((b) => b.end > b.start);
}

/** One paragraph, cut into runs at every highlight boundary. Each run carries its absolute offset in the text. */
const BlockView = memo(function BlockView({ text, block, hls }: { text: string; block: Block; hls: Highlight[] }) {
  const cuts = new Set([block.start, block.end]);
  for (const h of hls) {
    cuts.add(Math.max(block.start, Math.min(block.end, h.start)));
    cuts.add(Math.max(block.start, Math.min(block.end, h.end)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const runs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    const cover = hls.filter((h) => h.start <= s && h.end >= e);
    const piece = text.slice(s, e);
    runs.push(
      cover.length ? (
        <mark key={s} data-s={s} data-hl={cover.find((h) => h.id != null)?.id} className={cover.map((h) => h.cls).join(" ")}>{piece}</mark>
      ) : (
        <span key={s} data-s={s}>{piece}</span>
      ),
    );
  }
  return <div className="vw-block" data-b={block.start}>{runs}</div>;
});

/** Character range of the current browser selection inside `root`, in offsets of the material text. */
function readSelection(root: HTMLElement, text: string): TextSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  let start = -1, end = -1;
  root.querySelectorAll<HTMLElement>("[data-s]").forEach((el) => {
    if (!range.intersectsNode(el)) return;
    const base = Number(el.dataset.s);
    let s = base, e = base + (el.textContent?.length ?? 0);
    if (range.startContainer.nodeType === Node.TEXT_NODE && el.contains(range.startContainer)) s = base + range.startOffset;
    if (range.endContainer.nodeType === Node.TEXT_NODE && el.contains(range.endContainer)) e = base + range.endOffset;
    if (start < 0) start = s;
    end = Math.max(end, e);
  });
  if (start < 0) return null;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  const rects = range.getClientRects();
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? first;
  return { start, end, text: text.slice(start, end), rect: first, below: last };
}

export default function MaterialViewer({ text, highlights, scrollTo, onHighlightClick, toolbar }: {
  text: string;
  highlights: Highlight[];
  /** Brings the passage that contains `offset` into view; a new `nonce` repeats the jump. */
  scrollTo?: { offset: number; nonce: number } | null;
  onHighlightClick?: (id: number) => void;
  toolbar: (sel: TextSelection, hide: () => void) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  const [shown, setShown] = useState(FIRST_BATCH);
  const [sel, setSel] = useState<TextSelection | null>(null);

  const blocks = useMemo(() => splitBlocks(text), [text]);
  const perBlock = useMemo(
    () => blocks.map((b) => highlights.filter((h) => h.start < b.end && h.end > b.start)),
    [blocks, highlights],
  );

  useEffect(() => {
    setShown(FIRST_BATCH);
    setSel(null);
    if (root.current) root.current.scrollTop = 0;
  }, [text]);

  const update = useCallback(() => {
    if (pressed.current || !root.current) return;
    setSel(readSelection(root.current, text));
  }, [text]);

  useEffect(() => {
    const down = () => { pressed.current = true; };
    const up = () => { pressed.current = false; setTimeout(update, 0); };
    document.addEventListener("selectionchange", update);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    root.current?.addEventListener("mousedown", down);
    const el = root.current;
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
      el?.removeEventListener("mousedown", down);
    };
  }, [update]);

  useEffect(() => {
    if (!scrollTo) return;
    const idx = blocks.findIndex((b) => scrollTo.offset < b.end + 2);
    if (idx < 0) return;
    setShown((n) => Math.max(n, idx + 20));
    const t = setTimeout(() => {
      const el = root.current?.querySelector<HTMLElement>(`[data-b="${blocks[idx].start}"]`);
      if (el && root.current) root.current.scrollTop = el.offsetTop - root.current.clientHeight / 3;
    }, 30);
    return () => clearTimeout(t);
  }, [scrollTo, blocks]);

  const hide = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSel(null);
  }, []);

  // the toolbar follows the selection while the text scrolls and disappears when the selection leaves the viewport of the text
  const visible = sel && root.current ? (() => {
    const box = root.current.getBoundingClientRect();
    return sel.rect.bottom > box.top && sel.below.top < box.bottom;
  })() : false;

  return (
    <div className="vw-wrap">
      <div
        className="vw" ref={root}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 900) setShown((n) => (n < blocks.length ? n + BATCH : n));
          update();
        }}
        onClick={(e) => {
          const mark = (e.target as HTMLElement).closest<HTMLElement>("[data-hl]");
          if (mark && window.getSelection()?.isCollapsed) onHighlightClick?.(Number(mark.dataset.hl));
        }}
      >
        {blocks.slice(0, shown).map((b, i) => <BlockView key={b.start} text={text} block={b} hls={perBlock[i]} />)}
        {shown < blocks.length && (
          <button className="btn sm" style={{ margin: "12px auto", display: "flex" }} onClick={() => setShown((n) => n + BATCH * 3)}>
            Показать дальше
          </button>
        )}
      </div>
      {sel && visible && toolbar(sel, hide)}
    </div>
  );
}
