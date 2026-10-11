import io
import json

import pytest

from app import config, images, store, sync
from app.discogs import Discogs, artist_credit, clean_name, details_from_release, record_from_collection_item


@pytest.fixture(autouse=True)
def tmp_data(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "IMAGES_DIR", tmp_path / "images")
    monkeypatch.setattr(config, "COLLECTION_PATH", tmp_path / "collection.json")
    monkeypatch.setattr(config, "BINS_PATH", tmp_path / "bins.json")
    monkeypatch.setattr(config, "BACKS_PATH", tmp_path / "backs.json")
    for name, fname in [("PRICES_PATH", "prices.json"), ("VALUE_PATH", "value_history.json"),
                        ("SYNC_LOCK", "sync.lock"), ("SYNC_STATUS", "sync_status.json"),
                        ("SYNC_LOG", "sync.log"), ("COLORS_PATH", "colors.json"),
                        ("SHELVES_PATH", "shelves.json")]:
        monkeypatch.setattr(config, name, tmp_path / fname)
    monkeypatch.setattr(config, "DISCOGS_USERNAME", "")
    monkeypatch.setattr(config, "DISCOGS_TOKEN", "")
    monkeypatch.setattr(config, "EDIT_TOKEN", "")
    return tmp_path


def jpeg_bytes(color=(200, 30, 30), size=(600, 600)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "JPEG")
    return buf.getvalue()


COLLECTION_ITEM = {
    "id": 111, "instance_id": 9001, "date_added": "2024-01-02T10:00:00-08:00", "rating": 4,
    "basic_information": {
        "id": 111, "title": "Rain Dogs", "year": 1985,
        "cover_image": "https://i.discogs.com/front.jpg",
        "artists": [{"name": "Tom Waits", "anv": "", "join": ""}],
        "labels": [{"name": "Island Records (2)", "catno": "ILPS 9803"}],
        "formats": [{"name": "Vinyl", "qty": "1", "descriptions": ["LP", "Album"]}],
        "genres": ["Rock", "Blues"], "styles": ["Blues Rock"],
    },
}
RELEASE = {
    "id": 111, "country": "UK", "released": "1985-09-30", "notes": "",
    "lowest_price": 12.5, "num_for_sale": 8,
    "tracklist": [
        {"type_": "heading", "title": "Side A", "position": ""},
        {"type_": "track", "position": "A1", "title": "Singapore", "duration": "2:46"},
        {"type_": "track", "position": "A2", "title": "Clap Hands", "duration": "3:47"},
    ],
    "images": [  # Discogs order is arbitrary: here the label comes before the back
        {"type": "secondary", "uri": "https://i.discogs.com/label.jpg"},
        {"type": "primary", "uri": "https://i.discogs.com/front.jpg"},
        {"type": "secondary", "uri": "https://i.discogs.com/back.jpg"},
    ],
}


class FakeResp:
    def __init__(self, status=200, payload=None, content=b"", headers=None):
        self.status_code, self._payload, self.content = status, payload, content
        self.headers = headers or {}
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self):
        self.headers, self.calls = {}, []

    def get(self, url, params=None, timeout=None):
        self.calls.append(url)
        if "/collection/folders/0/releases" in url:
            return FakeResp(payload={"pagination": {"pages": 1}, "releases": [COLLECTION_ITEM]})
        if url.endswith("/releases/111"):
            return FakeResp(payload=RELEASE)
        if url.endswith("/collection/value"):
            return FakeResp(payload={"minimum": "$1,000.00", "median": "$2,345.67", "maximum": "$5,000.00"})
        if url.endswith(".jpg"):
            return FakeResp(content=jpeg_bytes(), headers={"Content-Type": "image/jpeg"})
        return FakeResp(status=404, payload={"message": "not found"})


def fake_client():
    return Discogs(token="t", username="glyphic", session=FakeSession(), sleep=lambda s: None)


# ---------------------------------------------------------------- discogs shaping

def test_clean_names():
    assert clean_name("Nirvana (2)") == "Nirvana"
    assert clean_name("Beatles, The") == "The Beatles"
    assert artist_credit([{"name": "A", "join": "&"}, {"name": "B (3)", "join": ""}]) == "A & B"
    assert artist_credit([{"name": "A", "join": ","}, {"name": "B", "join": ""}]) == "A, B"


def test_record_and_details_shape():
    r = record_from_collection_item(COLLECTION_ITEM)
    assert r["artist"] == "Tom Waits" and r["label"] == "Island Records" and r["catno"] == "ILPS 9803"
    assert r["format_detail"] == "LP, Album" and r["genres"] == ["Rock", "Blues"]
    d = details_from_release(RELEASE)
    assert [t["title"] for t in d["tracklist"]] == ["Singapore", "Clap Hands"]  # heading skipped
    # primary first, then the rest in Discogs order; no guessing which one is the back
    assert [u.rsplit("/", 1)[1] for u in d["images"]] == ["front.jpg", "label.jpg", "back.jpg"]
    assert d["cover_url"].endswith("front.jpg") and "back_url" not in d


