"""Local image cache in data/images/.

    <release_id>-front.jpg   the primary image (photo 0); downloaded by the sync
    <release_id>-p<n>.jpg    other Discogs photos (n >= 1); downloaded the first time someone looks
    *.thumb.jpg              ~320px versions, made on demand

If an image is missing when a page asks for it, the server fetches it on the spot (when a
Discogs token is configured) and remembers failures for a while, so a dead image doesn't
trigger a request on every page view.
"""
from __future__ import annotations

import io
import threading
import time
from pathlib import Path

from . import config

EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif")
THUMB_WIDTH = 320
MISS_TTL = 7 * 24 * 3600  # retry a failed image after a week

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def key_for(photo: int) -> str:
    return "front" if photo == 0 else f"p{photo}"


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


def find_local(release_id: int, key: str) -> Path | None:
    for ext in EXTS:
        p = config.IMAGES_DIR / f"{release_id}-{key}{ext}"
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None


def _miss_marker(release_id: int, key: str) -> Path:
    return config.IMAGES_DIR / f"{release_id}-{key}.missing"


def recently_missed(release_id: int, key: str) -> bool:
    m = _miss_marker(release_id, key)
    return m.exists() and (time.time() - m.stat().st_mtime) < MISS_TTL


def mark_missing(release_id: int, key: str) -> None:
    config.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    _miss_marker(release_id, key).touch()


def save(release_id: int, key: str, content: bytes, content_type: str = "", url: str = "") -> Path:
    config.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    path = config.IMAGES_DIR / f"{release_id}-{key}{_ext_for(content_type, url)}"
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(content)
    tmp.replace(path)
    _miss_marker(release_id, key).unlink(missing_ok=True)
    return path


def download(client, release_id: int, key: str, url: str | None) -> Path | None:
    """Download one image if we know its URL. Returns the local path or None."""
    if not url:
        return None
    with _lock_for(f"{release_id}-{key}"):
        existing = find_local(release_id, key)
        if existing:
            return existing
        content, ctype = client.download(url)
        if not content:
            return None
        return save(release_id, key, content, ctype, url)


def photo_url(record: dict | None, photo: int) -> str | None:
    record = record or {}
    if photo == 0:
        return record.get("cover_url") or ((record.get("images") or [None])[0])
    imgs = record.get("images") or []
    return imgs[photo] if 0 < photo < len(imgs) else None


def ensure(client, record: dict | None, release_id: int, photo: int) -> Path | None:
    """Local path for photo N of a release, fetching it from Discogs if needed and allowed."""
    key = key_for(photo)
    found = find_local(release_id, key)
    if found or client is None or recently_missed(release_id, key):
        return found
    with _lock_for(f"{release_id}-{key}"):
        found = find_local(release_id, key)
        if found or recently_missed(release_id, key):
            return found
        try:
            url = photo_url(record, photo)
            if not url and photo == 0:  # no URL on file yet: ask Discogs for the release
                from .discogs import details_from_release
                url = details_from_release(client.release(release_id)).get("cover_url")
            if not url:
                mark_missing(release_id, key)
                return None
            content, ctype = client.download(url)
            return save(release_id, key, content, ctype, url)
        except Exception:
            mark_missing(release_id, key)
            return None


def remove_guessed_backs() -> int:
    """Delete '<id>-back.*' files left by older versions, which guessed the back cover
    (usually wrongly) as the second Discogs photo."""
    if not config.IMAGES_DIR.is_dir():
        return 0
    n = 0
    for p in config.IMAGES_DIR.glob("*-back*"):
        p.unlink(missing_ok=True)
        n += 1
    return n


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


def dominant_color(src: Path) -> str | None:
    """A representative color for a cover (used to paint record spines on the shelves page)."""
    try:
        from PIL import Image
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((48, 48))
            # middle-ish of the palette: quantize, take the most common non-extreme color
            pal = im.quantize(colors=5, method=Image.Quantize.MEDIANCUT)
            counts = sorted(pal.getcolors() or [], reverse=True)
            palette = pal.getpalette()
            for _, idx in counts:
                r, g, b = palette[idx * 3: idx * 3 + 3]
                if 24 < (r + g + b) / 3 < 235:
                    return f"#{r:02x}{g:02x}{b:02x}"
            _, idx = counts[0]
            r, g, b = palette[idx * 3: idx * 3 + 3]
            return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        return None


def update_colors(records: list[dict]) -> int:
    """Fill data/colors.json for covers that don't have a color yet. Returns how many were added."""
    from . import store
    colors = dict(store.read_json(config.COLORS_PATH, {}))
    added = 0
    for r in records:
        key = str(r["id"])
        if key in colors:
            continue
        src = find_local(r["id"], "front")
        if src:
            c = dominant_color(src)
            if c:
                colors[key] = c
                added += 1
    if added:
        store.write_json(config.COLORS_PATH, colors)
    return added
