"""Tests for the per-course/topic/stage/task workspace layout."""

import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import db as db_module
from app.db import Base
from app.models import Course, ExamAttempt, GraphNode, Task, User, WorkspaceFile
from app.services import learning, workspace_layout


class SlugTest(unittest.TestCase):
    def test_slug_keeps_cyrillic_and_replaces_separators(self):
        self.assertEqual(workspace_layout.slug("Python: функции и рекурсия"), "python-функции-и-рекурсия")
        self.assertEqual(workspace_layout.slug("  A / B  "), "a-b")
        self.assertEqual(workspace_layout.slug("!!!"), "untitled")
        self.assertLessEqual(len(workspace_layout.slug("x" * 200)), 48)

    def test_folder_hierarchy(self):
        course = Course(id=7, author_id=1, title="Python: функции")
        node = GraphNode(id=3, course_id=7, key="params", title="Параметры и return")
        self.assertEqual(workspace_layout.course_folder(course), "course_7_python-функции")
        self.assertEqual(workspace_layout.topic_folder(course, node), "course_7_python-функции/topic_3_параметры-и-return")
        self.assertEqual(
            workspace_layout.task_folder(course, node, "practice", "1.1", "Доработай расчёт"),
            "course_7_python-функции/topic_3_параметры-и-return/practice/1.1_доработай-расчёт",
        )
        self.assertEqual(
            workspace_layout.task_folder(course, node, "exam", "2.3", "Экзамен"),
            "course_7_python-функции/topic_3_параметры-и-return/exam/2.3_экзамен",
        )


class WorkspaceLayoutMigrationTest(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)

        with self.Session() as db:
            user = User(email="u@test", name="U", password_hash="x")
            author = User(email="a@test", name="A", password_hash="x", role="author")
            db.add_all([user, author])
            db.flush()
            course = Course(author_id=author.id, title="Python: функции и рекурсия", status="ready")
            db.add(course)
            db.flush()
            node = GraphNode(course_id=course.id, key="basics", title="Объявление и вызов функций")
            db.add(node)
            db.flush()
            task = Task(
                user_id=user.id,
                node_id=node.id,
                stage="practice",
                title="Предскажи вывод",
                statement="...",
                answer="Файл practice/handmade.py:\n```\nprint(2)\n```",
                starter_files=[{"path": "practice/task1_predict.py", "content": "print(1)\n"}],
            )
            db.add(task)
            db.flush()
            empty_task = Task(
                user_id=user.id,
                node_id=node.id,
                stage="practice",
                title="Текстовое задание",
                statement="...",
                starter_files=[],
            )
            db.add(empty_task)
            db.flush()
            other = User(email="other@test", name="Other", password_hash="x")
            db.add(other)
            db.flush()
            other_task = Task(
                user_id=other.id,
                node_id=node.id,
                stage="practice",
                title="Другой ученик",
                statement="...",
                starter_files=[],
            )
            db.add(other_task)
            db.flush()
            db.add(WorkspaceFile(user_id=user.id, course_id=course.id, path="practice/task1_predict.py", content="print(1)\n"))
            # a learner-created file named in the task's answer -> moved into that task's folder
            db.add(WorkspaceFile(user_id=user.id, course_id=course.id, path="practice/handmade.py", content="print(2)\n"))
            # unrelated learner-created file: must stay where it is
            db.add(WorkspaceFile(user_id=user.id, course_id=course.id, path="practice/typing_test.py", content="x\n"))
            db.commit()
            self.user_id, self.course_id, self.task_id = user.id, course.id, task.id
            self.empty_task_id = empty_task.id
            self.other_task_id = other_task.id

    def tearDown(self):
        self.engine.dispose()

    def _migrate(self):
        with patch.object(db_module, "SessionLocal", self.Session):
            workspace_layout.migrate_workspace_layout()

    def test_moves_starter_files_into_task_folder(self):
        self._migrate()
        with self.Session() as db:
            task = db.get(Task, self.task_id)
            node = db.get(GraphNode, task.node_id)
            course = db.get(Course, self.course_id)
            expected = workspace_layout.task_folder(course, node, "practice", "1.1", task.title)
            self.assertEqual(task.workspace_folder, expected)
            self.assertEqual(task.starter_files, [{"path": f"{expected}/task1_predict.py", "content": "print(1)\n"}])
            paths = {p for (p,) in db.query(WorkspaceFile.path).all()}
            self.assertIn(f"{expected}/task1_predict.py", paths)
            self.assertIn(f"{expected}/handmade.py", paths)  # named in the answer: moved to the task
            self.assertNotIn("practice/task1_predict.py", paths)
            self.assertNotIn("practice/handmade.py", paths)
            self.assertIn("practice/typing_test.py", paths)  # unrelated file: untouched

            empty = db.get(Task, self.empty_task_id)
            empty_folder = workspace_layout.task_folder(course, node, empty.stage, "1.2", empty.title)
            self.assertEqual(empty.workspace_folder, empty_folder)
            self.assertIn(f"{empty_folder}/.keep", paths)  # a task without files still has a visible folder

            # numbering is per learner: another user's first task is 1.1, not 1.3
            other = db.get(Task, self.other_task_id)
            other_folder = workspace_layout.task_folder(course, node, other.stage, "1.1", other.title)
            self.assertEqual(other.workspace_folder, other_folder)
            self.assertIn(f"{other_folder}/.keep", {p for (p,) in db.query(WorkspaceFile.path).all()})

    def test_is_idempotent(self):
        self._migrate()
        self._migrate()
        with self.Session() as db:
            task = db.get(Task, self.task_id)
            self.assertEqual(len(task.starter_files), 1)
            rows = db.query(WorkspaceFile).filter(WorkspaceFile.path.like("%task1_predict%")).all()
            self.assertEqual(len(rows), 1)

    def test_tasks_json_exposes_folder(self):
        self._migrate()
        with self.Session() as db:
            task = db.get(Task, self.task_id)
            payload = learning.tasks_json([task])[0]
            self.assertEqual(payload["folder"], task.workspace_folder)
            self.assertEqual(payload["starter_files"], [task.starter_files[0]["path"]])


