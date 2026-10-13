"""Fetch course material by URL (PDF / HTML / text) with basic SSRF protection."""

import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from ..config import settings
from .materials import extract_text

MAX_BYTES = 40 * 1024 * 1024


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "svg", "form", "aside"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "pre", "blockquote"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BLOCK:
            self.parts.append("\n")
        if tag in ("h1", "h2", "h3"):
            self.parts.append("# ")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self._in_title = False
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    p = _TextExtractor()
    p.feed(html)
    text = re.sub(r"[ \t]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()
    return p.title.strip(), text


def _check_public(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Нужна ссылка http(s)://")
    for info in socket.getaddrinfo(parsed.hostname, None):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError("Ссылки на внутренние адреса запрещены")


async def fetch_material(url: str) -> tuple[str, str]:
    """Returns (filename/title, text)."""
    _check_public(url)
    contact = f"; {settings.fetch_contact}" if settings.fetch_contact else ""
    user_agent = f"MerakiCourseImporter/0.1 (+{settings.public_url}{contact}) httpx/{httpx.__version__}"
    async with httpx.AsyncClient(follow_redirects=False, timeout=60, headers={"User-Agent": user_agent}) as client:
        for _ in range(5):  # follow redirects manually, re-checking each hop
            resp = await client.get(url)
            if resp.is_redirect:
                url = str(resp.next_request.url) if resp.next_request else ""
                _check_public(url)
                continue
            break
        resp.raise_for_status()
        data = resp.content[:MAX_BYTES]
    ctype = resp.headers.get("content-type", "").lower()
    name = urlparse(url).path.rsplit("/", 1)[-1] or urlparse(url).hostname or "material"
    if "pdf" in ctype or name.lower().endswith(".pdf"):
        return name if name.lower().endswith(".pdf") else name + ".pdf", extract_text("x.pdf", data)
    if "html" in ctype:
        title, text = html_to_text(data.decode(resp.encoding or "utf-8", errors="replace"))
        return (title or name)[:200], text
    return name, extract_text(name if "." in name else name + ".txt", data)
