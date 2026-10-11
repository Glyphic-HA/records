"""Settings, read from the environment (and an optional .env file at the repo root)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines, # comments, optional quotes.
    Real environment variables always win over the file."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.environ.get("RC_DATA_DIR", ROOT / "data")).resolve()
IMAGES_DIR = DATA_DIR / "images"
COLLECTION_PATH = DATA_DIR / "collection.json"
BINS_PATH = DATA_DIR / "bins.json"
WEB_DIR = ROOT / "web"

DISCOGS_TOKEN = os.environ.get("DISCOGS_TOKEN", "").strip()
DISCOGS_USERNAME = os.environ.get("DISCOGS_USERNAME", "").strip()
DISCOGS_USER_AGENT = os.environ.get(
    "DISCOGS_USER_AGENT", "RecordCollection/2.0 +https://github.com/Glyphic-HA/records"
)

# Set to "0" to stop the web server from contacting Discogs for missing covers.
FETCH_MISSING_IMAGES = os.environ.get("RC_FETCH_MISSING_IMAGES", "1") != "0"
# Optional shared secret required to edit bin locations (leave blank on a trusted home network).
EDIT_TOKEN = os.environ.get("RC_EDIT_TOKEN", "").strip()
