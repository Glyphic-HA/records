#!/usr/bin/env bash
# One-shot installer for a Raspberry Pi (or any Debian-ish box with systemd).
# Safe to re-run: it updates dependencies and service files in place.
#
#   ./deploy/setup.sh            # app on http://<pi>:8000, nightly sync at 04:00
#   ./deploy/setup.sh --nginx    # also put it on port 80 via nginx
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(id -un)}"
PORT="${PORT:-8000}"
WITH_NGINX=0
[[ "${1:-}" == "--nginx" ]] && WITH_NGINX=1
# The old version installed an nginx site with this name that serves a stale build; replace it.
[[ -e /etc/nginx/sites-enabled/record-collection ]] && WITH_NGINX=1

cd "$DIR"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/5  Python environment"
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
fi
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

say "2/5  Settings"
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env. Add DISCOGS_USERNAME and DISCOGS_TOKEN to it, then re-run this script."
fi
mkdir -p data/images

say "3/5  Data"
if [[ ! -s data/collection.json && -s backend/collection.json ]]; then
  echo "Found the old app's backend/collection.json; importing it (covers too)."
  BINS_ARG=()
  [[ -f backend/bin_store.json ]] && BINS_ARG=(--bins backend/bin_store.json)
  .venv/bin/python -m app.sync import-legacy backend/collection.json \
      --images backend/static/images "${BINS_ARG[@]}"
elif [[ -s data/collection.json ]]; then
  echo "data/collection.json already present; leaving it alone."
else
  echo "No data yet. The first Discogs sync (step 5) will create it."
fi

say "4/5  Services"
render() { sed -e "s|@USER@|$USER_NAME|g" -e "s|@DIR@|$DIR|g" -e "s|@PORT@|$PORT|g" "$1"; }
for unit in record-collection.service record-collection-sync.service record-collection-sync.timer; do
  render "deploy/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now record-collection.service record-collection-sync.timer
sudo systemctl restart record-collection.service

if [[ $WITH_NGINX == 1 ]]; then
  command -v nginx >/dev/null || sudo apt-get install -y -qq nginx
  render deploy/nginx.conf | sudo tee /etc/nginx/sites-available/record-collection >/dev/null
  sudo ln -sf /etc/nginx/sites-available/record-collection /etc/nginx/sites-enabled/record-collection
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
fi

say "5/5  First sync"
if grep -q '^DISCOGS_TOKEN=.\+' .env && grep -q '^DISCOGS_USERNAME=.\+' .env; then
  echo "Starting a Discogs sync in the background (first run takes ~20 min for 1,000 records)."
  echo "Follow along with:  journalctl -u record-collection-sync -f"
  sudo systemctl start --no-block record-collection-sync.service
else
  echo "Skipped: DISCOGS_USERNAME / DISCOGS_TOKEN not set in .env yet."
fi

HOST="$(hostname).local"
URL="http://$HOST:$PORT"
[[ $WITH_NGINX == 1 ]] && URL="http://$HOST"
say "Done. Open $URL"
