"""Pictures of a course: the author's uploads, figures found in uploaded PDF/DOCX files, and images imported from
Russian or English Wikipedia articles (free files of Wikimedia Commons). Every file is checked and normalized with Pillow and stored under
data/assets/<course id>/<key>.<ext>; the key is random, so the public URL cannot be guessed."""

import hashlib
import io
import logging
import re
import shutil
import uuid
import zipfile
from collections.abc import Iterator
from html import unescape
from pathlib import Path
from typing import Any

import httpx
from PIL import Image, ImageOps
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import CourseAsset, CourseMaterial, GraphNode, TopicVisual
from .fetcher import download_public, user_agent

log = logging.getLogger("meraki.assets")

MAX_BYTES = 15 * 1024 * 1024  # one uploaded or imported picture
MAX_SIDE = 2400  # larger pictures are scaled down
MIN_SIDE, MIN_AREA, MAX_ASPECT = 80, 150 * 150, 8  # figures from materials: skip icons, bullets and rules
MAX_PER_MATERIAL = 120
SOURCES = ("upload", "material", "web")

KEEP = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "WEBP": "image/webp"}
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}

Image.MAX_IMAGE_PIXELS = 80_000_000


def _dir(course_id: int) -> Path:
    return settings.data_dir / "assets" / str(course_id)


def file_path(a: CourseAsset) -> Path:
    return _dir(a.course_id) / f"{a.key}.{EXT.get(a.mime, 'png')}"


def url(a: CourseAsset) -> str:
    return f"/api/assets/{a.key}"


def asset_json(a: CourseAsset, used: int = 0) -> dict[str, Any]:
    return {
        "id": a.id, "url": url(a), "filename": a.filename, "mime": a.mime, "size": a.size, "width": a.width, "height": a.height,
        "source": a.source, "material_id": a.material_id, "page": a.page, "title": a.title, "license": a.license,
        "author": a.author, "source_url": a.source_url, "used": used,
    }  # fmt: skip


# ---------- storing ----------


