"""Web server: the JSON API, cover images, and the static frontend in web/."""
from __future__ import annotations

import subprocess
import sys
import threading

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from . import config, images, prices, shelves, store, sync
from .discogs import Discogs


def _client():
    if config.FETCH_MISSING_IMAGES and config.DISCOGS_TOKEN:
        return Discogs()
    return None


def public_record(r: dict, bins: dict[str, str], backs: dict[str, int]) -> dict:
    rid = int(r["id"])
    genres = r.get("genres") or ([r["genre"]] if r.get("genre") else [])
    photos = max(len(r.get("images") or []), 1)
    back = backs.get(str(rid))
    return {
        "id": rid,
        "uid": str(r.get("instance_id") or rid),
        "title": r.get("title") or "(untitled)",
        "artist": r.get("artist") or "Unknown Artist",
        "year": r.get("year") or None,
        "label": r.get("label") or "",
        "catno": r.get("catno") or "",
        "format": r.get("format") or "",
        "format_detail": r.get("format_detail") or "",
        "genres": genres,
        "styles": r.get("styles") or [],
        "date_added": r.get("date_added"),
        "rating": r.get("rating") or 0,
        "country": r.get("country") or "",
        "released": r.get("released") or "",
        "tracklist": r.get("tracklist") or [],
        "photos": photos,                                   # how many Discogs photos exist (>= 1)
        "back": back if back and back < photos else None,   # photo index chosen as the back cover
        "bin": bins.get(str(rid), ""),
        "price": r.get("price") or None,                    # lowest marketplace listing
    }


_sync_guard = threading.Lock()


def _sync_state() -> dict:
    st = sync.read_status()
    running = sync.is_running()
    tail = []
    if config.SYNC_LOG.exists():
        tail = config.SYNC_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-6:]
    return {"running": running, "state": "running" if running else st.get("state"), "started_at": st.get("started_at"),
            "finished_at": st.get("finished_at"), "summary": st.get("summary"), "error": st.get("error"),
            "log": tail, "synced_at": store.load_collection().get("synced_at")}


def _find(release_id: int) -> dict | None:
    return next((r for r in store.load_collection()["records"] if r.get("id") == release_id), None)


def _check_edit() -> None:
    if config.EDIT_TOKEN and request.headers.get("X-Edit-Token") != config.EDIT_TOKEN:
        abort(403)


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json.sort_keys = False

    @app.get("/")
    def index():
        resp = send_from_directory(config.WEB_DIR, "index.html")
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.get("/assets/<path:filename>")
    def assets(filename: str):
        resp = send_from_directory(config.WEB_DIR / "assets", filename)
        resp.headers["Cache-Control"] = "no-cache"  # tiny files; always pick up edits
        return resp

    @app.get("/api/health")
    def health():
        data = store.load_collection()
        return jsonify(ok=True, records=len(data["records"]), synced_at=data.get("synced_at"))

    @app.get("/api/collection")
    def collection():
        data = store.load_collection()
        bins = store.load_bins()
        backs = store.load_backs()
        records, seen = [], {}
        for r in data["records"]:
            if not r.get("id"):
                continue
            rec = public_record(r, bins, backs)
            n = seen[rec["uid"]] = seen.get(rec["uid"], 0) + 1
            if n > 1:  # second copy of the same release (imported data has no instance ids)
                rec["uid"] = f"{rec['uid']}-{n}"
            records.append(rec)
        return jsonify(
            records=records,
            synced_at=data.get("synced_at"),
            username=data.get("username") or config.DISCOGS_USERNAME or None,
            can_edit=not config.EDIT_TOKEN,
            can_sync=bool(config.DISCOGS_TOKEN and config.DISCOGS_USERNAME),
            currency=config.CURRENCY,
            value_history=prices.load_value_history(),
            colors=store.read_json(config.COLORS_PATH, {}),
        )

    # ---- sync -----------------------------------------------------------------
    @app.get("/api/sync")
    def sync_status():
        return jsonify(_sync_state())

    @app.post("/api/sync")
    def start_sync():
        _check_edit()
        if not (config.DISCOGS_TOKEN and config.DISCOGS_USERNAME):
            return jsonify(error="Add DISCOGS_USERNAME and DISCOGS_TOKEN to .env first."), 400
        with _sync_guard:
            if sync.is_running():
                return jsonify(_sync_state()), 409
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            log = open(config.SYNC_LOG, "w")
            proc = subprocess.Popen([sys.executable, "-m", "app.sync"], cwd=config.ROOT,
                                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            threading.Thread(target=proc.wait, daemon=True).start()  # reap it when it exits
            log.close()
        return jsonify({**_sync_state(), "running": True}), 202

    # ---- prices ---------------------------------------------------------------
    @app.get("/api/prices/<int:release_id>")
    def price_history(release_id: int):
        return jsonify(history=prices.load_price_history().get(str(release_id), []), currency=config.CURRENCY)

    # ---- shelves --------------------------------------------------------------
    @app.get("/api/shelves")
    def get_shelves():
        return jsonify(shelves.load())

    @app.put("/api/shelves")
    def put_shelves():
        _check_edit()
        try:
            return jsonify(shelves.save(request.get_json(silent=True)))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400

    @app.put("/api/bins/<int:release_id>")
    def put_bin(release_id: int):
        _check_edit()
        body = request.get_json(silent=True) or {}
        value = body.get("bin", "")
        if not isinstance(value, str):
            abort(400)
        bins = store.set_bin(release_id, value)
        return jsonify(id=release_id, bin=bins.get(str(release_id), ""))

    @app.put("/api/backs/<int:release_id>")
    def put_back(release_id: int):
        """Body {"photo": n} marks Discogs photo n as the back cover; {"photo": null} clears it."""
        _check_edit()
        record = _find(release_id)
        if record is None:
            abort(404)
        photo = (request.get_json(silent=True) or {}).get("photo")
        photos = len(record.get("images") or [])
        if photo is not None and (not isinstance(photo, int) or isinstance(photo, bool) or not 0 < photo < photos):
            abort(400)
        backs = store.set_back(release_id, photo)
        return jsonify(id=release_id, back=backs.get(str(release_id)))

    @app.get("/img/<int:release_id>/<which>")
    def image(release_id: int, which: str):
        """which: "front", "back" (the chosen back cover), or a photo number 0..n-1."""
        record = _find(release_id)
        if record is None:
            abort(404)
        if which == "front":
            photo = 0
        elif which == "back":
            photo = store.load_backs().get(str(release_id))
            if not photo:
                abort(404)
        elif which.isdigit():
            photo = int(which)
            if photo > 0 and photo >= len(record.get("images") or []):
                abort(404)
        else:
            abort(404)
        path = images.ensure(_client(), record, release_id, photo)
        if path is None:
            abort(404)
        if request.args.get("size") == "thumb":
            path = images.thumbnail(path)
        return send_file(path, max_age=0 if which == "back" else 30 * 24 * 3600, conditional=True)

    return app


app = create_app()

if __name__ == "__main__":
    import os
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
