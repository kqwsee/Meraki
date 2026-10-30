import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { splitMarkers, VisualRef } from "../visuals/context";

function Md({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
      {text}
    </ReactMarkdown>
  );
}

/** Markdown with formulas; `[[visual:N]]` markers of the lecture become the visuals themselves. */
export default function Markdown({ children }: { children: string }) {
  const parts = children.includes("[[") || children.endsWith("[") ? splitMarkers(children) : null;
  return (
    <div className="md">
      {parts
        ? parts.map((p, i) => ("visual" in p ? <VisualRef key={i} id={p.visual} /> : <Md key={i} text={p.md} />))
        : <Md text={children} />}
    </div>
  );
}
