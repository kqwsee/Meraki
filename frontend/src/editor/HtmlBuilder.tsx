import { lazy, Suspense } from "react";
import { HTML_TEMPLATE } from "./toolDraft";

const HtmlCodeEditor = lazy(() => import("./HtmlCodeEditor"));

export default function HtmlBuilder({ code, height, onCode, onHeight }: {
  code: string; height: number; onCode: (v: string) => void; onHeight: (v: number) => void;
}) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => { if (!code.trim() || confirm("Заменить текущий код шаблоном?")) onCode(HTML_TEMPLATE); }}>Вставить шаблон</button>
        <span className="spacer" />
        <label className="row small muted" style={{ gap: 8, flexWrap: "nowrap" }}>
          Высота
          <input type="number" min={160} max={900} step={20} value={height} style={{ width: 90 }}
            onChange={(e) => onHeight(Math.max(160, Math.min(900, Number(e.target.value) || 360)))} /> px
        </label>
      </div>
      <div className="code-box">
        <Suspense fallback={<div className="loading-block"><span className="spinner" /></div>}>
          <HtmlCodeEditor value={code} onChange={onCode} />
        </Suspense>
      </div>
      <details className="small">
        <summary className="muted" style={{ cursor: "pointer" }}>Как это работает и что можно</summary>
        <div className="col" style={{ gap: 6, marginTop: 8 }}>
          <div>Инструмент — один HTML-файл со своими стилями и скриптом. Он открывается в изолированной «песочнице»: у него нет доступа к сайту, аккаунту и сети.</div>
          <div><b>Нельзя:</b> сетевые запросы, <code>localStorage</code>, <code>alert/confirm/prompt</code>, отправка форм. Подключать библиотеки можно только с cdnjs.cloudflare.com, cdn.jsdelivr.net и unpkg.com.</div>
          <div><b>Платформа даёт три вещи:</b></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li><code>Meraki.state</code> — сохранённое состояние (объект, сначала пустой);</li>
            <li><code>Meraki.save(объект)</code> — сохранить состояние (до 16 КБ): оно вернётся при повторном открытии и на холсте;</li>
            <li><code>Meraki.describe("текст")</code> — одна строка о том, что сейчас в инструменте. Её видит ИИ-наставник при проверке заданий.</li>
          </ul>
          <div>Уже подключены тёмные стили: кнопки, поля ввода и текст выглядят как на сайте. Фон прозрачный.</div>
        </div>
      </details>
    </div>
  );
}
