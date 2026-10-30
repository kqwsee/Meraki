from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


STAGES = ("prologue", "lecture", "practice", "exam")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="student")  # student | author
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    # Profile, rebuilt by the AI after each finished node
    talents: Mapped[str] = mapped_column(Text, default="")
    mind_profile: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {"engineering": 0.7, ...}
    strengths: Mapped[list[str]] = mapped_column(JSON, default=list)
    growth_areas: Mapped[list[str]] = mapped_column(JSON, default=list)
    # AI-assigned course for memory facts, keyed by "predicate:object" -> course_id (knowledge-map clustering)
    fact_clusters: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    typing_baseline: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {"cpm": 180, "samples": 12}
    writing_profile: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # keystroke process features, see integrity.py
    consent_telemetry: Mapped[bool] = mapped_column(Boolean, default=False)
    profile_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    domain: Mapped[str] = mapped_column(String(40), default="general")
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | processing | ready | error
    status_detail: Mapped[str] = mapped_column(Text, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    tools: Mapped[list[str]] = mapped_column(JSON, default=list)
    # What the AI may change in learners' personal routes: {"reorder": bool, "modes": bool, "bridges": bool}
    route_settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    published: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    author: Mapped[User] = relationship()
    materials: Mapped[list["CourseMaterial"]] = relationship(back_populates="course", cascade="all, delete-orphan")
    nodes: Mapped[list["GraphNode"]] = relationship(back_populates="course", cascade="all, delete-orphan")
    edges: Mapped[list["GraphEdge"]] = relationship(cascade="all, delete-orphan")


class CourseMaterial(Base):
    __tablename__ = "course_materials"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(20), default="textbook")  # textbook | tasks | other
    chars: Mapped[int] = mapped_column(Integer, default=0)
    text: Mapped[str] = mapped_column(Text, default="")  # full extracted text, what the author sees when pinning passages
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    course: Mapped[Course] = relationship(back_populates="materials")


class MaterialChunk(Base):
    __tablename__ = "material_chunks"

    id: Mapped[int] = mapped_column(primary_key=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("course_materials.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    position: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)


class PinnedExcerpt(Base):
    """A passage of the course materials the author marked as mandatory for one topic:
    a `topic` the AI must teach on the lecture, or a `task` it must give nearly as written."""

    __tablename__ = "pinned_excerpts"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    # NULL = not attached to a topic (its topic was deleted or the graph was rebuilt); the AI ignores it until re-attached
    node_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True, index=True)
    material_id: Mapped[int | None] = mapped_column(ForeignKey("course_materials.id", ondelete="SET NULL"), nullable=True)
    source: Mapped[str] = mapped_column(String(255), default="")  # material filename at the time of pinning
    kind: Mapped[str] = mapped_column(String(10), default="topic")  # topic | task
    use_in: Mapped[str] = mapped_column(String(10), default="")  # tasks only: practice | exam
    title: Mapped[str] = mapped_column(String(200), default="")
    content: Mapped[str] = mapped_column(Text, default="")  # snapshot of the passage, editable by the author
    char_start: Mapped[int | None] = mapped_column(Integer, nullable=True)  # offsets in CourseMaterial.text, for highlighting
    char_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CustomTool(Base):
    """A practice tool the course author made: a no-code formula calculator or an HTML/JS page
    (written by hand or generated by the AI from a description)."""

    __tablename__ = "custom_tools"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    icon: Mapped[str] = mapped_column(String(16), default="🧩")
    description: Mapped[str] = mapped_column(Text, default="")  # shown to learners and to the AI tutor
    kind: Mapped[str] = mapped_column(String(10), default="formula")  # formula | html
    origin: Mapped[str] = mapped_column(String(10), default="manual")  # manual | ai
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # formula: inputs/outputs/notes; html: height
    code: Mapped[str] = mapped_column(Text, default="")  # html tools: the whole page
    prompt: Mapped[str] = mapped_column(Text, default="")  # the author's description an AI tool was made from
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class CourseAsset(Base):
    """A picture of the course: uploaded by the author, taken out of an uploaded PDF/DOCX, or imported from an open
    library (a picture from a Russian or English Wikipedia article). The file lives under data/assets and is served by its unguessable key."""

    __tablename__ = "course_assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    filename: Mapped[str] = mapped_column(String(255), default="")
    mime: Mapped[str] = mapped_column(String(40), default="image/png")
    size: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    source: Mapped[str] = mapped_column(String(10), default="upload")  # upload | material | web
    material_id: Mapped[int | None] = mapped_column(ForeignKey("course_materials.id", ondelete="SET NULL"), nullable=True)
    page: Mapped[int | None] = mapped_column(Integer, nullable=True)  # PDF page the picture was found on
    title: Mapped[str] = mapped_column(String(300), default="")  # web: the title in the library
    license: Mapped[str] = mapped_column(String(120), default="")  # web: e.g. "CC BY-SA 4.0"
    author: Mapped[str] = mapped_column(String(300), default="")  # web: who to credit
    source_url: Mapped[str] = mapped_column(String(1000), default="")  # web: the page of the picture in the library
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TopicVisual(Base):
    """Visual material for the lecture of one topic: a diagram, chart, scheme, interactive page or tool preset the AI
    drafted in the course editor, or the author's own picture. Learners only ever see the approved ones."""

    __tablename__ = "topic_visuals"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    # NULL = not attached to a topic (the graph was rebuilt); the lecture ignores it until re-attached
    node_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(10))  # mermaid | svg | chart | scheme | html | tool | image
    title: Mapped[str] = mapped_column(String(200), default="")  # caption under the visual, learners see it
    description: Mapped[str] = mapped_column(Text, default="")  # for the tutor: what it shows and when to show it
    code: Mapped[str] = mapped_column(Text, default="")  # mermaid / svg / html source
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # chart / scheme / tool spec; html: {"height"}
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("course_assets.id", ondelete="SET NULL"), nullable=True)  # image
    status: Mapped[str] = mapped_column(String(10), default="draft")  # draft | approved
    origin: Mapped[str] = mapped_column(String(10), default="ai")  # ai | author
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class GraphNode(Base):
    __tablename__ = "graph_nodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    # NULL = node of the author's graph; set = personal "bridge" node the AI added for one learner
    owner_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    key: Mapped[str] = mapped_column(String(80))
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(Text, default="")
    objectives: Mapped[list[str]] = mapped_column(JSON, default=list)
    concepts: Mapped[list[str]] = mapped_column(JSON, default=list)
    order_index: Mapped[int] = mapped_column(Integer, default=0)  # author's study order
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)  # keeps its author position in every route
    # topic = a regular topic (a personal bridge when owner_user_id is set) | side = personal side quest:
    # a dead-end branch that unlocks nothing and counts neither in progress nor in the leaderboard
    kind: Mapped[str] = mapped_column(String(10), default="topic")
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True)  # side quest: the topic it branches off
    cover_asset_id: Mapped[int | None] = mapped_column(ForeignKey("course_assets.id", ondelete="SET NULL"), nullable=True)  # the topic's thumbnail
    image_queries: Mapped[list[str]] = mapped_column(JSON, default=list)  # open-library searches the AI suggested for this topic

    course: Mapped[Course] = relationship(back_populates="nodes")


