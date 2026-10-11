# Records

A small web app for browsing a vinyl collection that lives on Discogs. It runs on a Raspberry Pi at home, and you open it from any browser on your network.

- **Gallery** works like flipping through a crate. Drag, scroll, or use the arrow keys, then click the front record.
- **List** is sortable by artist, title, or year. A–Z sorts get bin-divider letters ("The" is ignored when filing).
- **Stats** shows collection growth over time, genres, decades, and the artists and labels you collect most. Click any bar to list those records.
- **Record details** include front and back covers (click to flip), the tracklist, label and catalog number, and a link to Discogs. There's also a **Bin** field for noting where a record lives on your shelf.
- Search covers artist, title, label, catalog number, style, and track names. You can also filter by genre, decade, and format. Every view can be linked to, filters and open record included.
- Dark and light themes, and it works on a phone.
- A nightly sync picks up records you've added on Discogs.

It's Flask with a plain-JavaScript frontend, so there's **no npm or build step**. The collection is stored as one JSON file, and cover art is cached on the Pi.

---

## Setup: from a blank SD card to a running app

Plan on about 30 minutes, plus 20 or so for the first sync to download your collection.

### What you need

- A Raspberry Pi 3B+, 4, 5, or Zero 2 W, with its power supply
- A microSD card, 16 GB or larger (covers for ~1,000 records take about 150 MB)
- A computer with an SD card reader
- Wi-Fi or an Ethernet cable for the Pi
- Your Discogs account

### 1. Get your Discogs details

