"""Web server: the JSON API, cover images, and the static frontend in web/."""
from __future__ import annotations

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from . import config, images, store
from .discogs import Discogs


def _client():
    if config.FETCH_MISSING_IMAGES and config.DISCOGS_TOKEN:
        return Discogs()
    return None


def public_record(r: dict, bins: dict[str, str]) -> dict:
    rid = int(r["id"])
    genres = r.get("genres") or ([r["genre"]] if r.get("genre") else [])
    has_back = bool(r.get("back_url")) or images.find_local(rid, "back") is not None
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
        "has_back": has_back,
        "bin": bins.get(str(rid), ""),
    }


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
        records, seen = [], {}
        for r in data["records"]:
            if not r.get("id"):
                continue
            rec = public_record(r, bins)
            n = seen[rec["uid"]] = seen.get(rec["uid"], 0) + 1
            if n > 1:  # second copy of the same release (imported data has no instance ids)
                rec["uid"] = f"{rec['uid']}-{n}"
            records.append(rec)
        return jsonify(
            records=records,
            synced_at=data.get("synced_at"),
            username=data.get("username") or config.DISCOGS_USERNAME or None,
            can_edit=not config.EDIT_TOKEN,
        )

    @app.put("/api/bins/<int:release_id>")
    def put_bin(release_id: int):
        if config.EDIT_TOKEN and request.headers.get("X-Edit-Token") != config.EDIT_TOKEN:
            abort(403)
        body = request.get_json(silent=True) or {}
        value = body.get("bin", "")
        if not isinstance(value, str):
            abort(400)
        bins = store.set_bin(release_id, value)
        return jsonify(id=release_id, bin=bins.get(str(release_id), ""))

    @app.get("/img/<int:release_id>/<side>")
    def image(release_id: int, side: str):
        if side not in images.SIDES:
            abort(404)
        record = next((r for r in store.load_collection()["records"] if r.get("id") == release_id), None)
        if record is None:
            abort(404)
        path = images.ensure(_client(), record, release_id, side)
        if path is None:
            abort(404)
        if request.args.get("size") == "thumb":
            path = images.thumbnail(path)
        resp = send_file(path, max_age=30 * 24 * 3600, conditional=True)
        return resp

    return app


app = create_app()

if __name__ == "__main__":
    import os
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
