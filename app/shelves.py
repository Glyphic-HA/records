"""Shelf layout (data/shelves.json): the physical units, their cubbies, and alphabetical filing.

Cubbies are numbered as bins 1..N reading the whole wall like a page: units stand side by side
on the floor (bottom-aligned), so a unit's rows line up with its neighbours' by height. Each
wall row is read left to right across every unit, top row first. With the default layout:

    1  2
    3  4    5  6  7  8
    9 10   11 12 13 14
   15 16   17 18 19 20
"stacks" are extra spots that aren't cubbies, like records standing on top of a unit. A stack
with "new": true is the new-arrivals pile: records added to Discogs after "arrivals_since" go
there until you mark the pile as shelved (which moves "arrivals_since" forward).
"starts" maps a cubby to the first artist filed in it; every record without a hand-set bin
lands in the cubby whose start is the closest one at or before its artist (see web/assets/app.js).
"""
from __future__ import annotations

import re

from . import config, store

# Matches the photo: a 2x4 unit on the left, a 4x3 unit on the right, records standing on top of it.
DEFAULT = {
    "units": [
        {"id": "A", "name": "Left shelf", "cols": 2, "rows": 4},
        {"id": "B", "name": "Right shelf", "cols": 4, "rows": 3},
    ],
    "stacks": [
        {"label": "New", "name": "New arrivals", "unit": "B", "from_col": 1, "to_col": 1, "new": True},
    ],
    "starts": {},
    "arrivals_since": None,
}

_ID = re.compile(r"^[A-Za-z0-9]{1,3}$")


def cubby_labels(units: list[dict]) -> list[str]:
    total = sum(u["cols"] * u["rows"] for u in units)
    return [str(n) for n in range(1, total + 1)]


def numbering(units: list[dict]) -> list[list[int]]:
    """Bin number of each cubby, per unit, in the unit's own row-major order.
    Mirrors cubbyNumbers() in web/assets/app.js."""
    out = [[0] * (u["cols"] * u["rows"]) for u in units]
    tallest = max(u["rows"] for u in units)
    n = 1
    for level in range(tallest - 1, -1, -1):          # height above the floor, top first
        for ui, u in enumerate(units):
            r = u["rows"] - 1 - level                  # this unit's row at that height
            if r < 0:
                continue
            for c in range(u["cols"]):
                out[ui][r * u["cols"] + c] = n
                n += 1
    return out


def labels(layout: dict) -> list[str]:
    return cubby_labels(layout["units"]) + [s["label"] for s in layout.get("stacks", [])]


def _migrate_start_key(key: str, units: list[dict]) -> str:
    """Older layouts named cubbies A1..A8, B1..B12; map those onto the 1..N numbering."""
    m = re.match(r"^([A-Za-z0-9]{1,3}?)(\d+)$", key)
    if not m or key.isdigit():
        return key
    nums = numbering(units)
    for ui, u in enumerate(units):
        if u["id"] == m.group(1):
            n = int(m.group(2))
            return str(nums[ui][n - 1]) if 1 <= n <= u["cols"] * u["rows"] else key
    return key


def default() -> dict:
    # Start the new-arrivals pile empty: only records added from now on land there.
    from datetime import datetime, timezone
    return validate({**DEFAULT, "arrivals_since": datetime.now(timezone.utc).isoformat(timespec="seconds")})


def load() -> dict:
    data = store.read_json(config.SHELVES_PATH, None)
    if not isinstance(data, dict):
        layout = default()
        store.write_json(config.SHELVES_PATH, layout)  # pin the new-arrivals start date
        return layout
    try:
        return validate(data)
    except ValueError:
        return default()


def save(data) -> dict:
    layout = validate(data)
    store.write_json(config.SHELVES_PATH, layout)
    return layout


def validate(data) -> dict:
    if not isinstance(data, dict):
        raise ValueError("expected an object")
    units = []
    seen = set()
    for u in data.get("units") or []:
        uid = str(u.get("id", ""))
        if not _ID.match(uid) or uid in seen:
            raise ValueError(f"bad or duplicate unit id: {uid!r}")
        cols, rows = int(u.get("cols", 0)), int(u.get("rows", 0))
        if not (1 <= cols <= 12 and 1 <= rows <= 12):
            raise ValueError(f"unit {uid}: cols and rows must be 1-12")
        seen.add(uid)
        units.append({"id": uid, "name": str(u.get("name") or f"Shelf {uid}")[:40], "cols": cols, "rows": rows})
    if not units:
        raise ValueError("at least one unit is needed")
    stacks = []
    for st in data.get("stacks") or []:
        label = str(st.get("label", "")).strip()[:12]
        unit = next((u for u in units if u["id"] == st.get("unit")), None)
        if not label or unit is None:
            raise ValueError("each stack needs a label and an existing unit")
        c1 = max(1, min(int(st.get("from_col", 1)), unit["cols"]))
        c2 = max(c1, min(int(st.get("to_col", c1)), unit["cols"]))
        stacks.append({"label": label, "name": str(st.get("name") or label)[:40], "unit": unit["id"],
                       "from_col": c1, "to_col": c2, "new": bool(st.get("new"))})
    if sum(st["new"] for st in stacks) > 1:
        raise ValueError("only one stack can be the new-arrivals pile")
    layout = {"units": units, "stacks": stacks}
    known = set(labels(layout))
    starts = {}
    for k, v in (data.get("starts") or {}).items():
        k = _migrate_start_key(str(k), units)
        v = str(v or "").strip()[:80]
        if k in known and v:
            starts[k] = v
    layout["starts"] = starts
    since = data.get("arrivals_since")
    if since is not None and not re.match(r"^\d{4}-\d{2}-\d{2}", str(since)):
        raise ValueError("arrivals_since must be an ISO date")
    layout["arrivals_since"] = str(since) if since else None
    return layout