def normalize(data: bytes) -> tuple[bytes, str, int, int]:
    """(bytes, mime, width, height) of a web-friendly picture; raises ValueError for anything that is not one."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001 - Pillow raises many kinds
        raise ValueError("Это не картинка или её формат не поддерживается (подойдут PNG, JPEG, GIF, WebP)") from e
    fmt = (img.format or "").upper()
    if fmt in KEEP and max(img.size) <= MAX_SIDE and not (fmt == "JPEG" and img.mode not in ("RGB", "L")):
        return data, KEEP[fmt], img.width, img.height
    img = ImageOps.exif_transpose(img)
    img.thumbnail((MAX_SIDE, MAX_SIDE))
    alpha = img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info)
    out = io.BytesIO()
    if alpha or fmt in ("PNG", "GIF", "BMP", "TIFF"):  # drawings and diagrams stay lossless
        img.convert("RGBA" if alpha else "RGB").save(out, "PNG", optimize=True)
        mime = "image/png"
    else:
        img.convert("RGB").save(out, "JPEG", quality=88, optimize=True)
        mime = "image/jpeg"
    return out.getvalue(), mime, img.width, img.height


def save_image(db: Session, course_id: int, data: bytes, *, filename: str, source: str, **meta: Any) -> tuple[CourseAsset, bool]:
    """Stores a picture for the course; the same picture twice is kept once. Returns (asset, created)."""
    if len(data) > MAX_BYTES:
        raise ValueError(f"Картинка больше {MAX_BYTES // (1024 * 1024)} МБ")
    blob, mime, width, height = normalize(data)
    digest = hashlib.sha256(blob).hexdigest()
    twin = db.scalar(select(CourseAsset).where(CourseAsset.course_id == course_id, CourseAsset.sha256 == digest))
    if twin is not None:
        return twin, False
    asset = CourseAsset(
        course_id=course_id, key=uuid.uuid4().hex, filename=filename[:255], mime=mime, size=len(blob), width=width, height=height,
        sha256=digest, source=source if source in SOURCES else "upload", **meta,
    )  # fmt: skip
    path = file_path(asset)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    db.add(asset)
    db.flush()
    return asset, True


def usage(db: Session, course_id: int) -> dict[int, int]:
    """How many visuals and topic covers use each picture of the course."""
    counts: dict[int, int] = {}
    rows = db.execute(
        select(TopicVisual.asset_id, func.count()).where(TopicVisual.course_id == course_id, TopicVisual.asset_id.is_not(None)).group_by(TopicVisual.asset_id)
    ).all()
    for asset_id, n in rows:
        counts[asset_id] = counts.get(asset_id, 0) + n
    for asset_id in db.scalars(select(GraphNode.cover_asset_id).where(GraphNode.course_id == course_id, GraphNode.cover_asset_id.is_not(None))).all():
        counts[asset_id] = counts.get(asset_id, 0) + 1
    return counts


def delete_asset(db: Session, a: CourseAsset) -> None:
    file_path(a).unlink(missing_ok=True)
    db.delete(a)


def delete_course_files(course_id: int) -> None:
    shutil.rmtree(_dir(course_id), ignore_errors=True)


def cover_urls(db: Session, nodes: list[GraphNode]) -> dict[int, str]:
    """node id -> its cover URL, for the nodes that have one."""
    ids = {n.cover_asset_id for n in nodes if n.cover_asset_id}
    if not ids:
        return {}
    by_id = {a.id: a for a in db.scalars(select(CourseAsset).where(CourseAsset.id.in_(ids))).all()}
    return {n.id: url(by_id[n.cover_asset_id]) for n in nodes if n.cover_asset_id in by_id}


# ---------- figures inside uploaded materials ----------


def _pdf_images(data: bytes) -> Iterator[tuple[bytes, int | None]]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    for number, page in enumerate(reader.pages, start=1):
        try:
            images = list(page.images)
        except Exception:  # noqa: BLE001 - a broken page must not stop the others
            continue
        for img in images:
            try:
                yield img.data, number
            except Exception:  # noqa: BLE001
                continue


def _docx_images(data: bytes) -> Iterator[tuple[bytes, int | None]]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [i for i in z.infolist() if i.filename.startswith("word/media/") and i.file_size <= MAX_BYTES]
        names.sort(key=lambda i: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", i.filename)])  # image2 before image10
        for info in names:
            yield z.read(info), None


def import_from_material(db: Session, course_id: int, material: CourseMaterial, filename: str, data: bytes) -> int:
    """Takes the figures out of an uploaded PDF/DOCX; returns how many new pictures were added."""
    name = filename.lower()
    if name.endswith(".pdf"):
        found = _pdf_images(data)
    elif name.endswith(".docx"):
        found = _docx_images(data)
    else:
        return 0
    added = 0
    try:
        for i, (blob, page) in enumerate(found, start=1):
            if added >= MAX_PER_MATERIAL:
                break
            try:
                with Image.open(io.BytesIO(blob)) as probe:
                    w, h = probe.size
            except Exception:  # noqa: BLE001 - EMF/WMF and other formats Pillow cannot read
                continue
            if min(w, h) < MIN_SIDE or w * h < MIN_AREA or max(w, h) > MAX_ASPECT * min(w, h):
                continue
            label = f"{material.filename} · стр. {page}" if page else f"{material.filename} · рисунок {i}"
            try:
                _, created = save_image(db, course_id, blob, filename=label, source="material", material_id=material.id, page=page)
            except ValueError:
                continue
            added += created
    except Exception:  # noqa: BLE001 - the text of the material is what matters; figures are a bonus
        log.exception("figure extraction failed for %s", filename)
    return added


def drop_material_assets(db: Session, material_id: int) -> None:
    """Pictures taken from a deleted material go with it, unless a visual or a cover still uses them."""
    rows = db.scalars(select(CourseAsset).where(CourseAsset.material_id == material_id)).all()
    if not rows:
        return
    used = usage(db, rows[0].course_id)
    for a in rows:
        if not used.get(a.id):
            delete_asset(db, a)


# ---------- open libraries: Russian and English Wikipedia ----------
# Pictures are taken from the ru/en Wikipedia articles that match the query, so their labels are in Russian or English
# (a search over all of Wikimedia Commons brings diagrams labelled in any language). Only files kept on Wikimedia
# Commons are offered: Commons holds free licenses only, while files local to a Wikipedia may be non-free.

WIKIPEDIA_API = "https://{lang}.wikipedia.org/w/api.php"
WEB_SOURCES = ("ru", "en")
WEB_SOURCE_NAMES = {"ru": "Русская Википедия", "en": "Английская Википедия"}
MIN_WEB_SIDE = 180  # smaller files are icons and bullets
# pictures of article templates and navigation boxes, not of the topic itself
_NOISE = re.compile(
    r"logo|icon|ambox|commons-|wiki[ _-]?letter|wiki(quote|tionary|books|source|news|versity|data)|edit-clear|question[ _]book|"
    r"padlock|disambig|portal|folder|crystal[ _]clear|nuvola|gnome-|flag[ _]of|pencil|text[ _]document|loudspeaker|speaker|"
    r"increase|decrease|steady|star[ _]full|oojs|emblem|red[ _]x|yes[ _]check|x[ _]mark|symbol[ _](support|oppose|question)",
    re.I,
)
_NOT_PICTURE = (".ogg", ".oga", ".ogv", ".webm", ".mp3", ".wav", ".mid", ".midi", ".pdf", ".djvu", ".tif", ".tiff", ".stl")


def _plain(html: str) -> str:
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", html or "")).split())


async def search_web(source: str, query: str, limit: int = 24) -> list[dict[str, Any]]:
    """Free pictures from the articles matching the query:
    [{title, thumb, url, page_url, license, author, width, height, article}]."""
    api = WIKIPEDIA_API.format(lang=source if source in WEB_SOURCES else "ru")
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": user_agent()}) as client:
        resp = await client.get(api, params={
            "action": "query", "format": "json", "formatversion": "2", "generator": "search", "gsrsearch": query,
            "gsrnamespace": "0", "gsrlimit": "8", "prop": "images", "imlimit": "max",
        })  # fmt: skip
        resp.raise_for_status()
        articles = sorted((resp.json().get("query") or {}).get("pages") or [], key=lambda p: p.get("index", 0))
        files: dict[str, str] = {}  # file title -> the article it illustrates, in the order of search relevance
        for page in articles:
            for image in page.get("images") or []:
                name = image.get("title") or ""
                if name and name not in files and not _NOISE.search(name) and not name.lower().endswith(_NOT_PICTURE):
                    files[name] = page.get("title") or ""
        if not files:
            return []
        titles = list(files)[:50]
        resp = await client.get(api, params={
            "action": "query", "format": "json", "formatversion": "2", "titles": "|".join(titles), "prop": "imageinfo",
            "iiprop": "url|size|mime|extmetadata", "iiurlwidth": "1280", "iiextmetadatafilter": "LicenseShortName|Artist|ObjectName",
        })  # fmt: skip
        resp.raise_for_status()
        rank = {t: i for i, t in enumerate(titles)}
        found = sorted((resp.json().get("query") or {}).get("pages") or [], key=lambda p: rank.get(p.get("title", ""), len(rank)))
    out, seen = [], set()
    for page in found:
        info = (page.get("imageinfo") or [{}])[0]
        big = info.get("thumburl") or info.get("url")
        if page.get("imagerepository") != "shared" or not big or not str(info.get("mime", "")).startswith("image/"):
            continue  # a non-free local file, or not a picture
        if info.get("url") in seen:
            continue  # the same file under a redirect name
        seen.add(info.get("url"))
        if min(info.get("width") or 0, info.get("height") or 0) < MIN_WEB_SIDE:
            continue
        meta = info.get("extmetadata") or {}
        title = _plain((meta.get("ObjectName") or {}).get("value", "")) or re.sub(r"^[^:]+:|\.\w+$", "", page.get("title", ""))
        out.append({
            "title": title, "thumb": big.replace("/1280px-", "/330px-"), "url": big, "page_url": info.get("descriptionurl") or "",
            "license": _plain((meta.get("LicenseShortName") or {}).get("value", "")), "author": _plain((meta.get("Artist") or {}).get("value", ""))[:300],
            "width": info.get("thumbwidth") or info.get("width") or 0, "height": info.get("thumbheight") or info.get("height") or 0,
            "article": files.get(page.get("title", ""), ""),
        })  # fmt: skip
        if len(out) >= limit:
            break
    return out


async def import_web(db: Session, course_id: int, *, image_url: str, title: str, license: str, author: str, page_url: str) -> CourseAsset:
    data, _ = await download_public(image_url, MAX_BYTES)
    name = title.strip() or image_url.rsplit("/", 1)[-1]
    asset, _ = save_image(
        db, course_id, data, filename=name[:255], source="web", title=title[:300], license=license[:120], author=author[:300],
        source_url=(page_url or image_url)[:1000],
    )  # fmt: skip
    return asset


def course_assets(db: Session, course_id: int, source: str | None = None) -> list[CourseAsset]:
    stmt = select(CourseAsset).where(CourseAsset.course_id == course_id)
    if source:
        stmt = stmt.where(CourseAsset.source == source)
    return list(db.scalars(stmt.order_by(CourseAsset.id.desc())).all())
