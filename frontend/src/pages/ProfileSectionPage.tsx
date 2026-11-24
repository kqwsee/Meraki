import { Icon } from "../components/Icon";
import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, Loading } from "../components/ui";
import type { ProfileT } from "../profile/knowledgeGraph";
import ProfileSectionBody, { PROFILE_SECTIONS, type ProfileSection } from "../profile/ProfileSectionBody";
import type { TalentOverviewT, WritingEvidenceT } from "../profile/talents";
import WritingEvidence from "../profile/WritingEvidence";

/** Full-page view of one profile section, opened by the "Подробнее →" action of a section modal. */
export default function ProfileSectionPage() {
  const { section = "" } = useParams();
  const meta = PROFILE_SECTIONS.find((s) => s.id === section);
  const [p, setP] = useState<ProfileT | null>(null);
  const [talentOverview, setTalentOverview] = useState<TalentOverviewT | null>(null);
  const [writing, setWriting] = useState<WritingEvidenceT | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, overview, writingData] = await Promise.all([
        api.get<ProfileT>("/profile"),
        api.get<TalentOverviewT>("/profile/talents").catch(() => null),
        section === "writing" ? api.get<WritingEvidenceT>("/profile/writing").catch(() => null) : Promise.resolve(null),
      ]);
      setP(profile);
      setTalentOverview(overview);
      setWriting(writingData);
      setLoadedAt(new Date());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [section]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!meta) return <Navigate to="/profile" replace />;
  // the talent section has its own evidence pages
  if (section === "talents") return <Navigate to="/profile/talents" replace />;
  if (!p) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div>
      <div className="talent-page-head mb">
        <div style={{ flex: 1, minWidth: 260 }}>
          <Link className="small muted" to="/profile">← Профиль</Link>
          <h1 className="icon-label" style={{ margin: "4px 0 6px" }}><Icon name={meta.icon} /> {meta.title}</h1>
          <p className="muted" style={{ margin: 0 }}>Раздел профиля целиком: показатели и моменты, которые на них повлияли.</p>
        </div>
        {section === "writing" && (
          <>
            <span className="live-pill">
              <span className="live-dot" /> в реальном времени
              {loadedAt ? ` · ${loadedAt.toLocaleTimeString("ru-RU")}` : ""}
            </span>
            <button className="btn" onClick={() => load()}><Icon name="refresh" /> Обновить</button>
          </>
        )}
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <ProfileSectionBody p={p} section={meta.id as ProfileSection} talentOverview={talentOverview} />
      </div>
      {section === "writing" && writing && <WritingEvidence data={writing} />}
    </div>
  );
}
