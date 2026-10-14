from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..security import create_token, current_user, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=6, max_length=200)
    role: str = Field(default="student", pattern="^(student|author)$")
    consent: bool = False


class LoginIn(BaseModel):
    email: str
    password: str


def user_json(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role}


@router.post("/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Некорректный email")
    if not body.consent:
        raise HTTPException(400, "Нужно согласие на запись учебных действий и динамики ввода")
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(409, "Пользователь с таким email уже существует")
    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password), role=body.role, consent_telemetry=True)
    db.add(user)
    db.commit()
    return {"token": create_token(user.id), "user": user_json(user)}


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.strip().lower()))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Неверный логин или пароль")
    return {"token": create_token(user.id), "user": user_json(user)}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user_json(user)
