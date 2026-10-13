import io
import re

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import CourseMaterial, MaterialChunk

CHUNK_CHARS = 1800
TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".json", ".py", ".js", ".ts", ".html", ".css", ".sql", ".c", ".cpp", ".java"}


def extract_text(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".pdf"):
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join((page.extract_text() or "") for page in reader.pages)
    if name.endswith(".docx"):
        import docx

        document = docx.Document(io.BytesIO(data))
        return "\n".join(p.text for p in document.paragraphs)
    if any(name.endswith(ext) for ext in TEXT_EXT):
        for enc in ("utf-8", "cp1251", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
    raise ValueError(f"Неподдерживаемый формат файла: {filename}. Поддерживаются PDF, DOCX, TXT, MD.")


def chunk_text(content: str) -> list[str]:
    content = re.sub(r"[ \t]+", " ", content)
    content = re.sub(r"\n{3,}", "\n\n", content).strip()
    paragraphs = [p.strip() for p in content.split("\n\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paragraphs:
        while len(p) > CHUNK_CHARS:  # very long paragraph
            chunks.append(p[:CHUNK_CHARS])
            p = p[CHUNK_CHARS:]
        if len(buf) + len(p) + 2 > CHUNK_CHARS and buf:
            chunks.append(buf)
            buf = p
        else:
            buf = f"{buf}\n\n{p}" if buf else p
    if buf:
        chunks.append(buf)
    return chunks


def add_material(db: Session, course_id: int, filename: str, kind: str, content: str) -> CourseMaterial:
    material = CourseMaterial(course_id=course_id, filename=filename, kind=kind, chars=len(content))
    db.add(material)
    db.flush()
    for i, chunk in enumerate(chunk_text(content)):
        row = MaterialChunk(material_id=material.id, course_id=course_id, kind=kind, position=i, content=chunk)
        db.add(row)
        db.flush()
        db.execute(
            text("INSERT INTO chunks_fts(content, chunk_id, course_id) VALUES (:c, :id, :course)"),
            {"c": chunk, "id": row.id, "course": course_id},
        )
    return material


def delete_material(db: Session, material: CourseMaterial) -> None:
    ids = db.scalars(select(MaterialChunk.id).where(MaterialChunk.material_id == material.id)).all()
    for chunk_id in ids:
        db.execute(text("DELETE FROM chunks_fts WHERE chunk_id = :id"), {"id": chunk_id})
    db.delete(material)


_WORD_RE = re.compile(r"\w{3,}", re.UNICODE)


def _fts_query(query: str) -> str:
    words = _WORD_RE.findall(query.lower())[:24]
    # prefix match tolerates Russian inflection a little ("рекурси*")
    return " OR ".join(f'"{w[:max(4, len(w) - 2)]}"*' for w in words)


def search(db: Session, course_id: int, query: str, limit: int = 5, kind: str | None = None) -> list[str]:
    q = _fts_query(query)
    if not q:
        return []
    rows = db.execute(
        text(
            "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH :q AND course_id = :course "
            "ORDER BY bm25(chunks_fts) LIMIT :lim"
        ),
        {"q": q, "course": course_id, "lim": limit * 3},
    ).all()
    ids = [r[0] for r in rows]
    if not ids:
        return []
    stmt = select(MaterialChunk).where(MaterialChunk.id.in_(ids))
    if kind:
        stmt = stmt.where(MaterialChunk.kind == kind)
    by_id = {c.id: c for c in db.scalars(stmt).all()}
    return [by_id[i].content for i in ids if i in by_id][:limit]


def course_digest(db: Session, course_id: int, budget: int = 90_000) -> str:
    """Material text for building the knowledge graph; samples evenly when the course is large."""
    chunks = db.scalars(
        select(MaterialChunk).where(MaterialChunk.course_id == course_id).order_by(MaterialChunk.material_id, MaterialChunk.position)
    ).all()
    if not chunks:
        return ""
    total = sum(len(c.content) for c in chunks)
    if total <= budget:
        return "\n\n".join(f"[{c.kind}] {c.content}" for c in chunks)
    # Headings from everything + evenly spaced chunks up to the budget
    headings = []
    for c in chunks:
        for line in c.content.splitlines():
            s = line.strip()
            if 3 < len(s) < 90 and (s.startswith("#") or re.match(r"^(Глава|Раздел|Тема|Chapter|§|\d+(\.\d+)*\.?\s)", s)):
                headings.append(s)
    head_text = "\n".join(dict.fromkeys(headings))[: budget // 4]
    remaining = budget - len(head_text)
    step = max(1, -(-total // remaining)) if remaining > 0 else len(chunks)
    picked = [c for i, c in enumerate(chunks) if i % step == 0]
    body = ""
    for c in picked:
        if len(body) + len(c.content) > remaining:
            break
        body += f"\n\n[{c.kind}] {c.content}"
    return f"Оглавление/заголовки:\n{head_text}\n\nВыдержки:{body}"
