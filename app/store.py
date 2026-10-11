"""Reading and writing the JSON data files (collection.json, bins.json)."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from . import config

_lock = threading.Lock()
_cache: dict[Path, tuple[float, Any]] = {}


def read_json(path: Path, default: Any) -> Any:
    """Read JSON, cached until the file's mtime changes (so a nightly sync shows up without a restart)."""
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return default
    with _lock:
        hit = _cache.get(path)
        if hit and hit[0] == mtime:
            return hit[1]
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    with _lock:
        _cache[path] = (mtime, data)
    return data


def write_json(path: Path, data: Any) -> None:
    """Atomic write: a crash mid-save can never leave a half-written file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    with _lock:
        _cache.pop(path, None)


def load_collection() -> dict:
    """Returns {"synced_at": str|None, "username": str|None, "records": [...]}.
    Also accepts a bare list (hand-edited or very old files)."""
    data = read_json(config.COLLECTION_PATH, {"records": []})
    if isinstance(data, list):
        data = {"records": data}
    data.setdefault("records", [])
    return data


def save_collection(data: dict) -> None:
    write_json(config.COLLECTION_PATH, data)


def load_bins() -> dict[str, str]:
    data = read_json(config.BINS_PATH, {})
    return {str(k): str(v) for k, v in data.items() if v} if isinstance(data, dict) else {}


def set_bin(release_id: int, value: str) -> dict[str, str]:
    with _bins_lock:  # serialize read-modify-write across request threads
        bins = dict(load_bins())
        value = value.strip()[:40]
        if value:
            bins[str(release_id)] = value
        else:
            bins.pop(str(release_id), None)
        write_json(config.BINS_PATH, bins)
        return bins


_bins_lock = threading.Lock()


def load_backs() -> dict[str, int]:
    """Which Discogs photo the user picked as each release's back cover: {release_id: photo_index}."""
    data = read_json(config.BACKS_PATH, {})
    out = {}
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, int) and v > 0:
                out[str(k)] = v
    return out


def set_back(release_id: int, photo: int | None) -> dict[str, int]:
    with _bins_lock:
        backs = dict(load_backs())
        if photo:
            backs[str(release_id)] = int(photo)
        else:
            backs.pop(str(release_id), None)
        write_json(config.BACKS_PATH, backs)
        return backs
