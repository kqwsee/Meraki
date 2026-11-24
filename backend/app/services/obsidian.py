"""Export a learner's notes as an Obsidian vault.

Obsidian "connections" are plain ``[[wiki links]]`` between files, so the vault mirrors what the
profile knowledge map draws: each note lives in «Заметки/» and links to its course («Курсы/») and
topic («Темы/»), and the hub files link back. That is what Obsidian's graph view and backlink pane
read, so the notes arrive already connected instead of as a pile of loose files.
"""

from __future__ import annotations

import io
import re
import zipfile
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Course, GraphNode, Note, User

NOTES_DIR = "Заметки"
COURSES_DIR = "Курсы"
TOPICS_DIR = "Темы"

# Characters Windows forbids in file names, plus the ones that break [[wiki-link]] syntax.
_ILLEGAL = re.compile(r'[\\/:*?"<>|#^\[\]]')


def _stem(title: str, fallback: str) -> str:
    """A file name Obsidian can link to: no characters a filesystem or a wiki link trips over."""
    stem = re.sub(r"\s+", " ", _ILLEGAL.sub("-", title)).strip(" .")
    return stem[:100].rstrip() or fallback


def _unique(base: str, used: set[str]) -> str:
    """Obsidian resolves links by file name, so two notes titled alike must get distinct files."""
    name, n = base, 2
    while name.casefold() in used:
        name = f"{base} ({n})"
        n += 1
    used.add(name.casefold())
    return name


def _link(directory: str, stem: str, title: str) -> str:
    """[[Заметки/Имя|Подпись]] — the path keeps the link unambiguous, the alias keeps the title."""
    alias = re.sub(r"[\[\]|]", "", title).strip()
    target = f"{directory}/{stem}"
    return f"[[{target}|{alias}]]" if alias and alias != stem else f"[[{target}]]"