1. Sign in at [discogs.com](https://www.discogs.com). Your **username** is the name in your profile URL (`discogs.com/user/<username>`).
2. Go to **Settings → Developers** ([discogs.com/settings/developers](https://www.discogs.com/settings/developers)) and click **Generate new token**. Copy it somewhere safe. It's like a password, so never put it in git or share it.

### 2. Flash the SD card

1. Install **Raspberry Pi Imager** from [raspberrypi.com/software](https://www.raspberrypi.com/software/) and open it.
2. **Device:** pick your Pi model.
3. **Operating system:** choose **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**. Lite has no desktop, which is all a server needs. On a Pi 3B+ or Zero 2 W, the 64-bit Lite image is still the right pick.
4. **Storage:** pick your SD card. Double-check it's the card, because everything on it will be erased.
5. **Customise.** Imager asks for settings before writing. Fill these in:
   - **Hostname:** `records`. This is how you'll reach it later (`records.local`).
   - **Location:** your time zone (e.g. America/Los_Angeles) and keyboard layout. The time zone controls when the nightly sync runs.
   - **User account:** a username and password. The examples below use `eli`.
   - **Wireless LAN:** your Wi-Fi name, password, and country. Skip this if you're using Ethernet.
   - **Remote access:** turn on **SSH** with password authentication. This is how you'll control the Pi from your computer.
   - Skip Raspberry Pi Connect and interface options.
6. **Write**, wait for it to finish and verify, then eject the card.

### 3. Boot the Pi and connect to it

1. Put the card in the Pi, connect Ethernet if you're using it, and plug in power. Give it **2–3 minutes**, because the first boot is slow.
2. Connect with **PuTTY**:
   - **Host Name:** `records.local`, **Port:** `22`, **Connection type:** SSH.
   - To reuse these settings, type `records` under **Saved Sessions** and click **Save**. Next time, just double-click it.
   - Click **Open**. The first time, PuTTY shows a **Security Alert** about the host key. Click **Accept**, which is expected for a new Pi.
   - At `login as:`, enter the username you set in Imager, then the password. Nothing appears while you type the password; that's normal.

   <details><summary>Without PuTTY (PowerShell, Mac or Linux terminal)</summary>

   ```bash
   ssh eli@records.local
   ```
   Type `yes` to the authenticity question, then enter your password.
   </details>

   If `records.local` isn't found, see [Troubleshooting](#troubleshooting).

Every command from here on runs **on the Pi**, in that PuTTY window.

> **PuTTY tips:** to paste a command, **right-click** anywhere in the window (Ctrl+V doesn't work). Selecting text with the mouse copies it automatically.

### 4. Update the system and install git

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git
```

### 5. Install the app

```bash
cd ~
git clone https://github.com/Glyphic-HA/records.git
cd records
./deploy/setup.sh
```

The first run installs Python packages, which takes a few minutes on a Pi. It then creates a settings file called `.env` and stops to ask for your Discogs details. Open the file:

```bash
nano .env
```

Fill in the two lines:

```
DISCOGS_USERNAME=your-discogs-username
DISCOGS_TOKEN=the-token-you-generated
```

Save with **Ctrl+O**, then **Enter**, then exit with **Ctrl+X**. Run setup again:

```bash
./deploy/setup.sh
```

This time it installs the app as a service that starts on boot, sets up the nightly sync, and starts the first sync in the background.

### 6. Open it

From any phone or computer on your network, go to **http://records.local:8000**

Records appear right away, and covers fill in as they download. Tracklists and back covers arrive over about the next 20 minutes for a ~1,000-record collection, because Discogs limits how fast apps can ask for data. You can watch the progress:

```bash
journalctl -u record-collection-sync -f      # Ctrl+C to stop watching
```

That's it. The Pi syncs with Discogs every night at about 4 am, so anything you add on Discogs shows up the next day. Reload the page to see it.

### Optional: drop the `:8000`

To use plain **http://records.local**, run:

```bash
./deploy/setup.sh --nginx
```

### Optional: give the Pi a fixed address

`records.local` works on most home networks. If a device can't find it (some Android phones and smart TVs can't), reserve an IP address for the Pi in your router's settings, usually under "DHCP reservation" or "static lease". Then bookmark `http://<that-ip>:8000`.

---

## Everyday use

```bash
sudo systemctl start record-collection-sync     # sync with Discogs right now
journalctl -u record-collection-sync -f         # watch a sync
journalctl -u record-collection -f              # web app log
systemctl list-timers record-collection-sync    # when the next sync runs
```

**Updating the app** after new changes are pushed to GitHub:

```bash
cd ~/records && git pull && ./deploy/setup.sh
```

**Backing up.** Everything lives in `~/records/data/`: the collection, cached covers, and your bin locations. Everything except bin locations can be rebuilt from Discogs, so the one file worth copying off the Pi is `data/bins.json`. From a Windows Command Prompt or PowerShell on your computer, use `pscp`, which comes with PuTTY:

```bat
pscp eli@records.local:records/data/bins.json .
```

To drag and drop files instead, [WinSCP](https://winscp.net) connects with the same host, username and password as PuTTY. On Mac or Linux, use `scp` with the same arguments.

**Shutting down** before unplugging (this protects the SD card):

```bash
sudo shutdown now
```

## Troubleshooting

**PuTTY says "Host does not exist" or "Unable to open connection" for `records.local`**
Wait another minute; the first boot takes a while. If it still fails, find the Pi's IP address in your router's list of connected devices (it'll be named `records`) and put that address (e.g. `192.168.1.42`) in PuTTY's Host Name box instead. If it never shows up, the Wi-Fi details in Imager were probably wrong. Re-flash the card and check the Wi-Fi country too.

**PuTTY shows a scary "Security Alert / host key does not match" warning**
This is expected after you re-flash the card, because the Pi generated new keys. Click **Accept** to trust the new key. (If you *haven't* re-flashed, stop and work out why the key changed.) Using a plain `ssh` command instead? Run `ssh-keygen -R records.local` first.

**The page doesn't load**
Check the service:

```bash
systemctl status record-collection
```

If it says `failed`, the reason is in `journalctl -u record-collection -n 50`.

**"No records yet" on the page**
The sync hasn't finished its first step, or it failed. Run `journalctl -u record-collection-sync -n 30`. A `401` error means the token is wrong; a `404` means the username is wrong. Fix `.env`, then run `sudo systemctl start record-collection-sync`.

**Some records show a plain colored sleeve instead of a cover**
Either that release has no image on Discogs, or its cover hasn't downloaded yet. The nightly sync retries.

---

## How it fits together

```
app/        server.py (API + pages), sync.py (Discogs sync CLI), discogs.py, images.py, store.py
web/        index.html + assets/ (the whole frontend, no build step)
deploy/     setup.sh, systemd units (web app + nightly sync timer), optional nginx config
data/       collection.json, bins.json, images/   ← created on the Pi, not in git
tests/
```

Sync options: `.venv/bin/python -m app.sync --help`. They include `--details-limit N`, `--no-images` and `--refresh-details`.

### API

| Endpoint | |
|---|---|
| `GET /api/collection` | all records, with tracklists and bins |
| `GET /api/health` | record count and last sync time |
| `PUT /api/bins/<release_id>` | `{"bin": "A3"}`. Needs an `X-Edit-Token` header if `RC_EDIT_TOKEN` is set |
| `GET /img/<release_id>/front` or `/back` | cover art. Add `?size=thumb` for a 320px version. Missing covers are fetched from Discogs on demand |

### Developing on your own computer

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/flask --app app.server run --debug --port 8000
.venv/bin/pytest -q
```

Edit files in `web/` and reload the page; no build step.

### Bringing over data from the old version

Not needed, since a sync rebuilds everything from Discogs. But if you have the old app's `collection.json` and image folder, this imports them, covers included:

```bash
.venv/bin/python -m app.sync import-legacy path/to/collection.json --images path/to/static/images
```

### Notes

- Bin editing has no login. That's fine on a home network. If you ever expose this to the internet, set `RC_EDIT_TOKEN` in `.env` and put it behind something with authentication.
- The sync won't overwrite your data if Discogs returns an empty collection, for example because of a typo in the username.
