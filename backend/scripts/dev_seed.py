"""Dev-only test accounts for the local Meraki instance (never use in production).

Writes straight into the database, so short logins and passwords that the registration form
would reject also work. Existing accounts get their password, name and role reset.

Usage: .venv/Scripts/python.exe scripts/dev_seed.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import User  # noqa: E402
from app.security import hash_password  # noqa: E402

ACCOUNTS = [
    {"email": "testuser", "name": "Тестовый ученик", "password": "1111", "role": "student"},
    {"email": "testadmin", "name": "Тестовый учитель", "password": "2222", "role": "author"},
    {"email": "author@meraki.test", "name": "Автор (тест)", "password": "mk-iFQdK27Nqo1M", "role": "author"},
    {"email": "student@meraki.test", "name": "Аня (тест)", "password": "mk-2OJregZ2OQPA", "role": "student"},
    {"email": "novice@meraki.test", "name": "Тимур (новый)", "password": "mk-Q7wLp2Rk8Vz3", "role": "student"},
]

if __name__ == "__main__":
    init_db()
    with SessionLocal() as db:
        for acc in ACCOUNTS:
            user = db.scalar(select(User).where(func.lower(User.email) == acc["email"]))
            status = "updated" if user else "created"
            if user is None:
                user = User(email=acc["email"], consent_telemetry=True)
                db.add(user)
            user.name, user.role = acc["name"], acc["role"]
            user.password_hash = hash_password(acc["password"])
            print(f"{acc['email']:<22} {acc['role']:<8} {status}")
        db.commit()
