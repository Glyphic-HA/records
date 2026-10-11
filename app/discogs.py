"""Small Discogs API client that respects the rate limit (60 req/min with a token)."""
from __future__ import annotations

import re
import time
from typing import Iterator

import requests

from . import config

API = "https://api.discogs.com"


class DiscogsError(RuntimeError):
    pass


class Discogs:
    def __init__(self, token: str | None = None, username: str | None = None,
                 user_agent: str | None = None, session: requests.Session | None = None,
                 sleep=time.sleep):
        self.token = config.DISCOGS_TOKEN if token is None else token
        self.username = config.DISCOGS_USERNAME if username is None else username
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = user_agent or config.DISCOGS_USER_AGENT
        if self.token:
            self.session.headers["Authorization"] = f"Discogs token={self.token}"
        self._sleep = sleep

    # -- low level ---------------------------------------------------------
    def get(self, url: str, *, params: dict | None = None, attempts: int = 5) -> requests.Response:
        if url.startswith("/"):
            url = API + url
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                resp = self.session.get(url, params=params, timeout=30)
            except requests.RequestException as exc:  # network blip: back off and retry
                last = exc
                self._sleep(min(2 ** attempt, 30))
                continue
            if resp.status_code == 429:
                wait = float(resp.headers.get("Retry-After") or 60)
                self._sleep(max(wait, 5))
                continue
            if resp.status_code >= 500:
                last = DiscogsError(f"{resp.status_code} from Discogs for {url}")
                self._sleep(min(2 ** attempt, 30))
                continue
            if resp.status_code >= 400:
                raise DiscogsError(f"{resp.status_code} from Discogs for {url}: {resp.text[:200]}")
            self._throttle(resp)
            return resp
        raise DiscogsError(f"Giving up on {url}: {last}")

    def _throttle(self, resp: requests.Response) -> None:
        """Slow down as the per-minute budget runs low instead of slamming into 429s."""
        try:
            remaining = int(resp.headers.get("X-Discogs-Ratelimit-Remaining", "10"))
        except ValueError:
            return
        if remaining <= 2:
            self._sleep(20)
        elif remaining <= 8:
            self._sleep(2)

    # -- endpoints ---------------------------------------------------------
    def collection(self, per_page: int = 100) -> Iterator[dict]:
        """Every release in the user's collection ("All" folder), newest first."""
        if not self.username:
            raise DiscogsError("DISCOGS_USERNAME is not set")
        page, pages = 1, 1
        while page <= pages:
            data = self.get(
                f"/users/{self.username}/collection/folders/0/releases",
                params={"page": page, "per_page": per_page, "sort": "added", "sort_order": "desc"},
            ).json()
            pages = data.get("pagination", {}).get("pages", 1) or 1
            yield from data.get("releases", [])
            page += 1

    def release(self, release_id: int) -> dict:
        return self.get(f"/releases/{release_id}").json()

    def download(self, url: str) -> tuple[bytes, str]:
        resp = self.get(url)
        return resp.content, resp.headers.get("Content-Type", "")


# -- shaping Discogs payloads into our record format -------------------------

_DISAMBIG = re.compile(r"\s\(\d+\)$")


def clean_name(name: str) -> str:
    """'Nirvana (2)' -> 'Nirvana'; 'Beatles, The' -> 'The Beatles'."""
    name = _DISAMBIG.sub("", (name or "").strip())
    if name.endswith(", The"):
        name = "The " + name[:-5]
    return name


def artist_credit(artists: list[dict]) -> str:
    out = ""
    for i, a in enumerate(artists or []):
        out += clean_name(a.get("anv") or a.get("name", ""))
        join = (a.get("join") or "").strip()
        if i < len(artists) - 1:
            out += f" {join} " if join and join != "," else ", "
    return out.strip() or "Unknown Artist"


def record_from_collection_item(item: dict) -> dict:
    info = item.get("basic_information", {})
    formats = info.get("formats") or []
    labels = info.get("labels") or []
    fmt = formats[0] if formats else {}
    details = [d for f in formats for d in (f.get("descriptions") or [])]
    cover = info.get("cover_image") or ""
    if "spacer.gif" in cover:  # Discogs placeholder for releases without art
        cover = ""
    return {
        "id": int(info.get("id") or item.get("id")),
        "instance_id": item.get("instance_id"),
        "title": (info.get("title") or "").strip(),
        "artist": artist_credit(info.get("artists") or []),
        "year": info.get("year") or None,
        "label": clean_name(labels[0]["name"]) if labels else "",
        "catno": (labels[0].get("catno") or "") if labels else "",
        "format": fmt.get("name", ""),
        "format_detail": ", ".join(dict.fromkeys(details)),
        "qty": int(fmt.get("qty") or 1) if str(fmt.get("qty", "1")).isdigit() else 1,
        "genres": info.get("genres") or [],
        "styles": info.get("styles") or [],
        "date_added": item.get("date_added"),
        "rating": item.get("rating") or 0,
        "cover_url": cover or None,
    }


def details_from_release(rel: dict) -> dict:
    tracks = []
    for t in rel.get("tracklist") or []:
        if t.get("type_", "track") not in ("track", "index"):
            continue  # skip headings ("Side A")
        tracks.append({
            "position": t.get("position", ""),
            "title": t.get("title", ""),
            "duration": t.get("duration", ""),
        })
    # Discogs doesn't label images beyond "primary"/"secondary", and uploaders add them in any
    # order, so we keep every photo (primary first) and let the user say which one is the back.
    imgs = [i for i in (rel.get("images") or []) if i.get("uri")]
    imgs.sort(key=lambda i: i.get("type") != "primary")  # stable: primary first, rest in Discogs order
    return {
        "tracklist": tracks,
        "cover_url": imgs[0]["uri"] if imgs else None,
        "images": [i["uri"] for i in imgs],
        "country": rel.get("country") or "",
        "released": rel.get("released") or "",
        "notes": (rel.get("notes") or "").strip()[:2000],
        "details_synced": True,
    }
