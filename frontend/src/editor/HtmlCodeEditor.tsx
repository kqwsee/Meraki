import { html } from "@codemirror/lang-html";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";

const extensions = [html(), EditorView.lineWrapping];

/** Plain code editor for the author's page (no learner telemetry: this is the author's own work). */
export default function HtmlCodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <CodeMirror value={value} height="440px" extensions={extensions} onChange={onChange} theme="dark"
      basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: true }} />
  );
}