class GraphEdge(Base):
    __tablename__ = "graph_edges"

    id: Mapped[int] = mapped_column(primary_key=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    src_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"))  # prerequisite
    dst_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"))  # depends on src


class Enrollment(Base):
    __tablename__ = "enrollments"
    __table_args__ = (UniqueConstraint("user_id", "course_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    course: Mapped[Course] = relationship()


class NodeProgress(Base):
    __tablename__ = "node_progress"
    __table_args__ = (UniqueConstraint("user_id", "node_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(20), default="prologue")
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    assessment: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # from prologue
    memory_context: Mapped[str] = mapped_column(Text, default="")  # MemPalace recall, refreshed at stage starts
    lecture_summary: Mapped[str] = mapped_column(Text, default="")
    exit_ticket: Mapped[str] = mapped_column(Text, default="")  # learner's free-recall summary after the lecture
    exit_ticket_feedback: Mapped[str] = mapped_column(Text, default="")
    practice_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    exam_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(20))
    role: Mapped[str] = mapped_column(String(20))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # typing stats for user messages
    memory_filed: Mapped[bool] = mapped_column(Boolean, default=False)  # verbatim copy already filed into MemPalace
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(20))  # practice | exam
    attempt_id: Mapped[int | None] = mapped_column(ForeignKey("exam_attempts.id", ondelete="CASCADE"), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    statement: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(20), default="text")  # code | text | canvas | calc
    language: Mapped[str] = mapped_column(String(30), default="")
    concept: Mapped[str] = mapped_column(String(200), default="")
    excerpt_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)  # set = the author's pinned task, given nearly as written
    bloom: Mapped[str] = mapped_column(String(20), default="")  # Bloom's taxonomy level
    scaffold: Mapped[str] = mapped_column(String(20), default="")  # worked | predict | modify | make | transfer | interleaved
    confidence: Mapped[int | None] = mapped_column(Integer, nullable=True)  # learner's 1..5 self-rating at submission
    starter_files: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    rubric: Mapped[str] = mapped_column(Text, default="")
    solution: Mapped[str] = mapped_column(Text, default="")  # reference solution, never shown to the learner
    hints: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | graded
    answer: Mapped[str] = mapped_column(Text, default="")
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    feedback: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ExamAttempt(Base):
    __tablename__ = "exam_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="in_progress")  # in_progress | verifying | finished
    time_limit_min: Mapped[int] = mapped_column(Integer, default=30)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    raw_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    verification: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    understanding: Mapped[float | None] = mapped_column(Float, nullable=True)
    weak_concepts: Mapped[list[str]] = mapped_column(JSON, default=list)
    summary: Mapped[str] = mapped_column(Text, default="")


class WorkspaceFile(Base):
    __tablename__ = "workspace_files"
    __table_args__ = (UniqueConstraint("user_id", "course_id", "path"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(500))
    content: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Canvas(Base):
    __tablename__ = "canvases"
    __table_args__ = (UniqueConstraint("user_id", "node_id", "stage"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"))
    stage: Mapped[str] = mapped_column(String(20))
    scene: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class LearningSession(Base):
    __tablename__ = "learning_sessions"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_activity: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    summarized: Mapped[bool] = mapped_column(Boolean, default=False)


class Event(Base):
    """Raw telemetry: every action in the chat, workspace, canvas and tools."""

    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[str] = mapped_column(String(40), index=True, default="")
    node_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    stage: Mapped[str] = mapped_column(String(20), default="")
    task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    type: Mapped[str] = mapped_column(String(40))
    target: Mapped[str] = mapped_column(String(300), default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class IntegrityFlag(Base):
    __tablename__ = "integrity_flags"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    stage: Mapped[str] = mapped_column(String(20))
    task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attempt_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    kind: Mapped[str] = mapped_column(String(30))  # paste | burst | bulk_insert | tab_away
    severity: Mapped[float] = mapped_column(Float, default=0.5)
    target: Mapped[str] = mapped_column(String(300), default="")
    fragment: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int | None] = mapped_column(ForeignKey("courses.id", ondelete="SET NULL"), nullable=True)
    node_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(20), default="user")  # user | assistant
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class MemoryEntry(Base):
    """Local mirror of what was filed into MemPalace (also the fallback store)."""

    __tablename__ = "memory_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    wing: Mapped[str] = mapped_column(String(100))
    room: Mapped[str] = mapped_column(String(100))
    content: Mapped[str] = mapped_column(Text)
    drawer_id: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ReviewCard(Base):
    """Spaced-repetition flashcard (Leitner boxes) generated from a lecture."""

    __tablename__ = "review_cards"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("graph_nodes.id", ondelete="CASCADE"), index=True)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    box: Mapped[int] = mapped_column(Integer, default=0)
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Adventure(Base):
    """Something that happens on a learner's map besides the author's topics: an offered side quest or a random
    encounter (an old topic coming back for a mini-challenge, or a bridge clarifying a link).
    Never counted in progress or the leaderboard."""

    __tablename__ = "adventures"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(10))  # side | recall | bridge
    status: Mapped[str] = mapped_column(String(10), default="offered")  # offered | active | done | dismissed | expired
    # where the marker hangs on the map: the parent topic (side), the old topic (recall) or the upcoming topic (bridge)
    anchor_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True)
    topic_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True)  # the passed topic it is about
    node_id: Mapped[int | None] = mapped_column(ForeignKey("graph_nodes.id", ondelete="SET NULL"), nullable=True)  # side: the personal node made on accept
    title: Mapped[str] = mapped_column(String(200), default="")
    teaser: Mapped[str] = mapped_column(Text, default="")  # the hook shown on the map
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # side: the quest draft; recall/bridge: generated content
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # recall/bridge: score and feedback
    after_passed: Mapped[int] = mapped_column(Integer, default=0)  # topics passed when it appeared: paces the next one
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class LearnerPath(Base):
    """Personal route through a course graph, re-planned by the AI after every finished node.
    Hard prerequisites (author edges) always hold; the AI only reorders, sets per-node modes and may add bridge nodes."""

    __tablename__ = "learner_paths"
    __table_args__ = (UniqueConstraint("user_id", "course_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    course_id: Mapped[int] = mapped_column(ForeignKey("courses.id", ondelete="CASCADE"), index=True)
    order: Mapped[list[int]] = mapped_column(JSON, default=list)  # node ids, recommended order
    modes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # {node_id: {"mode": "fast|standard|deep", "reason": ...}}
    message: Mapped[str] = mapped_column(Text, default="")  # explanation shown to the learner
    replans: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
