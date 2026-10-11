"""Command-line tools for keeping data/collection.json in step with Discogs.

    python -m app.sync                       # pull collection, fill in tracklists, download covers
    python -m app.sync --details-limit 100   # cap slow per-release lookups this run
    python -m app.sync --no-images           # metadata only
    python -m app.sync import-legacy OLD.json --images OLD_IMAGES_DIR
                                             # one-time move from the old app's files
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, images, store
from .discogs import Discogs, DiscogsError, clean_name, details_from_release, record_from_collection_item

DETAIL_FIELDS = ("tracklist", "images", "country", "released", "notes", "details_synced")


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- sync

def has_details(r: dict) -> bool:
    # Records synced by older versions lack the full photo list; they get looked up again once.
    return bool(r.get("details_synced")) and "images" in r


def merge(fresh: list[dict], previous: list[dict]) -> list[dict]:
    """Fresh collection metadata wins; per-release details we already fetched are kept."""
    known = {}
    for r in previous:
        if has_details(r):
            known.setdefault(int(r["id"]), r)
    out = []
    for r in fresh:
        old = known.get(r["id"])
        if old:
            for f in DETAIL_FIELDS:
                if f in old:
                    r[f] = old[f]
            if old.get("cover_url") and not r.get("cover_url"):
                r["cover_url"] = old["cover_url"]
        out.append(r)
    return out


def run_sync(client: Discogs, *, details_limit: int | None, fetch_images: bool,
             refresh_details: bool = False) -> dict:
    if not client.token:
        log("WARNING: DISCOGS_TOKEN not set - only a public collection can be read, and slowly.")
    log(f"Fetching collection for {client.username} ...")
    fresh = [record_from_collection_item(item) for item in client.collection()]
    log(f"  {len(fresh)} items in collection")
    if not fresh:
        raise DiscogsError("Discogs returned an empty collection; refusing to overwrite local data.")

    removed = images.remove_guessed_backs()
    if removed:
        log(f"Removed {removed} back-cover file(s) guessed by an older version")

    data = store.load_collection()
    records = merge(fresh, [] if refresh_details else data["records"])
    data.update(records=records, username=client.username, synced_at=now_iso())
    store.save_collection(data)

    # Per-release details (tracklist, all photos). One request each, so do them incrementally.
    todo = [r for r in records if not has_details(r)]
    seen: dict[int, dict] = {}
    if details_limit is not None:
        todo = todo[:details_limit]
    log(f"Fetching release details for {len(todo)} record(s) ...")
    for n, r in enumerate(todo, 1):
        try:
            det = seen.get(r["id"]) or details_from_release(client.release(r["id"]))
            seen[r["id"]] = det  # several copies of one release share a lookup
            r.update({k: v for k, v in det.items() if k != "cover_url"})
            if det.get("cover_url") and not r.get("cover_url"):
                r["cover_url"] = det["cover_url"]
        except DiscogsError as exc:
            log(f"  ! {r['id']} {r['artist']} - {r['title']}: {exc}")
        if n % 25 == 0:
            store.save_collection(data)  # keep progress if interrupted
            log(f"  {n}/{len(todo)}")
    store.save_collection(data)

    if fetch_images:
        got = failed = 0
        for r in records:
            # Only the front is fetched ahead of time; other photos load when a record is opened.
            if images.find_local(r["id"], "front") or not r.get("cover_url"):
                continue
            try:
                if images.download(client, r["id"], "front", r["cover_url"]):
                    got += 1
            except DiscogsError as exc:
                failed += 1
                log(f"  ! image {r['id']}: {exc}")
        log(f"Downloaded {got} image(s), {failed} failed")

    missing = sum(1 for r in records if not has_details(r))
    log(f"Done. {len(records)} records; {missing} still waiting on details (next run picks them up).")
    return data


# --------------------------------------------------------------- legacy import

def legacy_to_record(old: dict) -> dict | None:
    """Convert one record from the old app's collection.json."""
    rid = old.get("id")
    if not rid:
        return None
    genre = old.get("genre")
    genres = genre if isinstance(genre, list) else [g.strip() for g in str(genre or "").split("|") if g.strip()]
    tracks = []
    for t in old.get("tracklist") or []:
        tracks.append(t if isinstance(t, dict) else {"position": "", "title": str(t), "duration": ""})
    return {
        "id": int(rid),
        "instance_id": None,
        "title": old.get("title") or "",
        "artist": ", ".join(clean_name(a) for a in str(old.get("artist") or "").split(", ")),
        "year": old.get("year") or None,
        "label": clean_name(old.get("label") or ""),
        "catno": "",
        "format": old.get("format") or "",
        "format_detail": "",
        "qty": 1,
        "genres": genres,
        "styles": [],
        "date_added": old.get("date_added"),
        "rating": 0,
        "cover_url": None,
        "tracklist": tracks,
    }


def import_legacy(src: Path, images_dir: Path | None, bins_file: Path | None) -> dict:
    raw = json.loads(src.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        raw = next((raw[k] for k in ("records", "collection", "items") if isinstance(raw.get(k), list)), [])
    records = [r for r in (legacy_to_record(o) for o in raw) if r]
    data = {"records": records, "synced_at": None, "username": config.DISCOGS_USERNAME or None,
            "imported_from": str(src), "imported_at": now_iso()}
    store.save_collection(data)
    log(f"Imported {len(records)} records from {src}")

    if images_dir and images_dir.is_dir():
        copied = 0
        config.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        for r in records:
            rid = r["id"]
            for side, names in (("front", (f"{rid}", f"cover_{rid}")),):
                if images.find_local(rid, side):
                    continue
                for stem in names:
                    hit = next((images_dir / f"{stem}{e}" for e in images.EXTS if (images_dir / f"{stem}{e}").is_file()), None)
                    if hit:
                        ext = ".jpg" if hit.suffix.lower() == ".jpeg" else hit.suffix.lower()
                        shutil.copy2(hit, config.IMAGES_DIR / f"{rid}-{side}{ext}")
                        copied += 1
                        break
        log(f"Copied {copied} cover image(s) from {images_dir}")

    if bins_file and bins_file.is_file():
        old_bins = json.loads(bins_file.read_text(encoding="utf-8"))
        bins = {str(k): str(v) for k, v in old_bins.items() if v}
        if bins:
            store.write_json(config.BINS_PATH, {**store.load_bins(), **bins})
        log(f"Imported {len(bins)} bin location(s)")
    return data


# ------------------------------------------------------------------------ CLI

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "import-legacy":
        p = argparse.ArgumentParser(prog="python -m app.sync import-legacy")
        p.add_argument("collection_json", type=Path)
        p.add_argument("--images", type=Path, help="old images folder, e.g. backend/static/images")
        p.add_argument("--bins", type=Path, help="old bin_store.json")
        a = p.parse_args(argv[1:])
        import_legacy(a.collection_json, a.images, a.bins)
        return 0

    p = argparse.ArgumentParser(prog="python -m app.sync", description="Sync your Discogs collection.")
    p.add_argument("--details-limit", type=int, default=None,
                   help="max per-release lookups this run (each takes ~1s)")
    p.add_argument("--no-images", action="store_true", help="skip downloading cover art")
    p.add_argument("--refresh-details", action="store_true", help="re-fetch tracklists for everything")
    a = p.parse_args(argv)
    try:
        started = time.time()
        run_sync(Discogs(), details_limit=a.details_limit, fetch_images=not a.no_images,
                 refresh_details=a.refresh_details)
        log(f"Finished in {time.time() - started:.0f}s")
        return 0
    except DiscogsError as exc:
        log(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
