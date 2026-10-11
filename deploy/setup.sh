#!/usr/bin/env bash
# Installer for Raspberry Pi OS (or any Debian-based system with systemd).
# Safe to re-run any time: it updates dependencies and service files in place.
#
#   ./deploy/setup.sh            # app on http://<hostname>.local:8000, nightly sync at ~04:00
#   ./deploy/setup.sh --nginx    # also serve it on port 80 (http://<hostname>.local)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(id -un)}"
PORT="${PORT:-8000}"
WITH_NGINX=0
[[ "${1:-}" == "--nginx" ]] && WITH_NGINX=1
[[ -e /etc/nginx/sites-enabled/record-collection ]] && WITH_NGINX=1  # keep it on once enabled

cd "$DIR"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [[ $EUID -eq 0 && -z "${SUDO_USER:-}" ]]; then
  echo "Run this as your normal user (it uses sudo where needed), not as root."
  exit 1
fi

say "1/4  System packages"
NEED=()
python3 -c 'import venv, ensurepip' 2>/dev/null || NEED+=(python3-venv)
command -v git >/dev/null || NEED+=(git)
if ((${#NEED[@]})); then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${NEED[@]}"
else
  echo "Already installed."
fi

say "2/4  Python packages (a few minutes the first time on a Pi)"
[[ -d .venv ]] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p data/images

say "3/4  Discogs settings"
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
fi
if ! grep -q '^DISCOGS_USERNAME=.\+' .env || ! grep -q '^DISCOGS_TOKEN=.\+' .env; then
  cat <<MSG
Almost there. Add your Discogs username and token to the settings file:

    nano $DIR/.env

(save with Ctrl+O, Enter, then Ctrl+X) and run this script again:

    ./deploy/setup.sh
MSG
  exit 0
fi
echo "Found DISCOGS_USERNAME and DISCOGS_TOKEN in .env."

say "4/4  Services"
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

# First sync (or a catch-up after an update) runs in the background.
if [[ ! -s data/collection.json ]] || ! systemctl is-active --quiet record-collection-sync.service; then
  sudo systemctl start --no-block record-collection-sync.service
  SYNC_NOTE="A Discogs sync is running in the background. Watch it with:
    journalctl -u record-collection-sync -f"
else
  SYNC_NOTE="A sync is already running."
fi

sleep 2
if systemctl is-active --quiet record-collection.service; then
  URL="http://$(hostname).local:$PORT"
  [[ $WITH_NGINX == 1 ]] && URL="http://$(hostname).local"
  say "Done. Open $URL"
  echo "$SYNC_NOTE"
else
  say "The web app didn't start. Recent log:"
  sudo journalctl -u record-collection -n 30 --no-pager
  exit 1
fi
