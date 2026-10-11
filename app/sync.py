"""Command-line tools for keeping data/collection.json in step with Discogs.

    python -m app.sync                       # pull collection, fill in tracklists, download covers
    python -m app.sync --details-limit 100   # cap slow per-release lookups this run
    python -m app.sync --no-images           # metadata only
    python -m app.sync import-legacy OLD.json --images OLD_IMAGES_DIR
                                             # one-time move from the old app's files
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, images, prices, store
from .discogs import (Discogs, DiscogsError, clean_name, details_from_release, members_from_artist,
                      price_from_release, record_from_collection_item)

DETAIL_FIELDS = ("tracklist", "images", "country", "released", "notes", "price", "credits", "companies",
                 "community", "weight", "details_synced")
VARIOUS_ARTISTS_ID = 194
ARTIST_MAX_AGE_DAYS = 90


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- sync

def has_details(r: dict) -> bool:
    # Records synced by older versions lack newer fields (photo list, credits); they get
    # looked up again once.
    return bool(r.get("details_synced")) and "images" in r and "credits" in r


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
             refresh_details: bool = False, price_limit: int | None = None) -> dict:
    """Returns a summary dict: {"records", "added", "removed", "details_pending", "value"}."""
    if not client.token:
        log("WARNING: DISCOGS_TOKEN not set - only a public collection can be read, and slowly.")
    progress("Reading your collection", 0, 0)
    log(f"Fetching collection for {client.username} ...")
    fresh = [record_from_collection_item(item) for item in client.collection()]
    log(f"  {len(fresh)} items in collection")
    if not fresh:
        raise DiscogsError("Discogs returned an empty collection; refusing to overwrite local data.")

    removed = images.remove_guessed_backs()
    if removed:
        log(f"Removed {removed} back-cover file(s) guessed by an older version")

    data = store.load_collection()
    before = {str(r.get("instance_id") or r["id"]) for r in data["records"]}
    after = {str(r.get("instance_id") or r["id"]) for r in fresh}
    # imported data has no instance ids, so compare by release id the first time
    if before and not any(r.get("instance_id") for r in data["records"]):
        before, after = {str(r["id"]) for r in data["records"]}, {str(r["id"]) for r in fresh}
    added, gone = len(after - before), len(before - after)
    if before:
        log(f"  {added} new, {gone} no longer in the collection")
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
        if n % 10 == 0 or n == len(todo):
            progress("Reading release details", n, len(todo))
        if n % 25 == 0:
            store.save_collection(data)  # keep progress if interrupted
            log(f"  {n}/{len(todo)}")
    store.save_collection(data)

    # Marketplace prices: refresh a rolling batch, oldest-checked first, so the whole
    # collection is re-priced every week or so without hammering Discogs.
    limit = config.PRICE_REFRESH if price_limit is None else price_limit
    stale = sorted((r for r in records if has_details(r) and r["id"] not in seen),
                   key=lambda r: (r.get("price") or {}).get("checked") or "")
    batch = [r for r in stale if (r.get("price") or {}).get("checked") != now_iso()[:10]][:max(limit, 0)]
    if batch:
        log(f"Refreshing marketplace prices for {len(batch)} record(s) ...")
        by_id: dict[int, dict] = {}
        for n, r in enumerate(batch, 1):
            try:
                r["price"] = by_id.get(r["id"]) or price_from_release(client.release(r["id"]))
                by_id[r["id"]] = r["price"]
            except DiscogsError as exc:
                log(f"  ! price {r['id']}: {exc}")
            if n % 10 == 0 or n == len(batch):
                progress("Checking prices", n, len(batch))
            if n % 50 == 0:
                store.save_collection(data)
        store.save_collection(data)
    prices.note_prices(records)

    sync_artists(client, records)

    value = None
    try:
        value = prices.note_value(client.collection_value())
        log(f"Collection value: {value['display'].get('median')} median "
            f"({value['display'].get('minimum')} - {value['display'].get('maximum')})")
    except (DiscogsError, ValueError, KeyError) as exc:
        log(f"  ! couldn't read collection value: {exc}")

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
    colored = images.update_colors(records)
    if colored:
        log(f"Measured cover colors for {colored} record(s)")

    missing = sum(1 for r in records if not has_details(r))
    log(f"Done. {len(records)} records; {missing} still waiting on details (next run picks them up).")
    return {"records": len(records), "added": added, "removed": gone, "details_pending": missing,
            "value": (value or {}).get("display", {}).get("median")}


def sync_artists(client: Discogs, records: list[dict], limit: int | None = None) -> int:
    """Look up band members (and a person's bands) for artists in the collection, so the app can
    show who played in what. Rolling: new artists first, then ones not checked in 90 days."""
    from datetime import date
    limit = config.ARTIST_REFRESH if limit is None else limit
    cache = dict(store.read_json(config.ARTISTS_PATH, {}))
    wanted = {i for r in records for i in (r.get("artist_ids") or []) if i != VARIOUS_ARTISTS_ID}
    today = date.today()

    def age(i):
        checked = (cache.get(str(i)) or {}).get("checked")
        try:
            return (today - date.fromisoformat(checked)).days if checked else 10**6
        except ValueError:
            return 10**6
    todo = sorted((i for i in wanted if age(i) > ARTIST_MAX_AGE_DAYS), key=age, reverse=True)[:max(limit, 0)]
    if not todo:
        return 0
    log(f"Looking up band members for {len(todo)} artist(s) ...")
    done = 0
    for n, i in enumerate(todo, 1):
        try:
            cache[str(i)] = members_from_artist(client.artist(i))
            done += 1
        except DiscogsError as exc:
            log(f"  ! artist {i}: {exc}")
        if n % 10 == 0 or n == len(todo):
            progress("Looking up band members", n, len(todo))
        if n % 50 == 0:
            store.write_json(config.ARTISTS_PATH, cache)
    store.write_json(config.ARTISTS_PATH, cache)
    return done


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
    p.add_argument("--prices", type=int, default=None,
                   help=f"how many records to re-price this run (default {config.PRICE_REFRESH})")
    p.add_argument("--no-images", action="store_true", help="skip downloading cover art")
    p.add_argument("--refresh-details", action="store_true", help="re-fetch tracklists for everything")
    a = p.parse_args(argv)

    with sync_lock() as got_lock:
        if not got_lock:
            log("Another sync is already running; leaving it to finish.")
            return 0
        started = time.time()
        write_status(state="running", started_at=now_iso(), pid=os.getpid())
        try:
            summary = run_sync(Discogs(), details_limit=a.details_limit, fetch_images=not a.no_images,
                               refresh_details=a.refresh_details, price_limit=a.prices)
        except Exception as exc:  # noqa: BLE001 - report every failure to the UI
            log(f"ERROR: {exc}")
            write_status(state="failed", finished_at=now_iso(), error=str(exc)[:300])
            return 1
        log(f"Finished in {time.time() - started:.0f}s")
        write_status(state="done", finished_at=now_iso(), summary=summary)
        return 0


# --------------------------------------------------------- lock & status file

class sync_lock:
    """An exclusive lock so the nightly timer and the web 'Sync now' button never overlap."""

    def __enter__(self) -> bool:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.fh = open(config.SYNC_LOCK, "w")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            return False

    def __exit__(self, *exc) -> None:
        self.fh.close()  # closing releases the lock


def is_running() -> bool:
    if not config.SYNC_LOCK.exists():
        return False
    with open(config.SYNC_LOCK, "w") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return False
        except BlockingIOError:
            return True


def progress(phase: str, done: int, total: int) -> None:
    """Record what the sync is doing, for the progress shown in the web app. Only while the
    status file says a sync is running (so tests and one-off calls don't create one)."""
    st = read_status()
    if st.get("state") == "running":
        st["progress"] = {"phase": phase, "done": done, "total": total, "at": now_iso()}
        store.write_json(config.SYNC_STATUS, st)


def read_status() -> dict:
    st = store.read_json(config.SYNC_STATUS, {})
    return st if isinstance(st, dict) else {}


def write_status(**fields) -> None:
    st = read_status() if fields.get("state") != "running" else {}
    st.update(fields)
    store.write_json(config.SYNC_STATUS, st)


if __name__ == "__main__":
    sys.exit(main())