def test_rate_limit_retry():
    sess = FakeSession()
    responses = [FakeResp(status=429, headers={"Retry-After": "1"}), FakeResp(payload=RELEASE)]
    sess.get = lambda url, params=None, timeout=None: responses.pop(0)
    slept = []
    c = Discogs(token="t", username="u", session=sess, sleep=slept.append)
    assert c.release(111)["id"] == 111
    assert slept == [5]


# ---------------------------------------------------------------- sync

def test_full_sync_fetches_details_and_images():
    sync.run_sync(fake_client(), details_limit=None, fetch_images=True)
    data = store.load_collection()
    assert data["username"] == "glyphic" and data["synced_at"]
    [r] = data["records"]
    assert r["details_synced"] and len(r["tracklist"]) == 2 and len(r["images"]) == 3
    assert images.find_local(111, "front")
    assert not images.find_local(111, "p1")  # other photos load lazily


def test_resync_refetches_old_records_and_removes_guessed_backs(tmp_data):
    # A record synced by the previous version: details but no photo list, plus a guessed back file.
    store.save_collection({"records": [{"id": 111, "title": "Rain Dogs", "tracklist": [], "back_url": "x",
                                        "details_synced": True}]})
    (tmp_data / "images").mkdir()
    (tmp_data / "images" / "111-back.jpg").write_bytes(b"wrong")
    (tmp_data / "images" / "111-back.thumb.jpg").write_bytes(b"wrong")
    c = fake_client()
    sync.run_sync(c, details_limit=None, fetch_images=False)
    assert any(u.endswith("/releases/111") for u in c.session.calls)
    [r] = store.load_collection()["records"]
    assert len(r["images"]) == 3 and "back_url" not in r
    assert not list((tmp_data / "images").glob("*-back*"))


def test_resync_keeps_details_without_refetching():
    sync.run_sync(fake_client(), details_limit=None, fetch_images=False)
    c = fake_client()
    sync.run_sync(c, details_limit=None, fetch_images=False)
    assert not any(u.endswith("/releases/111") for u in c.session.calls)
    assert store.load_collection()["records"][0]["tracklist"]


def test_empty_collection_does_not_wipe_data():
    store.save_collection({"records": [{"id": 1, "title": "Keep me"}]})
    c = fake_client()
    c.session.get = lambda url, params=None, timeout=None: FakeResp(payload={"pagination": {"pages": 1}, "releases": []})
    with pytest.raises(Exception):
        sync.run_sync(c, details_limit=None, fetch_images=False)
    assert store.load_collection()["records"][0]["title"] == "Keep me"


def test_import_legacy(tmp_path):
    old = tmp_path / "old.json"
    old.write_text(json.dumps([
        {"id": 5, "title": "T", "artist": "Band (2)", "year": 1999, "label": "Lbl (3)", "format": "Vinyl",
         "genre": "Folk, World, & Country", "cover_image": "/static/images/5.jpeg", "tracklist": ["One", "Two"],
         "date_added": "2020-01-01T00:00:00-08:00"},
        {"title": "no id"},
    ]))
    imgs = tmp_path / "oldimgs"
    imgs.mkdir()
    (imgs / "5.jpeg").write_bytes(jpeg_bytes())
    bins = tmp_path / "bin_store.json"
    bins.write_text(json.dumps({"5": "A3", "6": ""}))
    sync.import_legacy(old, imgs, bins)
    [r] = store.load_collection()["records"]
    assert r["artist"] == "Band" and r["label"] == "Lbl"
    assert r["genres"] == ["Folk, World, & Country"]
    assert r["tracklist"][1] == {"position": "", "title": "Two", "duration": ""}
    assert images.find_local(5, "front").name == "5-front.jpg"
    assert store.load_bins() == {"5": "A3"}


# ---------------------------------------------------------------- web

@pytest.fixture
def client():
    from app.server import create_app
    sync.run_sync(fake_client(), details_limit=None, fetch_images=True)
    return create_app().test_client()


def test_index_and_assets(client):
    assert b"Records" in client.get("/").data
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/assets/../app/config.py").status_code == 404


def test_collection_api(client):
    body = client.get("/api/collection").get_json()
    [r] = body["records"]
    assert r["uid"] == "9001" and r["tracklist"][0]["position"] == "A1"
    assert r["photos"] == 3 and r["back"] is None
    assert body["can_edit"] is True


def test_duplicate_copies_get_unique_uids(client):
    store.save_collection({"records": [{"id": 7, "title": "x"}, {"id": 7, "title": "x"}]})
    uids = [r["uid"] for r in client.get("/api/collection").get_json()["records"]]
    assert uids == ["7", "7-2"]


