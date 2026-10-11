"""Price history: the collection's value over time, and each record's lowest marketplace price."""
from __future__ import annotations

from datetime import date

from . import config, store
from .discogs import parse_money

MAX_POINTS = 120         # per-record history length
RECORD_EVERY_DAYS = 7    # keep a point at least weekly even when the price hasn't moved


def note_value(raw: dict, today: str | None = None) -> dict:
    """Store today's collection value (one entry per day; a later sync the same day replaces it)."""
    today = today or date.today().isoformat()
    entry = {
        "date": today,
        "minimum": parse_money(raw.get("minimum")),
        "median": parse_money(raw.get("median")),
        "maximum": parse_money(raw.get("maximum")),
        "display": {k: raw.get(k) for k in ("minimum", "median", "maximum")},
    }
    hist = [h for h in load_value_history() if h.get("date") != today]
    hist.append(entry)
    hist.sort(key=lambda h: h["date"])
    store.write_json(config.VALUE_PATH, hist)
    return entry


def load_value_history() -> list[dict]:
    data = store.read_json(config.VALUE_PATH, [])
    return data if isinstance(data, list) else []


def load_price_history() -> dict[str, list]:
    data = store.read_json(config.PRICES_PATH, {})
    return data if isinstance(data, dict) else {}


def note_prices(records: list[dict]) -> None:
    """Append each record's current lowest price to its history when it changed (or weekly)."""
    hist = dict(load_price_history())
    changed = False
    for r in records:
        p = r.get("price") or {}
        if not p.get("checked"):
            continue
        key = str(r["id"])
        points = list(hist.get(key, []))
        point = [p["checked"], p.get("lowest"), p.get("for_sale", 0)]
        if points:
            last = points[-1]
            if last[0] == point[0]:
                points[-1] = point
            elif last[1] == point[1] and _days_between(last[0], point[0]) < RECORD_EVERY_DAYS:
                continue
            else:
                points.append(point)
        else:
            points.append(point)
        hist[key] = points[-MAX_POINTS:]
        changed = True
    if changed:
        store.write_json(config.PRICES_PATH, hist)


def _days_between(a: str, b: str) -> int:
    try:
        return abs((date.fromisoformat(b) - date.fromisoformat(a)).days)
    except ValueError:
        return 999
