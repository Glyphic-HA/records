"""Local cover-art cache: data/images/<release_id>-front.jpg, -back.jpg, plus small thumbnails.

Covers are normally downloaded by the nightly sync. If one is missing when a page asks
for it, the server fetches it on the spot (when a Discogs token is configured) and
remembers failures for a while so a dead image doesn't trigger a request every page view.
"""
from __future__ import annotations

import io
import threading
import time
from pathlib import Path

from . import config

SIDES = ("front", "back")
EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
THUMB_WIDTH = 320
MISS_TTL = 7 * 24 * 3600  # retry a failed image after a week

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def _ext_for(content_type: str, url: str = "") -> str:
    ct = content_type.lower()
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    if "gif" in ct:
        return ".gif"
    for ext in EXTS:
        if url.lower().split("?")[0].endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ".jpg"


def find_local(release_id: int, side: str) -> Path | None:
    for ext in EXTS:
        p = config.IMAGES_DIR / f"{release_id}-{side}{ext}"
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def _miss_marker(release_id: int, side: str) -> Path:
    return config.IMAGES_DIR / f"{release_id}-{side}.missing"


def recently_missed(release_id: int, side: str) -> bool:
    m = _miss_marker(release_id, side)
    return m.exists() and (time.time() - m.stat().st_mtime) < MISS_TTL


def mark_missing(release_id: int, side: str) -> None:
    config.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    _miss_marker(release_id, side).touch()


def save(release_id: int, side: str, content: bytes, content_type: str = "", url: str = "") -> Path:
    config.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    path = config.IMAGES_DIR / f"{release_id}-{side}{_ext_for(content_type, url)}"
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(content)
    tmp.replace(path)
    _miss_marker(release_id, side).unlink(missing_ok=True)
    return path


def download(client, release_id: int, side: str, url: str | None) -> Path | None:
    """Download one image if we know its URL. Returns the local path or None."""
    if not url:
        return None
    with _lock_for(f"{release_id}-{side}"):
        existing = find_local(release_id, side)
        if existing:
            return existing
        content, ctype = client.download(url)
        if not content:
            return None
        return save(release_id, side, content, ctype, url)


def ensure(client, record: dict | None, release_id: int, side: str) -> Path | None:
    """Local path for this image, fetching it from Discogs if needed and allowed."""
    found = find_local(release_id, side)
    if found or client is None or recently_missed(release_id, side):
        return found
    with _lock_for(f"{release_id}-{side}"):
        found = find_local(release_id, side)
        if found or recently_missed(release_id, side):
            return found
        try:
            url = (record or {}).get("cover_url" if side == "front" else "back_url")
            if not url and (side == "front" or not (record or {}).get("details_synced")):
                from .discogs import details_from_release
                url = details_from_release(client.release(release_id)).get(f"{'cover' if side == 'front' else 'back'}_url")
            if not url:
                mark_missing(release_id, side)
                return None
            content, ctype = client.download(url)
            return save(release_id, side, content, ctype, url)
        except Exception:
            mark_missing(release_id, side)
            return None


def thumbnail(src: Path) -> Path:
    """A ~320px wide JPEG beside the original, made once. Falls back to the original if Pillow is missing."""
    thumb = src.with_name(src.stem + ".thumb.jpg")
    if thumb.exists() and thumb.stat().st_mtime >= src.stat().st_mtime:
        return thumb
    try:
        from PIL import Image
    except ImportError:
        return src
    try:
        with Image.open(src) as im:
            im = im.convert("RGB")
            if im.width > THUMB_WIDTH:
                im.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 4))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=82, optimize=True, progressive=True)
        tmp = thumb.with_suffix(".part")
        tmp.write_bytes(buf.getvalue())
        tmp.replace(thumb)
        return thumb
    except Exception:
        return src
