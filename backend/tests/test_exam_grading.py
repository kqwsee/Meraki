"""Contract tests for exam grading.

The grader used to return rubric points (7, 10, 10) while the service treated them as
percentages, turning a perfect exam into 9/100. These tests pin the points/max_points
contract and the repair fallback.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import Course, Enrollment, ExamAttempt, GraphNode, Task, User
from app.prompts import (
    CHECK_SYSTEM,
    EXAM_GRADE_REPAIR_SYSTEM,
    EXAM_GRADE_SCHEMA,
    EXAM_GRADE_SYSTEM,
    EXAM_TASKS_SYSTEM,
)
from app.routers.learn import _shown_attempt
from app.services import learning


class FakeLLM:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    async def complete_json(self, *, system, prompt, schema, tier="fast"):
        self.calls.append({"system": system, "prompt": prompt, "schema": schema, "tier": tier})
        if not self.responses:
            raise AssertionError("FakeLLM ran out of responses")
        return self.responses.pop(0)


def grade(*rows):
    return {
        "results": [{"task_id": task_id, **row} for task_id, row in rows],
        "overall_comment": "Итог",
        "weak_concepts": [],
    }


class NormalizeExamScoreTest(unittest.TestCase):
    def test_points_scale_becomes_percentage(self):
        self.assertEqual(learning.normalize_exam_score({"points": 7, "max_points": 7}), 100.0)
        self.assertEqual(learning.normalize_exam_score({"points": 10, "max_points": 10}), 100.0)
        self.assertEqual(learning.normalize_exam_score({"points": 27, "max_points": 27}), 100.0)
        self.assertEqual(learning.normalize_exam_score({"points": 6, "max_points": 8}), 75.0)
        self.assertEqual(learning.normalize_exam_score({"points": 0, "max_points": 100}), 0.0)
        self.assertEqual(learning.normalize_exam_score({"points": "1.5", "max_points": "2"}), 75.0)

    def test_contract_violations_are_rejected(self):
        bad = [
            {},
            {"points": 1},
            {"max_points": 1},
            {"points": 1, "max_points": 0},
            {"points": -1, "max_points": 10},
            {"points": 11, "max_points": 10},
            {"points": "много", "max_points": 10},
            {"points": float("nan"), "max_points": 10},
            {"points": 1, "max_points": float("inf")},
            {"points": True, "max_points": 10},
        ]
        for row in bad:
            with self.subTest(row=row):
                with self.assertRaises(learning.GradingContractError):
                    learning.normalize_exam_score(row)


class ValidateExamGradeTest(unittest.TestCase):
    def test_all_tasks_must_be_graded_once(self):
        scores = learning.validate_exam_grade(
            grade(
                (1, {"points": 7, "max_points": 7, "feedback": "ok"}),
                (2, {"points": 5, "max_points": 10, "feedback": "ok"}),
                (999, {"points": 0, "max_points": 1, "feedback": "hallucinated id"}),
            ),
            {1, 2},
        )
        self.assertEqual(scores, {1: 100.0, 2: 50.0})

        with self.assertRaises(learning.GradingContractError):
            learning.validate_exam_grade(grade((1, {"points": 1, "max_points": 1, "feedback": ""})), {1, 2})

        with self.assertRaises(learning.GradingContractError):
            learning.validate_exam_grade(
                grade(
                    (1, {"points": 1, "max_points": 1, "feedback": ""}),
                    (1, {"points": 1, "max_points": 1, "feedback": ""}),
                ),
                {1},
            )


class PromptContractTest(unittest.TestCase):
    def test_schema_requires_points_and_max_points(self):
        item = EXAM_GRADE_SCHEMA["properties"]["results"]["items"]
        self.assertEqual(item["required"], ["task_id", "points", "max_points", "feedback"])
        self.assertNotIn("score", item["properties"])
        self.assertEqual(item["properties"]["max_points"]["minimum"], 0)

    def test_prompts_describe_the_contract(self):
        for text in (EXAM_GRADE_SYSTEM, EXAM_GRADE_REPAIR_SYSTEM):
            self.assertIn("points", text)
            self.assertIn("max_points", text)
            self.assertIn("score", text)  # explicitly told NOT to return score
        self.assertIn("ровно 100", EXAM_TASKS_SYSTEM)
        self.assertIn("100 * набрано", CHECK_SYSTEM)


class GradeExamRepairTest(unittest.IsolatedAsyncioTestCase):
    async def test_old_points_answer_is_repaired_and_scores_100(self):
        llm = FakeLLM(
            grade(
                (1, {"score": 7, "feedback": "all correct"}),
                (2, {"score": 10, "feedback": "all correct"}),
                (3, {"score": 10, "feedback": "all correct"}),
            ),
            grade(
                (1, {"points": 7, "max_points": 7, "feedback": "all correct"}),
                (2, {"points": 10, "max_points": 10, "feedback": "all correct"}),
                (3, {"points": 10, "max_points": 10, "feedback": "all correct"}),
            ),
        )
        scores, final = await learning._grade_exam(llm, "prompt", {1, 2, 3})
        self.assertEqual(scores, {1: 100.0, 2: 100.0, 3: 100.0})
        self.assertEqual(final["results"][0]["points"], 7)
        self.assertEqual(len(llm.calls), 2)
        self.assertEqual(llm.calls[1]["system"], EXAM_GRADE_REPAIR_SYSTEM)

    async def test_valid_first_answer_needs_no_repair(self):
        llm = FakeLLM(grade((1, {"points": 1, "max_points": 2, "feedback": "half"})))
        scores, _ = await learning._grade_exam(llm, "prompt", {1})
        self.assertEqual(scores, {1: 50.0})
        self.assertEqual(len(llm.calls), 1)

    async def test_second_failure_raises(self):
        bad = grade((1, {"score": 7, "feedback": "no points"}))
        llm = FakeLLM(bad, bad)
        with self.assertRaises(learning.GradingContractError):
            await learning._grade_exam(llm, "prompt", {1})


class SubmitExamIntegrationTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)

        with self.Session() as db:
            author = User(email="author@test", name="Author", password_hash="x", role="author")
            student = User(email="student@test", name="Student", password_hash="x")
            db.add_all([author, student])
            db.flush()
            course = Course(author_id=author.id, title="Курс", status="ready", published=True)
            db.add(course)
            db.flush()
            node = GraphNode(course_id=course.id, key="topic", title="Тема", objectives=[], concepts=[])
            db.add(node)
            db.flush()
            db.add(Enrollment(user_id=student.id, course_id=course.id))
            attempt = ExamAttempt(user_id=student.id, node_id=node.id, status="in_progress")
            db.add(attempt)
            db.flush()
            tasks = [
                Task(
                    user_id=student.id,
                    node_id=node.id,
                    stage="exam",
                    attempt_id=attempt.id,
                    title=f"Задание {i}",
                    statement="Условие",
                    kind="text",
                    rubric=f"Критерии на {max_points} баллов",
                )
                for i, max_points in enumerate((7, 10, 10), start=1)
            ]
            db.add_all(tasks)
            db.commit()
            self.user_id = student.id
            self.attempt_id = attempt.id
            self.task_ids = [t.id for t in tasks]

    def tearDown(self):
        self.engine.dispose()

    async def _submit_with(self, llm, answers):
        with (
            patch.object(learning, "SessionLocal", self.Session),
            patch.object(learning, "get_llm", return_value=llm),
            patch.object(learning, "_finalize_exam", new=AsyncMock()),
        ):
            await learning.submit_exam(self.user_id, self.attempt_id, answers)

    async def _submit(self, llm):
        answers = {str(task_id): {"answer": "решение"} for task_id in self.task_ids}
        await self._submit_with(llm, answers)

    async def test_points_answer_is_not_averaged_as_percentages(self):
        """The old bug: (7+10+10)/3 = 9. Now 7/7, 10/10, 10/10 = 100."""
        llm = FakeLLM(
            grade(
                (self.task_ids[0], {"score": 7, "feedback": "ok"}),
                (self.task_ids[1], {"score": 10, "feedback": "ok"}),
                (self.task_ids[2], {"score": 10, "feedback": "ok"}),
            ),
            grade(
                (self.task_ids[0], {"points": 7, "max_points": 7, "feedback": "ok"}),
                (self.task_ids[1], {"points": 10, "max_points": 10, "feedback": "ok"}),
                (self.task_ids[2], {"points": 10, "max_points": 10, "feedback": "ok"}),
            ),
        )
        await self._submit(llm)

        with self.Session() as db:
            attempt = db.get(ExamAttempt, self.attempt_id)
            tasks = [db.get(Task, task_id) for task_id in self.task_ids]
            self.assertEqual(attempt.status, "finished")
            self.assertEqual(attempt.raw_score, 100.0)
            self.assertEqual(attempt.score, 100.0)
            self.assertIsNotNone(attempt.finished_at)
            self.assertEqual([t.score for t in tasks], [100.0, 100.0, 100.0])
            self.assertEqual([t.status for t in tasks], ["graded", "graded", "graded"])

    async def test_failed_grading_keeps_attempt_resubmittable(self):
        bad = grade((self.task_ids[0], {"score": 7, "feedback": "no points"}))
        llm = FakeLLM(bad, bad)
        with self.assertRaises(learning.GradingContractError):
            await self._submit(llm)

        with self.Session() as db:
            attempt = db.get(ExamAttempt, self.attempt_id)
            self.assertEqual(attempt.status, "in_progress")
            self.assertIsNone(attempt.finished_at)
            self.assertIsNone(attempt.raw_score)
            self.assertIsNone(attempt.score)

    async def test_empty_resubmission_does_not_erase_saved_answer(self):
        """A client that lost its draft may retry with empty fields; keep the saved answer."""
        bad = grade((self.task_ids[0], {"score": 7, "feedback": "no points"}))
        first_answers = {str(task_id): {"answer": "полный ответ"} for task_id in self.task_ids}
        with self.assertRaises(learning.GradingContractError):
            await self._submit_with(FakeLLM(bad, bad), first_answers)

        full = grade(*[(task_id, {"points": 1, "max_points": 1, "feedback": "ok"}) for task_id in self.task_ids])
        llm = FakeLLM(full)
        await self._submit_with(llm, {str(task_id): {"answer": ""} for task_id in self.task_ids})

        self.assertIn("полный ответ", llm.calls[0]["prompt"])
        with self.Session() as db:
            tasks = [db.get(Task, task_id) for task_id in self.task_ids]
            self.assertEqual([t.submitted_answer for t in tasks], ["полный ответ"] * 3)
            self.assertEqual(learning.tasks_json(tasks)[0]["submitted_answer"], "полный ответ")

    async def test_regrade_uses_saved_answers_and_keeps_completed_defence(self):
        """Repair path: no retake, no second defence; the old understanding still applies."""
        half = grade(*[(task_id, {"points": 1, "max_points": 2, "feedback": "half"}) for task_id in self.task_ids])
        await self._submit(FakeLLM(half))
        with self.Session() as db:
            attempt = db.get(ExamAttempt, self.attempt_id)
            attempt.understanding = 0.5
            attempt.verification = [
                {"flag_id": 1, "question": "q", "fragment": "f", "kind": "paste", "answer": "a", "understood": True, "comment": ""}
            ]
            attempt.summary = "Старый итог\n\n**Проверка понимания:** зачтено"
            db.commit()

        full = grade(*[(task_id, {"points": 1, "max_points": 1, "feedback": "ok"}) for task_id in self.task_ids])
        llm = FakeLLM(full)
        with (
            patch.object(learning, "SessionLocal", self.Session),
            patch.object(learning, "get_llm", return_value=llm),
            patch.object(learning, "_finalize_exam", new=AsyncMock()),
        ):
            await learning.regrade_exam(self.attempt_id)

        with self.Session() as db:
            attempt = db.get(ExamAttempt, self.attempt_id)
            self.assertEqual(attempt.status, "finished")
            self.assertEqual(attempt.raw_score, 100.0)
            self.assertEqual(attempt.score, 80.0)  # 100 * (0.6 + 0.4 * 0.5)
            self.assertIn("Проверка понимания", attempt.summary)
            self.assertIn("зачтено", attempt.summary)


class ShownAttemptTest(unittest.TestCase):
    def test_failed_retake_does_not_hide_earlier_pass(self):
        passed = SimpleNamespace(id=20, status="finished", score=68.0)
        failed = SimpleNamespace(id=21, status="finished", score=21.7)
        self.assertIs(_shown_attempt([failed, passed], True), passed)
        self.assertIs(_shown_attempt([failed, passed], False), failed)

    def test_active_attempt_always_wins(self):
        passed = SimpleNamespace(id=20, status="finished", score=68.0)
        failed = SimpleNamespace(id=21, status="finished", score=21.7)
        active = SimpleNamespace(id=22, status="in_progress", score=None)
        verifying = SimpleNamespace(id=23, status="verifying", score=None)
        self.assertIs(_shown_attempt([active, failed, passed], True), active)
        self.assertIs(_shown_attempt([verifying, failed, passed], True), verifying)

    def test_best_passing_attempt_is_shown(self):
        better = SimpleNamespace(id=21, status="finished", score=80.0)
        worse = SimpleNamespace(id=22, status="finished", score=21.7)
        self.assertIs(_shown_attempt([worse, better], True), better)


if __name__ == "__main__":
    unittest.main()
