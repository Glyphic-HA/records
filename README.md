# Records

A small web app for browsing a vinyl collection that lives on Discogs. It runs on a Raspberry Pi at home, and you open it from any browser on your network.

- **Gallery** works like flipping through a crate. Drag, scroll, or use the arrow keys, then click the front record.
- **List** is sortable by artist, title, or year. A–Z sorts get bin-divider letters ("The" is ignored when filing).
- **Stats** shows collection growth over time, genres, decades, and the artists and labels you collect most. Click any bar to list those records.
- **Record details** show every photo of the release from Discogs, plus the tracklist, label and catalog number, and a link to Discogs. There's also a **Bin** field for noting where a record lives on your shelf.
- **Back covers:** Discogs doesn't label which photo is the back (uploaders add them in any order), so you pick it. Open a photo and choose **Use as back cover**. After that, clicking the cover flips between front and back. You only do this once per record.
- **Shelves** draws your actual shelving units. Each cubby shows its records as spines, colored from their covers. Click a cubby to flip through just that bin. Records file themselves alphabetically (see [Filing records on your shelves](#filing-records-on-your-shelves)), and there's a **New arrivals** pile for recent additions.
- **Collection value:** the Stats page shows Discogs' estimate of what your collection is worth, tracked over time, plus the records that would cost the most to replace. Each record shows the cheapest copy currently for sale, with a small price-history line.
- **Factoids** at the top of Stats rotate through 45+ kinds: band members you own across several bands, your most-credited producer, the rarest and most-wanted records you own, total weight ("about a grizzly bear"), colored vinyl, pressing plants, shortest track, and more.
- **People:** each record lists its band members, related bands in your collection (shared members), and producer, engineer and mastering credits. Click any name to see every record they're on. Stats shows the most credited producers and engineers, plus a **band family tree** of people who played in more than one band you own.
- **Surprise me** opens a random record from whatever you're currently viewing.
- **Sync now** (the circular-arrows button) pulls changes from Discogs immediately instead of waiting for the nightly sync.
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

> **Is the repo private?** Then `git clone` will ask for a username and fail with *"Password authentication is not supported"*. Give the Pi a read-only deploy key instead:
>
> ```bash
> ssh-keygen -t ed25519 -C "records-pi" -f ~/.ssh/id_ed25519 -N ""
> cat ~/.ssh/id_ed25519.pub
> ```
>
> Select the `ssh-ed25519 …` line that prints (selecting copies it in PuTTY). On GitHub, open the repo's **Settings → Deploy keys → Add deploy key**, paste the line, leave *Allow write access* off, and save. Then clone with the SSH address, typing `yes` to GitHub's fingerprint:
>
> ```bash
> git clone git@github.com:Glyphic-HA/records.git
> ```

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

Records appear right away, and covers fill in as they download. Tracklists and the full photo lists arrive over about the next 20 minutes for a ~1,000-record collection, because Discogs limits how fast apps can ask for data. You can watch the progress:

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

## Filing records on your shelves

The **Shelves** page is set up for two cube units: a 2×4 on the left and a 4×3 on the right. The cubbies are **Bin 1 to Bin 20**, read across the whole wall like a page, top row first:

```
 1  2
 3  4    5  6  7  8
 9 10   11 12 13 14
15 16   17 18 19 20
```
 There's also a **New arrivals** pile standing on top of the right unit.

**One-time setup:** open Shelves, click **Set up filing**, and type the artist of the *first* record in each cubby. Every record files itself into the cubby whose first artist comes at or just before its own, the same way you'd find it by hand ("The" is ignored, as on the List page). Cubbies you leave blank are skipped.

**Adding records:** new records go on the **New arrivals** pile automatically. Once you've physically shelved that pile, click **I've shelved the new arrivals**, and they file themselves alphabetically.

**When a cubby fills up:** a cubby turns gold and says "nearly full" at around 70 records. After you shift records along to the next cubby, update that cubby's first artist in **Edit filing**.

**Exceptions:** type a bin number (e.g. `7`) into any record's **Bin** field to put it somewhere by hand. Hand-set bins always win; clear the field to go back to automatic filing.

**Different shelves?** The layout lives in `data/shelves.json`: units (id, name, cols, rows), stacks, and the first artist of each cubby. Edit it and reload the page.

## Everyday use

```bash
sudo systemctl start record-collection-sync     # sync with Discogs right now
journalctl -u record-collection-sync -f         # watch a sync
journalctl -u record-collection -f              # web app log
systemctl list-timers record-collection-sync    # when the next sync runs
```

**Updating the app** after new changes are pushed to GitHub:

```bash
cd ~/records && git pull
```

The web app notices the new code and restarts itself within a few seconds. Run `./deploy/setup.sh` as well if the update notes mention new settings or services. If the page ever shows a notice saying the Pi is running old server code, `./deploy/setup.sh` fixes it.

**Backing up.** Everything lives in `~/records/data/`. The collection and covers can be rebuilt from Discogs, but these files can't, so copy them off the Pi now and then: `bins.json` (hand-set bins), `backs.json` (back-cover picks), `shelves.json` (shelf layout and filing), `value_history.json` and `prices.json` (price history). From a Windows Command Prompt or PowerShell on your computer, use `pscp`, which comes with PuTTY:

```bat
pscp eli@records.local:records/data/*.json .
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

Sync options: `.venv/bin/python -m app.sync --help`. They include `--details-limit N`, `--prices N`, `--no-images` and `--refresh-details`. Only one sync runs at a time: if the nightly sync and the **Sync now** button overlap, the second one steps aside.

**About people data:** credits, pressing details and community counts come from each release's Discogs page. Band members come from each artist's page, looked up 300 artists per sync (`RC_ARTIST_REFRESH`) and refreshed every 90 days.

**About prices:** "collection value" is Discogs' own minimum, median and maximum estimate, based on what copies of your releases have sold for. It's recorded once a day. A record's price is the cheapest copy currently listed for sale on Discogs. That's a rough replacement cost, not what yours would sell for, and condition matters a lot. Prices are refreshed in a rolling batch each night.

### API

| Endpoint | |
|---|---|
| `GET /api/collection` | all records, with tracklists and bins |
| `GET /api/health` | record count and last sync time |
| `PUT /api/bins/<release_id>` | `{"bin": "A3"}`. Needs an `X-Edit-Token` header if `RC_EDIT_TOKEN` is set |
| `PUT /api/backs/<release_id>` | `{"photo": 2}` marks Discogs photo 2 as the back cover; `{"photo": null}` clears it. Same edit-token rule |
| `GET/POST /api/sync` | sync status / start a sync now (same edit-token rule) |
| `GET /api/prices/<release_id>` | that record's lowest-price history |
| `GET /api/collection` → `artists` | band members / groups per Discogs artist id |
| `GET/PUT /api/shelves` | shelf layout, cubby first artists, new-arrivals date |
| `GET /img/<release_id>/<n>` | Discogs photo *n* (0 = front; `front` and `back` also work). Add `?size=thumb` for a 320px version. Photos are fetched from Discogs the first time they're viewed |

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
