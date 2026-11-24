"""The Obsidian export must be a real vault, not just a pile of markdown files.

Obsidian draws its graph from ``[[wiki links]]``, so these tests pin the promise behind the export:
the note → course/topic connections from the profile knowledge map survive as links, and every
link resolves to a file that exists in the archive.
"""

import io
import re
import unittest
import zipfile
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.models import Course, GraphNode, Note, User
from app.routers.profile import router as profile_router
from app.security import current_user
from app.services.obsidian import export_vault


class ObsidianExportTest(unittest.TestCase):
    def setUp(self):
        engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(engine)
        self.Session = sessionmaker(bind=engine, expire_on_commit=False)
        with self.Session() as db:
            author = User(email="author@test", name="Автор", password_hash="x", role="author")
            learner = User(email="learner@test", name="Ученик", password_hash="x")
            other = User(email="other@test", name="Другой", password_hash="x")
            db.add_all([author, learner, other])
            db.flush()
            course = Course(author_id=author.id, title="Python: функции", status="ready")
            db.add(course)
            db.flush()
            topic = GraphNode(
                course_id=course.id, key="recursion", title="Рекурсия", summary="Функция вызывает себя."
            )
            db.add(topic)
            db.flush()
            db.add_all([
                Note(
                    user_id=learner.id, title="Рекурсия", content="Конспект: база — условие выхода.",
                    course_id=course.id, node_id=topic.id,
                ),
                Note(user_id=learner.id, title="Без курса", content="Свободная мысль."),
                Note(user_id=other.id, title="Чужая заметка", content="Не должна попасть в экспорт."),
            ])
            db.commit()
            self.learner_id, self.other_id = learner.id, other.id

    def vault(self, user_id: int) -> zipfile.ZipFile:
        with self.Session() as db:
            return zipfile.ZipFile(io.BytesIO(export_vault(db, db.get(User, user_id))))

    def test_export_route_is_registered(self):
        # /notes/export must not be shadowed by a /notes/{id} route declared earlier.
        self.assertIn("/api/notes/export", {route.path for route in profile_router.routes})

    def test_notes_keep_their_course_and_topic_links(self):
        zf = self.vault(self.learner_id)
        names = set(zf.namelist())
        self.assertIn("README.md", names)
        self.assertIn("Заметки/Рекурсия.md", names)
        self.assertIn("Заметки/Без курса.md", names)
        # ':' is illegal in file names, so the course hub gets a sanitized stem, not the raw title.
        self.assertIn("Курсы/Python- функции.md", names)
        self.assertIn("Темы/Рекурсия.md", names)

        note = zf.read("Заметки/Рекурсия.md").decode("utf-8")
        self.assertIn("[[Курсы/Python- функции|Python: функции]]", note)
        self.assertIn("[[Темы/Рекурсия]]", note)
        self.assertIn("база — условие выхода.", note)

        course = zf.read("Курсы/Python- функции.md").decode("utf-8")
        self.assertIn("[[Заметки/Рекурсия]]", course)
        self.assertIn("[[Темы/Рекурсия]]", course)

        topic = zf.read("Темы/Рекурсия.md").decode("utf-8")
        self.assertIn("[[Курсы/Python- функции|Python: функции]]", topic)
        self.assertIn("[[Заметки/Рекурсия]]", topic)
        self.assertIn("Функция вызывает себя.", topic)

        loose = zf.read("Заметки/Без курса.md").decode("utf-8")
        self.assertNotIn("[[", loose)

    def test_every_wiki_link_points_at_a_file(self):
        zf = self.vault(self.learner_id)
        files = {name.removesuffix(".md") for name in zf.namelist()}
        for name in zf.namelist():
            if not name.endswith(".md") or name == "README.md":
                continue
            for target in re.findall(r"\[\[([^\]|]+)", zf.read(name).decode("utf-8")):
                self.assertIn(target, files, f"{name} ссылается на отсутствующий {target}")

    def test_other_users_notes_are_not_exported(self):
        names = set(self.vault(self.other_id).namelist())
        self.assertNotIn("Заметки/Рекурсия.md", names)
        self.assertIn("Заметки/Чужая заметка.md", names)

    def test_endpoint_serves_the_vault_as_a_zip_attachment(self):
        app = FastAPI()
        app.include_router(profile_router)

        def override_db():
            db = self.Session()
            try:
                yield db
            finally:
                db.close()

        learner_id = self.learner_id
        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[current_user] = lambda: SimpleNamespace(id=learner_id, name="Ученик")

        response = TestClient(app).get("/api/notes/export")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "application/zip")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertIn("meraki-obsidian-", response.headers["content-disposition"])
        self.assertIn("Заметки/Рекурсия.md", zipfile.ZipFile(io.BytesIO(response.content)).namelist())

    def test_same_title_gets_a_distinct_file(self):
        with self.Session() as db:
            db.add(Note(user_id=self.learner_id, title="Рекурсия", content="Вторая заметка"))
            db.commit()
        names = set(self.vault(self.learner_id).namelist())
        self.assertIn("Заметки/Рекурсия.md", names)
        self.assertIn("Заметки/Рекурсия (2).md", names)
