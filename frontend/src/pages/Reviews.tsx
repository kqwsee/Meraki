import { Icon } from "../components/Icon";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import Markdown from "../components/Markdown";
import { Loading } from "../components/ui";
import { tracker, TypingRecorder, textareaHandlers } from "../telemetry/tracker";

type Card = { id: number; question: string; answer: string; box: number; node_title: string };

const GRADES = [
  { id: "again", label: "Не вспомнил(а)", cls: "danger" },
  { id: "hard", label: "С трудом", cls: "" },
  { id: "good", label: "Вспомнил(а)", cls: "primary" },
  { id: "easy", label: "Легко", cls: "success" },
];

export default function Reviews() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [i, setI] = useState(0);
  const [attempt, setAttempt] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(0);
  const rec = useMemo(() => new TypingRecorder("review", "answer"), []);
  const handlers = useMemo(() => textareaHandlers(rec, "review", "answer"), [rec]);

  useEffect(() => {
    api.get<{ cards: Card[] }>("/reviews").then((r) => setCards(r.cards));
    tracker.setContext({ nodeId: null, stage: "review" });
  }, []);

  if (!cards) return <Loading />;
  const card = cards[i];

  if (!card) {
    return (
      <div className="card center" style={{ maxWidth: 560, margin: "40px auto" }}>
        <span className="icon-frame mb"><Icon name="check" /></span>
        <h2>{done ? `Готово! Повторено карточек: ${done}` : "Сейчас повторять нечего"}</h2>
        <p className="muted">Карточки появляются после лекций и возвращаются через растущие интервалы: 1, 2, 4, 8, 16… дней.</p>
        <Link className="btn primary" to="/courses">К курсам</Link>
      </div>
    );
  }

  async function grade(g: string) {
    rec.flush();
    await api.post(`/reviews/${card.id}/grade`, { grade: g, answer: attempt });
    setDone((d) => d + 1);
    setAttempt("");
    setRevealed(false);
    setI((x) => x + 1);
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <div className="row mb">
        <h1 style={{ margin: 0 }}>Повторение</h1>
        <span className="spacer" />
        <span className="muted">{i + 1} / {cards.length}</span>
      </div>
      <div className="card flashcard">
        <div className="small muted">{card.node_title} · уровень {card.box + 1}</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}><Markdown>{card.question}</Markdown></div>
        {!revealed ? (
          <>
            <textarea rows={3} value={attempt} onChange={(e) => setAttempt(e.target.value)} placeholder="Сначала ответь по памяти — так знание закрепляется сильнее" {...handlers} />
            <button className="btn primary" onClick={() => setRevealed(true)}>Показать ответ</button>
          </>
        ) : (
          <>
            {attempt && <div className="small"><b>Твой ответ:</b> {attempt}</div>}
            <div className="alert"><Markdown>{card.answer}</Markdown></div>
            <div className="row" style={{ justifyContent: "center" }}>
              {GRADES.map((g) => <button key={g.id} className={`btn ${g.cls}`} onClick={() => grade(g.id)}>{g.label}</button>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