class FakeLLM:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    async def complete_json(self, **_kwargs):
        self.calls += 1
        return self.payload


def generated_task(title: str, path: str) -> dict:
    return {
        "title": title,
        "statement": "Условие",
        "kind": "code",
        "language": "python",
        "concept": "функции",
        "bloom": "apply",
        "scaffold": "make",
        "starter_files": [{"path": path, "content": "print(1)\n"}],
        "rubric": "Критерии",
        "solution": "Эталон",
        "hints": ["1", "2", "3"],
        "excerpt_id": 0,
    }


class TaskFolderGenerationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.Session() as db:
            author = User(email="a@test", name="A", password_hash="x", role="author")
            student = User(email="s@test", name="S", password_hash="x")
            db.add_all([author, student])
            db.flush()
            course = Course(author_id=author.id, title="Python: функции", status="ready", published=True)
            db.add(course)
            db.flush()
            node = GraphNode(course_id=course.id, key="basics", title="Объявление функций")
            db.add(node)
            db.flush()
            db.commit()
            self.user_id, self.course_id, self.node_id = student.id, course.id, node.id

    def tearDown(self):
        self.engine.dispose()

    def _patches(self, llm):
        return (
            patch.object(learning, "SessionLocal", self.Session),
            patch.object(learning, "get_llm", return_value=llm),
            patch.object(learning.ctx, "materials_block", return_value=""),
        )

    async def test_practice_tasks_get_their_own_folders(self):
        text_task = {**generated_task("Текстовое задание", "practice/unused.py"), "starter_files": []}
        llm = FakeLLM({"tasks": [generated_task(f"Задание {i}", f"practice/task{i}.py") for i in range(1, 3)] + [text_task]})
        p1, p2, p3 = self._patches(llm)
        with p1, p2, p3:
            await learning.generate_practice_tasks(self.user_id, self.node_id)

        with self.Session() as db:
            tasks = db.scalars(select(Task).where(Task.user_id == self.user_id, Task.node_id == self.node_id)).all()
            self.assertEqual(len(tasks), 3)
            numbers = []
            for task in tasks:
                self.assertTrue(task.workspace_folder.startswith("course_"))
                self.assertIn("/practice/", task.workspace_folder)
                self.assertTrue(task.workspace_folder.endswith(f"_{workspace_layout.slug(task.title)}"))
                numbers.append(task.workspace_folder.rsplit("/", 1)[-1].split("_")[0])
                if task.starter_files:
                    self.assertEqual(len(task.starter_files), 1)
                    path = task.starter_files[0]["path"]
                    self.assertTrue(path.startswith(task.workspace_folder + "/"))
                else:
                    path = f"{task.workspace_folder}/.keep"
                row = db.scalar(select(WorkspaceFile).where(WorkspaceFile.path == path))
                self.assertIsNotNone(row)
            self.assertEqual(numbers, ["1.1", "1.2", "1.3"])

    async def test_next_practice_batch_continues_numbering(self):
        llm = FakeLLM({"tasks": [generated_task(f"Задание {i}", f"practice/task{i}.py") for i in range(1, 4)]})
        p1, p2, p3 = self._patches(llm)
        with p1, p2, p3:
            await learning.generate_practice_tasks(self.user_id, self.node_id)
            await learning.generate_practice_tasks(self.user_id, self.node_id)

        with self.Session() as db:
            tasks = db.scalars(
                select(Task).where(Task.user_id == self.user_id, Task.node_id == self.node_id).order_by(Task.id)
            ).all()
            numbers = [t.workspace_folder.rsplit("/", 1)[-1].split("_")[0] for t in tasks]
            self.assertEqual(numbers, ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"])

    async def test_exam_retake_continues_task_numbering(self):
        llm = FakeLLM({"tasks": [generated_task(f"Экзамен {i}", f"exam/lab{i}.py") for i in range(1, 4)]})
        p1, p2, p3 = self._patches(llm)
        with p1, p2, p3, patch.object(learning, "refresh_memory", new=AsyncMock()), patch.object(
            learning, "file_dialogues", new=AsyncMock()
        ):
            first = await learning.start_exam(self.user_id, self.node_id)
            with self.Session() as db:
                db.get(ExamAttempt, first).status = "finished"
                db.commit()
            second = await learning.start_exam(self.user_id, self.node_id)

        with self.Session() as db:
            tasks = db.scalars(select(Task).where(Task.attempt_id == second).order_by(Task.id)).all()
            numbers = [t.workspace_folder.rsplit("/", 1)[-1].split("_")[0] for t in tasks]
            self.assertEqual(numbers, ["1.4", "1.5", "1.6"])

    async def test_exam_tasks_get_their_own_folders(self):
        llm = FakeLLM({"tasks": [generated_task(f"Экзамен {i}", f"exam/lab{i}.py") for i in range(1, 4)]})
        p1, p2, p3 = self._patches(llm)
        with (
            p1, p2, p3,
            patch.object(learning, "refresh_memory", new=AsyncMock()),
            patch.object(learning, "file_dialogues", new=AsyncMock()),
        ):
            attempt_id = await learning.start_exam(self.user_id, self.node_id)

        with self.Session() as db:
            attempt = db.get(ExamAttempt, attempt_id)
            self.assertIsNotNone(attempt)
            tasks = db.scalars(select(Task).where(Task.attempt_id == attempt_id)).all()
            self.assertEqual(len(tasks), 3)
            numbers = []
            for task in tasks:
                self.assertIn("/exam/", task.workspace_folder)
                numbers.append(task.workspace_folder.rsplit("/", 1)[-1].split("_")[0])
                self.assertTrue(task.starter_files[0]["path"].startswith(task.workspace_folder + "/"))
            self.assertEqual(numbers, ["1.1", "1.2", "1.3"])


if __name__ == "__main__":
    unittest.main()