def test_images_and_thumbnails(client):
    full = client.get("/img/111/front")
    assert full.status_code == 200 and full.mimetype == "image/jpeg"
    thumb = client.get("/img/111/front?size=thumb")
    assert thumb.status_code == 200 and len(thumb.data) < len(full.data)
    assert client.get("/img/111/side").status_code == 404
    assert client.get("/img/999/front").status_code == 404
    assert client.get("/img/111/back").status_code == 404   # no back chosen yet
    assert client.get("/img/111/7").status_code == 404      # out of range


def test_other_photos_download_on_demand(client, monkeypatch):
    import app.server as srv
    monkeypatch.setattr(srv, "_client", fake_client)
    assert client.get("/img/111/2").status_code == 200
    assert images.find_local(111, "p2")


def test_choose_back_cover(client, monkeypatch):
    import app.server as srv
    monkeypatch.setattr(srv, "_client", fake_client)
    assert client.put("/api/backs/111", json={"photo": 2}).get_json() == {"id": 111, "back": 2}
    rec = client.get("/api/collection").get_json()["records"][0]
    assert rec["back"] == 2
    assert client.get("/img/111/back").status_code == 200
    # invalid choices
    for bad in (0, 3, "2", True, -1):
        assert client.put("/api/backs/111", json={"photo": bad}).status_code == 400
    assert client.put("/api/backs/999", json={"photo": 1}).status_code == 404
    # clear it
    assert client.put("/api/backs/111", json={"photo": None}).get_json() == {"id": 111, "back": None}
    assert client.get("/api/collection").get_json()["records"][0]["back"] is None
    # survives a re-sync
    client.put("/api/backs/111", json={"photo": 1})
    sync.run_sync(fake_client(), details_limit=None, fetch_images=False)
    assert client.get("/api/collection").get_json()["records"][0]["back"] == 1
    monkeypatch.setattr(config, "EDIT_TOKEN", "secret")
    assert client.put("/api/backs/111", json={"photo": 2}).status_code == 403


def test_missing_image_without_token_is_404(client):
    store.save_collection({"records": [{"id": 42, "title": "No art"}]})
    assert client.get("/img/42/front").status_code == 404


def test_bins(client, monkeypatch):
    r = client.put("/api/bins/111", json={"bin": " B2 "})
    assert r.get_json() == {"id": 111, "bin": "B2"}
    assert client.get("/api/collection").get_json()["records"][0]["bin"] == "B2"
    assert client.put("/api/bins/111", json={"bin": 5}).status_code == 400
    monkeypatch.setattr(config, "EDIT_TOKEN", "secret")
    assert client.put("/api/bins/111", json={"bin": "C"}).status_code == 403
    assert client.put("/api/bins/111", json={"bin": "C"}, headers={"X-Edit-Token": "secret"}).status_code == 200


# ---------------------------------------------------------------- prices, sync control, shelves

def test_prices_and_value_are_recorded():
    summary = sync.run_sync(fake_client(), details_limit=None, fetch_images=True)
    assert summary["value"] == "$2,345.67" and summary["records"] == 1
    [r] = store.load_collection()["records"]
    assert r["price"]["lowest"] == 12.5 and r["price"]["for_sale"] == 8
    from app import prices
    [v] = prices.load_value_history()
    assert v["median"] == 2345.67 and v["display"]["maximum"] == "$5,000.00"
    assert prices.load_price_history()["111"][0][1:] == [12.5, 8]
    # cover color measured for the shelves page
    assert store.read_json(config.COLORS_PATH, {})["111"].startswith("#")


def test_rolling_price_refresh_and_history():
    from app import prices
    sync.run_sync(fake_client(), details_limit=None, fetch_images=False)
    data = store.load_collection()
    data["records"][0]["price"]["checked"] = "2020-01-01"   # pretend it's stale
    store.save_collection(data)
    hist = prices.load_price_history()
    hist["111"] = [["2020-01-01", 10.0, 3]]
    store.write_json(config.PRICES_PATH, hist)
    c = fake_client()
    sync.run_sync(c, details_limit=None, fetch_images=False, price_limit=5)
    assert any(u.endswith("/releases/111") for u in c.session.calls)
    points = prices.load_price_history()["111"]
    assert [p[1] for p in points] == [10.0, 12.5]
    # same price again the same day: no new point
    c2 = fake_client()
    sync.run_sync(c2, details_limit=None, fetch_images=False, price_limit=5)
    assert not any(u.endswith("/releases/111") for u in c2.session.calls)  # already checked today
    assert len(prices.load_price_history()["111"]) == 2


