# Records

A small web app for browsing a vinyl collection that lives on Discogs. Meant to run on a Raspberry Pi at home.

- **Gallery** works like flipping through a crate. Drag, scroll, or use the arrow keys, then click the front record.
- **List** is sortable by artist, title, or year. A–Z sorts get bin-divider letters ("The" is ignored when filing).
- **Stats** shows collection growth over time, genres, decades, and the artists and labels you collect most. Click any bar to list those records.
- **Record details** include front and back covers (click to flip), the tracklist, label and catalog number, and a link to Discogs. There's also a **Bin** field for noting where a record lives on your shelf.
- Search covers artist, title, label, catalog number, style, and track names. You can also filter by genre, decade, and format. Every view can be linked to, filters and open record included.
- Dark and light themes, and it works on a phone.

It's a Flask app with a plain-JavaScript frontend, so there's **no npm or build step**. Your collection is stored as one JSON file, and the cover art is cached on disk.

```
app/        server.py (API + pages), sync.py (Discogs sync CLI), discogs.py, images.py, store.py
web/        index.html + assets/ (the whole frontend)
deploy/     setup.sh, systemd units (web app + nightly sync timer), optional nginx config
data/       collection.json, bins.json, images/   ← created at runtime, not in git
tests/
```

## Install on the Pi

```bash
git clone https://github.com/glyphic-sentry/record-collection.git
cd record-collection
./deploy/setup.sh                     # creates .env on the first run
nano .env                             # set DISCOGS_USERNAME and DISCOGS_TOKEN
./deploy/setup.sh                     # installs services and starts the first sync
```

Then open `http://<pi-hostname>.local:8000`. Use `./deploy/setup.sh --nginx` to serve it on plain port 80 instead.

Get a token at **Discogs → Settings → Developers → Generate new token**. The token goes in `.env`, which is git-ignored. Don't commit it.

The first sync pulls your whole collection, then looks up each release for its tracklist and back cover. Discogs allows about 60 requests a minute, so ~1,000 records take about 20 minutes. Progress is saved as it goes. After that, a systemd timer syncs every night at 4 am and only fetches what's new.

## Moving from the old version

If the Pi already has the old app checked out at `~/record-collection`:

```bash
cd ~/record-collection
sudo systemctl disable --now record-collection.service   # the old, crash-looping one
crontab -l | grep -v collection_importer | crontab -     # remove the old nightly cron job
git fetch origin && git checkout rebuild                 # or main, once merged
./deploy/setup.sh
```

`setup.sh` finds the old `backend/collection.json` and `backend/static/images/` and imports them, so your covers show up right away without re-downloading. It also replaces the old nginx site, which was serving a broken build. The old `backend/` and `frontend/` folders are left in place (git-ignored), so delete them once you're happy.

You can also run the import by hand:

```bash
.venv/bin/python -m app.sync import-legacy backend/collection.json --images backend/static/images
```

## Everyday commands

```bash
sudo systemctl start record-collection-sync     # sync now
journalctl -u record-collection-sync -f         # watch a sync
journalctl -u record-collection -f              # web app log
systemctl list-timers record-collection-sync    # when's the next sync
.venv/bin/python -m app.sync --help             # sync options (--details-limit, --no-images, --refresh-details)
```

**Back up `data/`.** It's your collection, cached covers, and bin locations. Everything except bins can be rebuilt from Discogs.

## Developing

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/flask --app app.server run --debug --port 8000
.venv/bin/pytest -q
```

Edit files in `web/` and reload the page; no build step.

## API

| Endpoint | |
|---|---|
| `GET /api/collection` | all records, with tracklists and bins |
| `GET /api/health` | record count and last sync time |
| `PUT /api/bins/<release_id>` | `{"bin": "A3"}`. Needs an `X-Edit-Token` header if `RC_EDIT_TOKEN` is set |
| `GET /img/<release_id>/front` or `/back` | cover art. Add `?size=thumb` for a 320px version. Missing covers are fetched from Discogs on demand |

## Notes

- Bin editing has no login. That's fine on a home network. If you ever expose this to the internet, set `RC_EDIT_TOKEN` and put it behind something with auth.
- The sync refuses to overwrite your data if Discogs returns an empty collection (for example, a typo in the username).