def _yaml(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _frontmatter(fields: list[tuple[str, str]]) -> str:
    """Obsidian properties block; empty values are skipped so the panel stays clean."""
    lines = ["---"]
    for key, value in fields:
        if not value:
            continue
        # multi-line values (the tag list) are block sequences: "tags:" then an indented "- item"
        lines.append(f"{key}:{value}" if value.startswith("\n") else f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def _when(value: datetime | None) -> str:
    return value.isoformat(timespec="seconds") if value else ""


def _readme(user: User, notes: int, courses: int, topics: int) -> str:
    stamp = datetime.now(timezone.utc).strftime("%d.%m.%Y")
    return f"""# Meraki → Obsidian

Заметки пользователя {user.name}: {notes} заметок, {courses} курсов, {topics} тем.
Экспорт от {stamp}.

## Как открыть

1. Распакуйте архив в отдельную папку.
2. В Obsidian: «Open folder as vault» → выберите эту папку.
3. Связи между заметками, курсами и темами — обычные двойные квадратные скобки. Панель
   Backlinks и Graph view покажут ту же сеть, что и карта знаний в Meraki.

## Структура

- `Заметки/` — по файлу на заметку, со ссылками на курс и тему.
- `Курсы/` — курс как узел-хаб: его темы и заметки.
- `Темы/` — тема курса и заметки, которые к ней привязаны.
"""


def export_vault(db: Session, user: User) -> bytes:
    """Zip with «Заметки/», «Курсы/», «Темы/» and a README, ready to open as an Obsidian vault."""
    notes = list(db.scalars(select(Note).where(Note.user_id == user.id).order_by(Note.updated_at.desc(), Note.id)))
    node_ids = {n.node_id for n in notes if n.node_id is not None}
    nodes = {
        node.id: node for node in db.scalars(select(GraphNode).where(GraphNode.id.in_(node_ids)))
    } if node_ids else {}
    course_ids = {n.course_id for n in notes if n.course_id is not None}
    course_ids |= {node.course_id for node in nodes.values()}
    courses = {
        course.id: course for course in db.scalars(select(Course).where(Course.id.in_(course_ids)))
    } if course_ids else {}

    used_notes: set[str] = set()
    used_courses: set[str] = set()
    used_topics: set[str] = set()
    note_stems = {n.id: _unique(_stem(n.title, f"Заметка {n.id}"), used_notes) for n in notes}
    course_stems = {cid: _unique(_stem(c.title, f"Курс {cid}"), used_courses) for cid, c in courses.items()}
    topic_stems = {nid: _unique(_stem(t.title, f"Тема {nid}"), used_topics) for nid, t in nodes.items()}

    notes_by_course: dict[int, list[Note]] = {}
    notes_by_topic: dict[int, list[Note]] = {}
    files: dict[str, str] = {}

    for n in notes:
        links: list[str] = []
        note_courses: list[Course] = []
        if n.course_id is not None and (course := courses.get(n.course_id)):
            note_courses.append(course)
        topic = nodes.get(n.node_id) if n.node_id is not None else None
        if topic is not None and (topic_course := courses.get(topic.course_id)):
            if all(c.id != topic_course.id for c in note_courses):
                note_courses.append(topic_course)
        for c in note_courses:
            links.append(f"- Курс: {_link(COURSES_DIR, course_stems[c.id], c.title)}")
            notes_by_course.setdefault(c.id, []).append(n)
        if topic is not None:
            links.append(f"- Тема: {_link(TOPICS_DIR, topic_stems[topic.id], topic.title)}")
            notes_by_topic.setdefault(topic.id, []).append(n)

        fields = [
            ("id", str(n.id)),
            ("title", _yaml(n.title)),
            ("source", n.source),
            ("created", _when(n.created_at)),
            ("updated", _when(n.updated_at)),
        ]
        if n.course_id is not None and n.course_id in courses:
            fields.append(("course", _yaml(courses[n.course_id].title)))
        if topic is not None:
            fields.append(("topic", _yaml(topic.title)))
        fields.append(("tags", "\n  - meraki/note"))

        body = _frontmatter(fields) + f"# {n.title}\n\n"
        if n.content.strip():
            body += n.content.strip() + "\n"
        if links:
            body += "\n## Связи\n\n" + "\n".join(links) + "\n"
        files[f"{NOTES_DIR}/{note_stems[n.id]}.md"] = body

    for cid, c in courses.items():
        course_notes = notes_by_course.get(cid, [])
        course_topics = [t for t in nodes.values() if t.course_id == cid]
        body = _frontmatter([
            ("id", str(cid)),
            ("title", _yaml(c.title)),
            ("tags", "\n  - meraki/course"),
        ]) + f"# {c.title}\n\n"
        if c.description.strip():
            body += c.description.strip() + "\n\n"
        if course_topics:
            body += "## Темы\n\n" + "\n".join(
                f"- {_link(TOPICS_DIR, topic_stems[t.id], t.title)}" for t in course_topics
            ) + "\n\n"
        if course_notes:
            body += "## Заметки\n\n" + "\n".join(
                f"- {_link(NOTES_DIR, note_stems[n.id], n.title)}" for n in course_notes
            ) + "\n"
        files[f"{COURSES_DIR}/{course_stems[cid]}.md"] = body

    for nid, t in nodes.items():
        course = courses.get(t.course_id)
        body = _frontmatter([
            ("id", str(nid)),
            ("title", _yaml(t.title)),
            ("course", _yaml(course.title) if course else ""),
            ("tags", "\n  - meraki/topic"),
        ]) + f"# {t.title}\n\n"
        if t.summary.strip():
            body += t.summary.strip() + "\n\n"
        if course:
            body += f"Курс: {_link(COURSES_DIR, course_stems[course.id], course.title)}\n\n"
        topic_notes = notes_by_topic.get(nid, [])
        if topic_notes:
            body += "## Заметки\n\n" + "\n".join(
                f"- {_link(NOTES_DIR, note_stems[n.id], n.title)}" for n in topic_notes
            ) + "\n"
        files[f"{TOPICS_DIR}/{topic_stems[nid]}.md"] = body

    files["README.md"] = _readme(user, len(notes), len(courses), len(nodes))

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, text in files.items():
            zf.writestr(path, text)
    return buf.getvalue()