def test_value_history_one_entry_per_day():
    from app import prices
    prices.note_value({"minimum": "$1", "median": "$2", "maximum": "$3"}, today="2026-01-01")
    prices.note_value({"minimum": "$1", "median": "$5", "maximum": "$9"}, today="2026-01-01")
    prices.note_value({"minimum": "$1", "median": "$6", "maximum": "$9"}, today="2026-01-02")
    assert [(v["date"], v["median"]) for v in prices.load_value_history()] == [("2026-01-01", 5.0), ("2026-01-02", 6.0)]


def test_parse_money():
    from app.discogs import parse_money
    assert parse_money("$1,234.56") == 1234.56
    assert parse_money("€1.234,56") == 1234.56
    assert parse_money("£12") == 12.0
    assert parse_money("") is None


def test_sync_lock_prevents_overlap(monkeypatch):
    monkeypatch.setattr(sync, "Discogs", lambda: fake_client())
    with sync.sync_lock() as got:
        assert got and sync.is_running()
        assert sync.main([]) == 0           # second sync backs off
        assert sync.read_status() == {}     # and doesn't touch the status
    assert not sync.is_running()
    assert sync.main(["--no-images"]) == 0
    st = sync.read_status()
    assert st["state"] == "done" and st["summary"]["records"] == 1


def test_sync_failure_is_reported(monkeypatch):
    class Boom:
        token, username = "t", "u"
        def collection(self):
            raise sync.DiscogsError("401 from Discogs")
    monkeypatch.setattr(sync, "Discogs", lambda: Boom())
    assert sync.main([]) == 1
    st = sync.read_status()
    assert st["state"] == "failed" and "401" in st["error"]


def test_sync_api(client, monkeypatch):
    import app.server as srv
    assert client.get("/api/sync").get_json()["running"] is False
    assert client.post("/api/sync").status_code == 400            # no Discogs details configured
    monkeypatch.setattr(config, "DISCOGS_TOKEN", "t")
    monkeypatch.setattr(config, "DISCOGS_USERNAME", "u")
    started = []

    class FakeProc:
        def __init__(self, cmd, **kw):
            started.append(cmd)
        def wait(self):
            return 0
    monkeypatch.setattr(srv.subprocess, "Popen", FakeProc)
    r = client.post("/api/sync")
    assert r.status_code == 202 and started and started[0][-2:] == ["-m", "app.sync"]
    with sync.sync_lock():
        assert client.post("/api/sync").status_code == 409
        assert client.get("/api/sync").get_json()["running"] is True
    monkeypatch.setattr(config, "EDIT_TOKEN", "secret")
    assert client.post("/api/sync").status_code == 403


def test_collection_includes_value_price_and_colors(client):
    body = client.get("/api/collection").get_json()
    assert body["records"][0]["price"]["lowest"] == 12.5
    assert body["value_history"][0]["median"] == 2345.67
    assert body["colors"]["111"].startswith("#")
    assert body["currency"] == "USD"
    hist = client.get("/api/prices/111").get_json()
    assert hist["history"][0][1] == 12.5


def test_shelves_api(client):
    layout = client.get("/api/shelves").get_json()
    assert [u["id"] for u in layout["units"]] == ["A", "B"] and layout["stacks"][0]["label"] == "New"
    assert layout["stacks"][0]["new"] and layout["arrivals_since"]
    layout["starts"] = {"A1": "!!!", "B3": "Fugazi", "Z9": "ignored", "A2": "  "}
    saved = client.put("/api/shelves", json=layout).get_json()
    assert saved["starts"] == {"A1": "!!!", "B3": "Fugazi"}
    assert client.get("/api/shelves").get_json()["starts"]["B3"] == "Fugazi"
    bad = dict(layout, units=[{"id": "A", "cols": 0, "rows": 3}])
    assert client.put("/api/shelves", json=bad).status_code == 400
    assert client.put("/api/shelves", json=[1]).status_code == 400
    assert client.put("/api/shelves", json=dict(layout, arrivals_since="soon")).status_code == 400


def test_friendly_discogs_errors():
    from app.discogs import DiscogsError
    for status, needle, url in [(401, "DISCOGS_TOKEN", "/releases/1"), (404, "DISCOGS_USERNAME", "/users/nobody/collection/value")]:
        sess = FakeSession()
        sess.get = lambda u, params=None, timeout=None, st=status: FakeResp(status=st, payload={})
        c = Discogs(token="t", username="nobody", session=sess, sleep=lambda s: None)
        with pytest.raises(DiscogsError) as e:
            c.get(url)
        assert needle in str(e.value)
    import requests as rq
    sess = FakeSession()
    def boom(u, params=None, timeout=None):
        raise rq.ConnectionError("proxy said no")
    sess.get = boom
    c = Discogs(token="t", username="u", session=sess, sleep=lambda s: None)
    with pytest.raises(DiscogsError) as e:
        c.get("/releases/1")
    assert "Couldn't reach Discogs" in str(e.value)
