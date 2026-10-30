"""Folder layout for the virtual workspace.

Every course gets its own tree; tasks are numbered like the course does it — topic.task:

    course_<id>_<slug>/
        topic_<node id>_<slug>/
            practice/
                1.1_<task slug>/
                    ...files
                1.2_<task slug>/
            exam/
                1.1_<task slug>/
                1.2_<task slug>/

Practice and exam are numbered separately. Exam task numbers continue across attempts
(1.4, 1.5... on a retake), so folders stay unique while still starting from 1.1.
The learner's workspace shows the whole stage, but only that stage: practice files are
never visible during an exam.
"""

import re
import unicodedata

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Course, GraphNode, Task, WorkspaceFile


def slug(text: str, limit: int = 48) -> str:
    value = unicodedata.normalize("NFKC", text or "").lower()
    value = re.sub(r"[^\w]+", "-", value, flags=re.UNICODE).strip("-_")
    return value[:limit].strip("-_") or "untitled"


def course_folder(course: Course) -> str:
    return f"course_{course.id}_{slug(course.title)}"


def topic_folder(course: Course, node: GraphNode) -> str:
    return f"{course_folder(course)}/topic_{node.id}_{slug(node.title)}"


def stage_folder(course: Course, node: GraphNode, stage: str) -> str:
    return f"{topic_folder(course, node)}/{stage}"


def topic_number(node: GraphNode) -> int:
    """The topic's place in the author's course, 1-based (the same numbers the course page shows)."""
    return max(1, int(node.order_index or 0) + 1)


def task_folder(course: Course, node: GraphNode, stage: str, number: str | int, title: str) -> str:
    return f"{stage_folder(course, node, stage)}/{number}_{slug(title)}"


def _unique_path(db: Session, user_id: int, course_id: int, folder: str, name: str, old_path: str) -> str:
    """A free path inside `folder`; the old row itself does not count as a clash."""
    taken = set(
        db.scalars(select(WorkspaceFile.path).where(WorkspaceFile.user_id == user_id, WorkspaceFile.course_id == course_id)).all()
    )
    path = f"{folder}/{name}"
    stem, dot, ext = name.rpartition(".")
    stem, ext = (stem, f".{ext}") if dot else (name, "")
    n = 2
    while path in taken and path != old_path:
        path = f"{folder}/{stem}_{n}{ext}"
        n += 1
    return path


def _move_subtree(db: Session, task: Task, course_id: int, old_folder: str, new_folder: str) -> None:
    """Move every file of one task folder and rewrite the task's starter paths."""
    rows = db.scalars(
        select(WorkspaceFile).where(
            WorkspaceFile.user_id == task.user_id,
            WorkspaceFile.course_id == course_id,
            WorkspaceFile.path.startswith(old_folder + "/"),
        )
    ).all()
    moved: dict[str, str] = {}
    for row in rows:
        relative = row.path[len(old_folder) + 1 :]
        new_path = _unique_path(db, task.user_id, course_id, new_folder, relative, row.path)
        moved[row.path] = new_path
        row.path = new_path

    files: list[dict] = []
    for entry in task.starter_files or []:
        if not isinstance(entry, dict):
            continue
        old_path = str(entry.get("path", ""))
        new_path = moved.get(old_path)
        if new_path is None and old_path.startswith(old_folder + "/"):
            new_path = new_folder + old_path[len(old_folder) :]
        files.append({**entry, "path": new_path} if new_path else entry)
    task.starter_files = files


def _move_legacy_starter_files(db: Session, task: Task, course_id: int, target: str) -> None:
    """Old shared folders (practice/, exam_5/): move only the task's own starter files."""
    files: list[dict] = []
    for entry in task.starter_files or []:
        if not isinstance(entry, dict):
            continue
        old_path = str(entry.get("path", "")).strip().replace("\\", "/")
        if not old_path:
            continue
        if old_path.startswith(target + "/"):
            files.append(entry)
            continue
        name = old_path.rsplit("/", 1)[-1]
        new_path = _unique_path(db, task.user_id, course_id, target, name, old_path)
        row = db.scalar(
            select(WorkspaceFile).where(
                WorkspaceFile.user_id == task.user_id,
                WorkspaceFile.course_id == course_id,
                WorkspaceFile.path == old_path,
            )
        )
        if row is not None:
            row.path = new_path
        files.append({**entry, "path": new_path})
    task.starter_files = files


def _ensure_folder(db: Session, task: Task, course_id: int, target: str) -> None:
    """A task without files still gets its own visible folder."""
    has_file = db.scalar(
        select(WorkspaceFile.id)
        .where(
            WorkspaceFile.user_id == task.user_id,
            WorkspaceFile.course_id == course_id,
            WorkspaceFile.path.startswith(target + "/"),
        )
        .limit(1)
    )
    if has_file is None:
        db.add(WorkspaceFile(user_id=task.user_id, course_id=course_id, path=f"{target}/.keep", content=""))


def migrate_workspace_layout() -> None:
    """Renumber task folders to topic.task and move existing files into them.

    Idempotent: a folder that already has the right name is left alone. Learner-created
    files that are not a task's starter file are moved when exactly one task's answer
    mentions their old path.
    """
    from ..db import SessionLocal

    with SessionLocal() as db:
        groups: dict[tuple[int, int, str], list[Task]] = {}
        for task in db.scalars(select(Task).order_by(Task.id)).all():
            groups.setdefault((task.user_id, task.node_id, task.stage), []).append(task)

        task_refs: dict[tuple[int, int], list[Task]] = {}
        for (_user_id, node_id, stage_name), tasks in groups.items():
            node = db.get(GraphNode, node_id)
            if node is None:
                continue
            course = db.get(Course, node.course_id)
            if course is None:
                continue
            prefix = topic_number(node)
            stage_root = stage_folder(course, node, stage_name)
            for index, task in enumerate(tasks, start=1):
                target = task_folder(course, node, stage_name, f"{prefix}.{index}", task.title)
                old = task.workspace_folder or ""
                if old != target:
                    if old.startswith(stage_root + "/"):
                        _move_subtree(db, task, node.course_id, old, target)
                    else:
                        _move_legacy_starter_files(db, task, node.course_id, target)
                    task.workspace_folder = target
                _ensure_folder(db, task, node.course_id, target)
                task_refs.setdefault((task.user_id, node.course_id), []).append(task)

        # Learner-created files from the old shared folders: if exactly one task answer
        # mentions the path, put the file into that task's folder.
        for row in db.scalars(select(WorkspaceFile)).all():
            peers = task_refs.get((row.user_id, row.course_id), [])
            if not peers:
                continue
            if any(t.workspace_folder and row.path.startswith(t.workspace_folder + "/") for t in peers):
                continue
            owners = [t for t in peers if t.workspace_folder and row.path in (t.answer or "")]
            if len(owners) != 1:
                continue
            target = owners[0].workspace_folder
            name = row.path.rsplit("/", 1)[-1]
            row.path = _unique_path(db, row.user_id, row.course_id, target, name, row.path)
        db.commit()
