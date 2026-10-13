"""Dev-only test accounts for the local Meraki instance (never use in production).

Usage: .venv/Scripts/python.exe scripts/dev_seed.py  (backend must be running on :8000)
"""

import httpx

ACCOUNTS = [
    {"email": "author@meraki.test", "name": "Автор (тест)", "password": "mk-iFQdK27Nqo1M", "role": "author", "consent": True},
    {"email": "student@meraki.test", "name": "Аня (тест)", "password": "mk-2OJregZ2OQPA", "role": "student", "consent": True},
]

if __name__ == "__main__":
    for acc in ACCOUNTS:
        r = httpx.post("http://127.0.0.1:8000/api/auth/register", json=acc)
        print(acc["email"], r.status_code, r.json().get("detail", "ok"))
