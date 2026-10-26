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

        return _docx_text(docx.Document(io.BytesIO(data)))
    if any(name.endswith(ext) for ext in TEXT_EXT):
        for enc in ("utf-8", "cp1251", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
    raise ValueError(f"Неподдерживаемый формат файла: {filename}. Поддерживаются PDF, DOCX, TXT, MD.")


def _docx_text(document) -> str:
    """Paragraphs and tables in document order, one blank line between blocks (tasks often sit in tables)."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    blocks: list[str] = []
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            p = Paragraph(child, document)
            text = p.text.strip()
            if not text:
                continue
            style = (p.style.name if p.style is not None else "") or ""
            level = style.rsplit(" ", 1)[-1] if style.lower().startswith(("heading", "заголовок")) else ""
            blocks.append(f"{'#' * int(level)} {text}" if level.isdigit() and 1 <= int(level) <= 6 else text)
        elif tag == "tbl":
            for row in Table(child, document).rows:
                cells = list(dict.fromkeys(c.text.strip().replace("\n", " ") for c in row.cells))  # merged cells repeat
                if any(cells):
                    blocks.append(" | ".join(cells))
    return "\n\n".join(blocks)


def normalize_text(content: str) -> str:
    """Whitespace clean-up shared by chunking and the passage viewer, so character offsets stay valid."""
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    content = re.sub(r"[ \t ]+", " ", content)
    content = re.sub(r" ?\n ?", "\n", content)
    return re.sub(r"\n{3,}", "\n\n", content).strip()


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


def material_text(db: Session, material: CourseMaterial) -> str:
    """The text the author reads when pinning passages. Materials uploaded before the text was kept
    are rebuilt from their chunks once and saved, so offsets into it stay stable."""
    if not material.text:
        chunks = db.scalars(
            select(MaterialChunk.content).where(MaterialChunk.material_id == material.id).order_by(MaterialChunk.position)
        ).all()
        material.text = "\n\n".join(chunks)
    return material.text


def set_kind(db: Session, material: CourseMaterial, kind: str) -> None:
    material.kind = kind
    for chunk in db.scalars(select(MaterialChunk).where(MaterialChunk.material_id == material.id)).all():
        chunk.kind = kind


def add_material(db: Session, course_id: int, filename: str, kind: str, content: str) -> CourseMaterial:
    content = normalize_text(content)
    material = CourseMaterial(course_id=course_id, filename=filename, kind=kind, chars=len(content), text=content)
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
