/** Mermaid diagrams in the app's dark palette. Mermaid itself (large) loads on first use only. */
import { useEffect, useState } from "react";

type MermaidApi = typeof import("mermaid").default;
let loader: Promise<MermaidApi> | null = null;
let seq = 0;

function getMermaid(): Promise<MermaidApi> {
  loader ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict", // no HTML labels, no click handlers: the source comes from the AI
      theme: "base",
      darkMode: true,
      fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
      themeVariables: {
        background: "#1a1917", fontSize: "15px",
        primaryColor: "#1d2a28", primaryTextColor: "#e2e5e9", primaryBorderColor: "#6bada5",
        secondaryColor: "#23262c", secondaryTextColor: "#e2e5e9", secondaryBorderColor: "#8fa6c6",
        tertiaryColor: "#262521", tertiaryTextColor: "#e2e5e9", tertiaryBorderColor: "#a79bd0",
        lineColor: "#8fa6c6", textColor: "#e2e5e9", edgeLabelBackground: "#1a1917",
        clusterBkg: "#1f1e1b", clusterBorder: "#3a3935", noteBkgColor: "#262521", noteTextColor: "#e2e5e9", noteBorderColor: "#cfb47c",
        actorBkg: "#1d2a28", actorBorder: "#6bada5", actorTextColor: "#e2e5e9", signalColor: "#c9ccd1", signalTextColor: "#e2e5e9",
        labelBoxBkgColor: "#1d2a28", labelBoxBorderColor: "#6bada5", labelTextColor: "#e2e5e9", loopTextColor: "#e2e5e9",
      },
    });
    return m;
  });
  return loader;
}

export default function MermaidView({ code, onError }: { code: string; onError?: (message: string) => void }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const id = `mmd-${++seq}`;
    setError(null);
    getMermaid()
      .then(async (m) => {
        await m.parse(code);
        const out = await m.render(id, code);
        if (live) setSvg(out.svg);
      })
      .catch((e: unknown) => {
        document.getElementById(`d${id}`)?.remove(); // mermaid leaves its scratch element behind on errors
        const message = String((e as { message?: string })?.message ?? e).split("\n").slice(0, 4).join(" ");
        if (live) {
          setSvg(null);
          setError(message);
          onError?.(`Mermaid: ${message}`);
        }
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (error) return <div className="alert error small">Схема не отображается: {error}</div>;
  if (!svg) return <div className="vis-loading"><span className="spinner" /></div>;
  return <div className="vis-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
