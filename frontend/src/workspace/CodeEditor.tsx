import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { tracker, TypingRecorder } from "../telemetry/tracker";

function langFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "py": return [python()];
    case "js": case "mjs": case "ts": case "jsx": case "tsx": return [javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") })];
    case "sql": return [sql()];
    case "md": return [markdown()];
    case "json": return [json()];
    case "html": return [html()];
    case "css": return [css()];
    case "c": case "cpp": case "h": case "hpp": return [cpp()];
    case "java": return [java()];
    default: return [];
  }
}

/**
 * CodeMirror tags every transaction with a user event ("input.type", "input.paste", "input.drop",
 * "delete.backward", "input.complete"…) — exactly what the self-reliance analysis needs.
 */
export default function CodeEditor({ path, value, onChange, readOnly }: {
  path: string; value: string; onChange: (v: string) => void; readOnly?: boolean;
}) {
  const rec = useMemo(() => new TypingRecorder(`file:${path}`, "editor"), [path]);
  const extensions = useMemo(
    () => [
      ...langFor(path),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u: ViewUpdate) => {
        if (!u.docChanged) return;
        for (const tr of u.transactions) {
          if (!tr.docChanged) continue;
          let inserted = "";
          tr.changes.iterChanges((_fa, _ta, _fb, _tb, text) => {
            inserted += text.toString();
          });
          if (tr.isUserEvent("input.paste")) {
            tracker.logPaste(`file:${path}`, "editor", inserted);
          } else if (tr.isUserEvent("input.drop")) {
            tracker.log("bulk_insert", `file:${path}`, { chars: inserted.length, text: inserted.slice(0, 2000), via: "drop", surface: "editor" });
          } else if (tr.isUserEvent("delete")) {
            rec.deleted();
          } else if (tr.isUserEvent("input.complete")) {
            tracker.log("autocomplete", `file:${path}`, { chars: inserted.length });
          } else if (tr.isUserEvent("input.type") || tr.isUserEvent("input")) {
            // Enter + auto-indent and auto-closed brackets insert several characters at once
            const meaningful = inserted.replace(/\s+/g, "");
            if (meaningful.length > 3 && !tr.isUserEvent("input.type.compose")) {
              tracker.log("bulk_insert", `file:${path}`, { chars: inserted.length, text: inserted.slice(0, 2000), via: "other", surface: "editor" });
            } else {
              rec.typed(meaningful.length ? meaningful.slice(0, 1) : inserted.includes("\n") ? "\n" : " ");
            }
          }
        }
      }),
      EditorView.domEventHandlers({ blur: () => rec.flush() }),
    ],
    [path, rec],
  );

  return (
    <CodeMirror
      value={value}
      height="100%"
      style={{ height: "100%" }}
      extensions={extensions}
      onChange={onChange}
      readOnly={readOnly}
      theme="dark"
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }}
    />
  );
}
