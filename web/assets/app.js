/* Records: a small no-build frontend. Views: gallery (crate flip), list, stats; detail sheet. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtInt = (n) => n.toLocaleString();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  records: [], byUid: new Map(), filtered: [], meta: {},
  view: "gallery", f: { q: "", genre: "", decade: "", format: "", bin: "", who: "", sort: "added" }, shelves: null,
  people: { links: [], name: new Map(), byArtist: new Map() },
  galleryUid: null, listLimit: 150, loaded: false, error: null,
};

// ------------------------------------------------------------------ helpers
const decadeOf = (r) => (r.year ? Math.floor(r.year / 10) * 10 : null);
const sortName = (s) => (s || "").replace(/^(the|a|an)\s+/i, "").trim();
const sortKey = (s) => sortName(s).toLowerCase();
const cmpKey = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const VIEWS = ["gallery", "list", "shelves", "stats"];
const EXPECTED_API = 5; // must match API_VERSION in app/config.py
const firstLetter = (s) => { const c = sortName(s).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : "#"; };

function sleeveColor(id) {
  // Muted, stable color per release for records without cover art.
  const h = (id * 2654435761) % 360;
  return `hsl(${h} 22% 34%)`;
}

function sleeve(r, { thumb = false, photo = 0, eager = false } = {}) {
  const src = `/img/${r.id}/${photo === 0 ? "front" : photo}${thumb ? "?size=thumb" : ""}`;
  return `<div class="sleeve has-img" style="--sleeve:${sleeveColor(r.id)}">
    <div class="plain" aria-hidden="true"><b>${esc(r.title)}</b><span>${esc(r.artist)}</span></div>
    <img src="${src}" alt="" ${eager ? "" : 'loading="lazy"'} decoding="async" draggable="false">
  </div>`;
}
// Missing cover -> show the plain sleeve instead of a broken image.
document.addEventListener("error", (e) => {
  if (e.target.tagName !== "IMG") return;
  if (e.target.closest(".thumb")) e.target.closest(".thumb").classList.add("broken");
  else if (e.target.parentElement?.classList.contains("sleeve")) e.target.parentElement.classList.remove("has-img");
}, true);

function factsLine(r) {
  return [r.year, r.label, r.format_detail || r.format].filter(Boolean).map(esc).join(", ");
}

// ------------------------------------------------------------------ routing
function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const p = new URLSearchParams(query);
  return { view: VIEWS.includes(path) ? path : "gallery", p };
}

function hashFor(view, extra = {}) {
  const p = new URLSearchParams();
  const f = { ...state.f, ...extra };
  for (const k of ["q", "genre", "decade", "format", "bin", "who"]) if (f[k]) p.set(k, f[k]);
  if (f.sort && f.sort !== "added") p.set("sort", f.sort);
  if (extra.r) p.set("r", extra.r);
  const qs = p.toString();
  return `#/${view}${qs ? "?" + qs : ""}`;
}

function syncUrl({ push = false, r } = {}) {
  const h = hashFor(state.view, r ? { r } : {});
  if (h === location.hash) return;
  history[push ? "pushState" : "replaceState"](null, "", h);
}

function readRoute() {
  const { view, p } = parseHash();
  state.view = view;
  state.f = {
    q: p.get("q") || "", genre: p.get("genre") || "", decade: p.get("decade") || "",
    format: p.get("format") || "", bin: p.get("bin") || "", who: p.get("who") || "", sort: p.get("sort") || "added",
  };
  return p.get("r");
}

// ------------------------------------------------------------------ filters
function applyFilters() {
  const { q, genre, decade, format, bin, who, sort } = state.f;
  const whoKey = who.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let out = state.records.filter((r) => {
    if (genre && !r.genres.includes(genre)) return false;
    if (format && r.format !== format) return false;
    if (bin && r._bin !== bin) return false;
    if (who && !r._people.has(whoKey)) return false;
    if (decade) {
      const d = decadeOf(r);
      if (decade === "none" ? d !== null : String(d) !== decade) return false;
    }
    return terms.every((t) => r._hay.includes(t));
  });
  const by = {
    added: (a, b) => (b.date_added || "").localeCompare(a.date_added || ""),
    artist: (a, b) => sortName(a.artist).localeCompare(sortName(b.artist), undefined, { sensitivity: "base" }) || (a.year || 0) - (b.year || 0),
    title: (a, b) => sortName(a.title).localeCompare(sortName(b.title), undefined, { sensitivity: "base" }),
    year: (a, b) => (a.year || 9999) - (b.year || 9999) || sortName(a.artist).localeCompare(sortName(b.artist)),
    "-year": (a, b) => (b.year || 0) - (a.year || 0) || sortName(a.artist).localeCompare(sortName(b.artist)),
  }[sort] || ((a, b) => 0);
  state.filtered = out.sort(by);
}

function fillSelect(sel, values, label, current) {
  sel.innerHTML = `<option value="">${label}</option>` +
    values.map(([v, text, n]) => `<option value="${esc(v)}">${esc(text)} (${n})</option>`).join("");
  sel.value = current;
}

function countBy(list, keyFn) {
  const m = new Map();
  for (const r of list) for (const k of [].concat(keyFn(r))) if (k !== undefined && k !== "") m.set(k, (m.get(k) || 0) + 1);
  return m;
}

function populateFilters() {
  const genres = [...countBy(state.records, (r) => r.genres)].sort((a, b) => b[1] - a[1]);
  fillSelect($("#f-genre"), genres.map(([g, n]) => [g, g, n]), "All genres", state.f.genre);
  const decades = [...countBy(state.records, (r) => decadeOf(r) ?? "none")]
    .sort((a, b) => (a[0] === "none") - (b[0] === "none") || a[0] - b[0]);
  fillSelect($("#f-decade"), decades.map(([d, n]) => [String(d), d === "none" ? "Year unknown" : `${d}s`, n]), "All decades", state.f.decade);
  const formats = [...countBy(state.records, (r) => r.format)].sort((a, b) => b[1] - a[1]);
  fillSelect($("#f-format"), formats.map(([f, n]) => [f, f, n]), "All formats", state.f.format);
  $("#f-format").parentElement.hidden = formats.length < 2;
}

function reflectFilters() {
  $("#f-q").value = state.f.q;
  for (const k of ["genre", "decade", "format", "sort"]) $(`#f-${k}`).value = state.f[k];
  $("#f-clear").hidden = !(state.f.q || state.f.genre || state.f.decade || state.f.format || state.f.bin || state.f.who);
  const wchip = $("#f-who");
  wchip.hidden = !state.f.who;
  if (state.f.who) {
    wchip.innerHTML = `With ${esc(state.f.who)} <button type="button" aria-label="Remove ${esc(state.f.who)} filter">×</button>`;
    wchip.querySelector("button").onclick = () => { state.f.who = ""; onFiltersChanged(); };
  }
  const chip = $("#f-bin");
  chip.hidden = !state.f.bin;
  if (state.f.bin) {
    chip.innerHTML = `${esc(binName(state.f.bin))} <button type="button" aria-label="Show all bins">×</button>`;
    chip.querySelector("button").onclick = () => { state.f.bin = ""; onFiltersChanged(); };
  }
}

function bindFilters() {
  let t;
  $("#f-q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.f.q = e.target.value.trim(); onFiltersChanged(); }, 140);
  });
  for (const k of ["genre", "decade", "format", "sort"]) {
    $(`#f-${k}`).addEventListener("change", (e) => { state.f[k] = e.target.value; onFiltersChanged(); });
  }
  $("#f-clear").addEventListener("click", () => {
    Object.assign(state.f, { q: "", genre: "", decade: "", format: "", bin: "", who: "" });
    onFiltersChanged();
  });
}

function onFiltersChanged() {
  state.galleryUid = null;
  state.listLimit = 150;
  syncUrl();
  reflectFilters();
  applyFilters();
  render();
}

// ------------------------------------------------------------------ render
function render() {
  $$(".tabs a").forEach((a) => { if (a.dataset.view === state.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $$(".tabs a").forEach((a) => { a.href = hashFor(a.dataset.view); });
  const n = state.records.length;
  $("#total-count").textContent = state.loaded ? `${fmtInt(n)} record${n === 1 ? "" : "s"}` : "";
  document.title = { gallery: "Records", list: "Records: list", shelves: "Records: shelves", stats: "Records: stats" }[state.view];
  $("#filters").hidden = state.view === "shelves";
  gallery.teardown();
  const main = $("#view");
  if (state.error) return void (main.innerHTML = emptyState("Couldn't load the collection", state.error));
  if (!state.loaded) return void (main.innerHTML = `<p class="empty">Loading…</p>`);
  if (!state.records.length) {
    return void (main.innerHTML = emptyState("No records yet",
      "Run <code>python -m app.sync</code> on the server to pull your collection from Discogs, then reload this page."));
  }
  if (!state.filtered.length && !["stats", "shelves"].includes(state.view)) {
    const inBin = state.f.bin && !(state.f.q || state.f.genre || state.f.decade || state.f.format);
    return void (main.innerHTML = inBin
      ? emptyState(`${binName(state.f.bin)} is empty`, `Nothing is filed here yet. <a href="#/shelves">Back to the shelves</a>.`)
      : emptyState("Nothing matches those filters",
        `Try a different search, or <a href="${hashFor(state.view, { q: "", genre: "", decade: "", format: "", bin: "" })}">clear the filters</a>.`));
  }
  ({ gallery: renderGallery, list: renderList, shelves: renderShelves, stats: renderStats })[state.view](main);
}

function emptyState(title, body) {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${body}</p></div>`;
}

// ------------------------------------------------------------------ gallery
const gallery = {
  pos: 0, target: 0, raf: 0, slots: new Map(), el: null, cleanup: [],
  teardown() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.cleanup.forEach((fn) => fn()); this.cleanup = [];
    this.slots.clear(); this.el = null;
  },
};

function renderGallery(main) {
  const list = state.filtered;
  let start = Math.max(0, list.findIndex((r) => r.uid === state.galleryUid));
  main.innerHTML = `
    <section class="crate-wrap" aria-label="Gallery">
      <div class="crate" id="crate" tabindex="0" role="listbox" aria-label="Records, use left and right arrow keys to flip"></div>
      <div class="now-playing" aria-live="polite"><h2 id="np-title"></h2><p id="np-artist"></p><p class="facts" id="np-facts"></p></div>
      <div class="scrub">
        <button class="step-btn" type="button" id="g-prev" aria-label="Previous record"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
        <input type="range" id="g-range" min="0" max="${list.length - 1}" value="${start}" aria-label="Position in crate">
        <button class="step-btn" type="button" id="g-next" aria-label="Next record"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
        <output id="g-pos" class="num"></output>
      </div>
      <p class="hint">Drag, scroll or use the arrow keys to flip. Click the front record for details.</p>
    </section>`;
  const crate = $("#crate");
  gallery.el = crate;
  gallery.pos = gallery.target = start;
  let lastShown = -1;

  const sizeOf = () => crate.querySelector(".slot")?.offsetWidth || crate.offsetHeight - 64;

  function layout() {
    const S = sizeOf();
    const from = Math.max(0, Math.floor(gallery.pos) - 8), to = Math.min(list.length - 1, Math.ceil(gallery.pos) + 8);
    for (const [i, el] of gallery.slots) if (i < from || i > to) { el.remove(); gallery.slots.delete(i); }
    for (let i = from; i <= to; i++) {
      let el = gallery.slots.get(i);
      if (!el) {
        el = document.createElement("button");
        el.type = "button"; el.className = "slot"; el.dataset.i = i; el.tabIndex = -1;
        el.setAttribute("aria-label", `${list[i].artist}, ${list[i].title}`);
        el.innerHTML = sleeve(list[i], { eager: Math.abs(i - gallery.pos) < 3 }) + `<span class="shade"></span>`;
        crate.appendChild(el);
        gallery.slots.set(i, el);
      }
      const d = i - gallery.pos, a = Math.abs(d), s = Math.sign(d);
      const near = Math.min(a, 1), far = Math.max(a - 1, 0);
      const x = s * (near * S * 0.6 + far * S * 0.16);
      const rot = -s * near * 62;
      const z = -near * S * 0.32 - far * 6;
      el.style.transform = `translate3d(${x}px,0,${z}px) rotateY(${rot}deg)`;
      el.style.zIndex = String(1000 - Math.round(a * 10));
      el.querySelector(".shade").style.opacity = String(Math.min(near * 0.28 + far * 0.06, 0.65));
      el.classList.toggle("center", i === gallery.target);
    }
    const shown = Math.round(gallery.pos);
    if (shown !== lastShown) { lastShown = shown; describe(shown); }
  }

  function describe(i) {
    const r = list[i];
    if (!r) return;
    state.galleryUid = r.uid;
    $("#np-title").textContent = r.title;
    $("#np-artist").textContent = r.artist;
    $("#np-facts").innerHTML = factsLine(r);
    $("#g-range").value = i;
    $("#g-pos").textContent = `${fmtInt(i + 1)} of ${fmtInt(list.length)}`;
    crate.setAttribute("aria-activedescendant", "");
  }

  function animate() {
    const diff = gallery.target - gallery.pos;
    if (reduceMotion || Math.abs(diff) < 0.002) gallery.pos = gallery.target;
    else gallery.pos += diff * 0.16;
    layout();
    gallery.raf = gallery.pos === gallery.target ? 0 : requestAnimationFrame(animate);
  }
  function go(i) {
    gallery.target = Math.max(0, Math.min(list.length - 1, Math.round(i)));
    if (!gallery.raf) gallery.raf = requestAnimationFrame(animate);
  }

  // pointer drag / swipe
  let drag = null, moved = false;
  crate.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, pos: gallery.pos, t: performance.now(), v: 0, lx: e.clientX, lt: performance.now() };
    moved = false;
  });
  const onMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!moved && Math.abs(dx) < 6) return;
    if (!moved) { moved = true; crate.setPointerCapture?.(e.pointerId); crate.classList.add("dragging"); }
    const now = performance.now();
    drag.v = (e.clientX - drag.lx) / Math.max(1, now - drag.lt);
    drag.lx = e.clientX; drag.lt = now;
    cancelAnimationFrame(gallery.raf); gallery.raf = 0;
    gallery.pos = Math.max(-0.4, Math.min(list.length - 0.6, drag.pos - dx / (sizeOf() * 0.3)));
    gallery.target = Math.round(gallery.pos);
    layout();
  };
  const onUp = () => {
    if (!drag) return;
    crate.classList.remove("dragging");
    if (moved) go(gallery.pos - drag.v * 4);
    drag = null;
  };
  crate.addEventListener("pointermove", onMove);
  crate.addEventListener("pointerup", onUp);
  crate.addEventListener("pointercancel", onUp);
  crate.addEventListener("click", (e) => {
    if (moved) { moved = false; return; }
    const slot = e.target.closest(".slot");
    if (!slot) return;
    const i = +slot.dataset.i;
    if (i === gallery.target) openDetail(list[i].uid, list);
    else go(i);
  });

  // wheel: trackpads send many small deltas; step once per ~50px
  let acc = 0, wheelT = 0;
  crate.addEventListener("wheel", (e) => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    e.preventDefault();
    acc += d;
    const now = performance.now();
    if (Math.abs(acc) >= 50 || (Math.abs(d) >= 50 && now - wheelT > 60)) {
      go(gallery.target + Math.sign(acc));
      acc = 0; wheelT = now;
    }
  }, { passive: false });

  const onKey = (e) => {
    if ($("#detail").open || e.target.matches("input, select, textarea")) return;
    const k = { ArrowRight: 1, ArrowLeft: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (k) { e.preventDefault(); go(gallery.target + k); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Enter" && document.activeElement === crate) openDetail(list[gallery.target].uid, list);
  };
  document.addEventListener("keydown", onKey);
  const onResize = () => layout();
  addEventListener("resize", onResize);
  gallery.cleanup.push(() => { document.removeEventListener("keydown", onKey); removeEventListener("resize", onResize); });

  $("#g-prev").onclick = () => go(gallery.target - 1);
  $("#g-next").onclick = () => go(gallery.target + 1);
  $("#g-range").addEventListener("input", (e) => go(+e.target.value));

  layout();
  requestAnimationFrame(layout); // after layout pass gives the real slot size
}

// ------------------------------------------------------------------ list
function renderList(main) {
  const list = state.filtered;
  const s = state.f.sort;
  const ariaSort = (key) => (s === key ? "ascending" : s === "-" + key ? "descending" : "none");
  const divided = s === "artist" || s === "title";
  let html = `<section class="list" aria-label="List">
    <div class="list-head" role="row">
      <span></span>
      <button type="button" data-sort="title" aria-sort="${ariaSort("title")}">Title</button>
      <button type="button" data-sort="artist" aria-sort="${ariaSort("artist")}">Artist</button>
      <button type="button" data-sort="year" aria-sort="${s === "year" ? "ascending" : s === "-year" ? "descending" : "none"}">Year</button>
      <span>Label</span><span>Genre</span><span>Bin</span>
    </div><div id="rows">`;
  let lastLetter = null;
  const shown = list.slice(0, state.listLimit);
  for (const r of shown) {
    if (divided) {
      const L = firstLetter(s === "artist" ? r.artist : r.title);
      if (L !== lastLetter) { html += `<h2 class="divider" aria-label="${L}">${L}</h2>`; lastLetter = L; }
    }
    html += `<button type="button" class="row" data-uid="${esc(r.uid)}">
      ${sleeve(r, { thumb: true })}
      <span class="t">${esc(r.title)}</span>
      <span class="a">${esc(r.artist)}</span>
      <span class="y">${r.year || ""}</span>
      <span class="l">${esc(r.label)}</span>
      <span class="g">${esc(r.genres[0] || "")}</span>
      <span class="b">${esc(r.bin)}</span>
    </button>`;
  }
  html += `</div>`;
  if (list.length > shown.length) {
    html += `<button type="button" class="btn list-more" id="more">Show ${fmtInt(Math.min(300, list.length - shown.length))} more (${fmtInt(list.length - shown.length)} left)</button>`;
  }
  html += `</section>`;
  main.innerHTML = html;

  main.querySelector(".list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) return openDetail(row.dataset.uid, list);
    const h = e.target.closest("[data-sort]");
    if (h) {
      const k = h.dataset.sort;
      state.f.sort = k === "year" ? (s === "year" ? "-year" : "year") : k;
      onFiltersChanged();
    }
  });
  const more = $("#more");
  if (more) {
    more.onclick = () => { const y = scrollY; state.listLimit += 300; render(); scrollTo(0, y); };
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((ents) => { if (ents[0].isIntersecting) { io.disconnect(); more.click(); } }, { rootMargin: "600px" });
      io.observe(more);
    }
  }
}

// ------------------------------------------------------------------ stats
function renderStats(main) {
  const list = state.filtered;
  if (!list.length) { main.innerHTML = emptyState("Nothing to chart", "No records match the current filters."); return; }
  const artists = countBy(list, (r) => r.artist);
  const years = list.map((r) => r.year).filter(Boolean);
  const oldest = list.filter((r) => r.year).sort((a, b) => a.year - b.year)[0];
  const dated = list.filter((r) => r.date_added).sort((a, b) => a.date_added.localeCompare(b.date_added));
  const firstAdded = dated[0]?.date_added?.slice(0, 4);
  const filteredNote = list.length !== state.records.length ? ` (filtered from ${fmtInt(state.records.length)})` : "";

  const genres = [...countBy(list, (r) => r.genres[0] || "Unknown")].sort((a, b) => b[1] - a[1]);
  const decades = [...countBy(list, (r) => decadeOf(r) ?? "none")].filter(([d]) => d !== "none").sort((a, b) => a[0] - b[0]);
  const undated = list.filter((r) => !r.year).length;
  const topArtists = [...artists].filter(([a]) => !/^various/i.test(a)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  const topLabels = [...countBy(list, (r) => r.label)].filter(([l]) => l && !/^not on label/i.test(l)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);

  const priced = list.filter((r) => r.price?.lowest != null);
  const priciest = [...priced].sort((a, b) => b.price.lowest - a.price.lowest).slice(0, 10);

  main.innerHTML = `<section class="stats" aria-label="Stats">
    <div class="wide facts" id="facts"></div>
    <div class="wide">${growthChart(dated)}</div>
    <div>${barList("By genre", "Primary Discogs genre. Select a bar to list those records.", genres, (g) => hashFor("list", { genre: g === "Unknown" ? "" : g, q: "" }))}</div>
    <div>${columns("By decade", `Release decade${undated ? `; ${fmtInt(undated)} without a year aren't shown` : ""}.`, decades, (d) => hashFor("list", { decade: String(d) }))}</div>
    <div>${barList("Most collected artists", "Excludes Various Artists compilations.", topArtists, (a) => hashFor("list", { q: a, genre: "", decade: "" , sort: "year" }))}</div>
    <div>${barList("Most collected labels", "First label credited on each release.", topLabels, (l) => hashFor("list", { q: l, genre: "", decade: "" }))}</div>
    ${peopleSections(list)}
    <div class="wide">${valueSection(list)}</div>
    ${priciest.length ? `<div>${barList("Priciest to replace",
      `Cheapest copy currently for sale on Discogs. ${fmtInt(priced.length)} of ${fmtInt(list.length)} records have a price so far; prices refresh in rotation, about weekly.`,
      priciest.map((r) => [`${r.title} (${r.artist})`, r.price.lowest, r.uid]), (k, row) => hashFor("stats", { r: row[2] }), (v) => money(v))}</div>` : ""}
  </section>`;
  wireGrowth(main, dated);
  wireValue(main);
  startFacts(main, buildFacts(list), list);
}


// ---- people behind the records
function topPeople(list, re, n = 10) {
  const counts = new Map();
  for (const r of list) {
    const names = new Set((r.credits || []).filter((c) => re.test(c.role)).map((c) => c.name));
    for (const nm of names) if (!/^various$/i.test(nm)) counts.set(nm, (counts.get(nm) || 0) + 1);
  }
  return [...counts].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function peopleSections(list) {
  const credited = list.filter((r) => r.credits?.length).length;
  if (!credited) {
    const running = state.sync?.running;
    return `<div class="wide"><h2>People behind the records</h2><p class="sub">${running
      ? `Collecting credits from Discogs now. This fills in when the sync finishes. <span id="people-progress">${esc(syncProgressText(state.sync))}</span>`
      : `Producers, engineers and band family trees need credits from Discogs, which haven't been collected yet. Press the sync button (top right) to start. The first run reads every record, so it takes about 20 minutes.`}</p></div>`;
  }
  const producers = topPeople(list, /^(co-)?producer$|^produced by$/i);
  const engineers = topPeople(list, /engineer|^recorded by$|^mixed by$/i);
  const mastering = topPeople(list, /^mastered by$|^lacquer cut by$/i);
  const note = credited < list.length ? ` Credits are in for ${fmtInt(credited)} of ${fmtInt(list.length)} records so far.` : "";
  const ids = new Set(list.flatMap((r) => r.artist_ids || []));
  const links = state.people.links.filter((l) => l.artists.filter((i) => ids.has(i)).length >= 2).slice(0, 12);
  let html = "";
  if (producers.length) html += `<div>${barList("Most credited producers", `Select a name to see their records.${note}`, producers, (k) => whoHref(k))}</div>`;
  if (engineers.length) html += `<div>${barList("Most credited engineers", "Recording, engineering and mixing credits.", engineers, (k) => whoHref(k))}</div>`;
  if (mastering.length) html += `<div>${barList("Mastered most often by", "Mastering and lacquer-cutting credits.", mastering, (k) => whoHref(k))}</div>`;
  if (links.length) {
    html += `<div><h2>Band family tree</h2><p class="sub">People who played in more than one band you own.</p>
      <ul class="tree">${links.map((l) => `<li><a class="who" href="${whoHref(l.name)}">${esc(l.name)}</a>
        <span>${l.artists.filter((i) => ids.has(i)).map((i) => `<a href="${artistHref(state.people.name.get(i))}">${esc(state.people.name.get(i))}</a>`).join(" · ")}</span></li>`).join("")}</ul></div>`;
  }
  return html;
}

// ---- collection value
function valueSection(list) {
  const h = state.meta.value_history || [];
  const filtered = list.length !== state.records.length;
  if (!h.length) {
    return `<h2>Collection value</h2><p class="sub">Shows up after the next sync. Discogs estimates it from what copies of your releases have actually sold for.</p>`;
  }
  const last = h[h.length - 1];
  const d = last.display || {};
  // change vs. ~30 days ago (or the oldest point we have)
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const base = [...h].reverse().find((x) => x.date <= cutoff) || h[0];
  let delta = "";
  if (base !== last && base.median != null && last.median != null) {
    const diff = last.median - base.median;
    const when = new Date(base.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    delta = diff === 0 ? `Unchanged since ${when}.` : `${diff > 0 ? "Up" : "Down"} ${money(Math.abs(diff))} since ${when}.`;
  }
  const updated = new Date(last.date + "T12:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric" });
  return `<h2>Collection value</h2>
    <div class="value-row">
      <p class="value-big num">${esc(d.median || money(last.median))}</p>
      <p class="sub">Median estimate from Discogs sales history, between ${esc(d.minimum || money(last.minimum))} and ${esc(d.maximum || money(last.maximum))}.
        ${esc(delta)} Updated ${esc(updated)}.${filtered ? " This is the whole collection; filters don't apply." : ""}</p>
    </div>
    ${h.length >= 2 ? `<div class="growth" id="value-chart"></div>` : `<p class="sub">A chart of how it changes appears after a couple of syncs.</p>`}`;
}

function wireValue(main) {
  const box = $("#value-chart", main);
  const h = (state.meta.value_history || []).filter((x) => x.median != null);
  if (!box || h.length < 2) return;
  const cur = state.meta.currency || "USD";
  let compactMoney;
  try { compactMoney = new Intl.NumberFormat(undefined, { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }); }
  catch { compactMoney = { format: (v) => compact(v) }; }
  const s = h.map((x) => ({ t: yearFrac(x.date), v: x.median, date: x.date, d: x.display || {} }));
  lineChart(box, s, {
    tick: (v) => compactMoney.format(v), end: (v) => money(v),
    tip: (p) => `${new Date(p.date + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}: <b>${esc(p.d.median || money(p.v))}</b> median`,
    aria: `Collection value over time, now ${money(s[s.length - 1].v)}`,
  });
}

// ---- factoids: one at a time, random start, rotating
const parseDur = (d) => {
  const parts = String(d || "").split(":").map(Number);
  if (!parts.length || parts.some(isNaN) || parts.length > 3) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};
const fmtLen = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
const monthYear = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
const dayDate = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

function buildFacts(list) {
  const facts = [];
  const add = (html) => { if (html) facts.push(html); };
  const link = (r) => `<a href="#" data-open="${esc(r.uid)}">${esc(r.title)}</a>`;
  const by = (r) => `${link(r)} by ${esc(r.artist)}`;
  const n = list.length;
  const artists = countBy(list, (r) => r.artist);
  const realArtists = [...artists].filter(([a]) => !/^various/i.test(a));
  const withYear = list.filter((r) => r.year);
  const dated = list.filter((r) => r.date_added).sort((a, b) => a.date_added.localeCompare(b.date_added));
  const pct = (k) => Math.round((k / n) * 100);

  add(`<b>${fmtInt(n)} records</b> by <b>${fmtInt(artists.size)} artists</b>${dated.length ? `, collected since ${dated[0].date_added.slice(0, 4)}` : ""}.`);
  if (withYear.length) {
    const sorted = [...withYear].sort((a, b) => a.year - b.year);
    add(`The oldest pressing on your shelves is ${by(sorted[0])}, from ${sorted[0].year}.`);
    const newest = sorted[sorted.length - 1];
    add(`The newest release you own is ${by(newest)}, from ${newest.year}.`);
    add(`Half your records came out before ${median(withYear.map((r) => r.year))}, and half after.`);
    const dec = [...countBy(withYear, decadeOf)].sort((a, b) => b[1] - a[1])[0];
    add(`${pct(dec[1])}% of your records were released in the ${dec[0]}s.`);
  }
  if (realArtists.length) {
    const [top, cnt] = realArtists.sort((a, b) => b[1] - a[1])[0];
    if (cnt > 1) add(`Your most collected artist is <b>${esc(top)}</b>, with ${cnt} records.`);
    const once = realArtists.filter(([, c]) => c === 1).length;
    add(`${fmtInt(once)} artists show up exactly once in your collection.`);
  }
  // longest career span among artists with 2+ records
  const spans = new Map();
  for (const r of withYear) {
    if (/^various/i.test(r.artist)) continue;
    const sp = spans.get(r.artist) || [r.year, r.year];
    spans.set(r.artist, [Math.min(sp[0], r.year), Math.max(sp[1], r.year)]);
  }
  const span = [...spans].sort((a, b) => (b[1][1] - b[1][0]) - (a[1][1] - a[1][0]))[0];
  if (span && span[1][1] - span[1][0] >= 10) {
    add(`Your records by <b>${esc(span[0])}</b> span ${span[1][1] - span[1][0]} years, from ${span[1][0]} to ${span[1][1]}.`);
  }
  const labels = [...countBy(list, (r) => r.label)].filter(([l]) => l && !/^not on label/i.test(l)).sort((a, b) => b[1] - a[1]);
  if (labels.length && labels[0][1] > 2) add(`<b>${esc(labels[0][0])}</b> is the label you own the most of: ${labels[0][1]} records.`);
  const genres = [...countBy(list, (r) => r.genres[0])].sort((a, b) => b[1] - a[1]);
  if (genres.length) add(`${pct(genres[0][1])}% of the collection is filed under ${esc(genres[0][0])} on Discogs.`);
  const styles = [...countBy(list, (r) => r.styles)].sort((a, b) => b[1] - a[1]);
  if (styles.length) add(`Your most common style is <b>${esc(styles[0][0])}</b>, on ${fmtInt(styles[0][1])} records.`);

  if (dated.length) {
    const yearsAdded = [...countBy(dated, (r) => r.date_added.slice(0, 4))].sort((a, b) => b[1] - a[1]);
    add(`${yearsAdded[0][0]} was your biggest year: you added ${fmtInt(yearsAdded[0][1])} records.`);
    const days = [...countBy(dated, (r) => r.date_added.slice(0, 10))].sort((a, b) => b[1] - a[1]);
    if (days[0][1] >= 3) add(`On ${dayDate(days[0][0])} you added ${days[0][1]} records in a single day.`);
    const thisYear = String(new Date().getFullYear());
    const ytd = dated.filter((r) => r.date_added.startsWith(thisYear)).length;
    if (ytd) add(`You've added ${fmtInt(ytd)} record${ytd === 1 ? "" : "s"} so far in ${thisYear}.`);
    add(`The first record you logged on Discogs was ${by(dated[0])}, back in ${monthYear(dated[0].date_added)}.`);
    const latest = dated[dated.length - 1];
    add(`Your latest addition is ${by(latest)}.`);
  }
  // listening time
  let tracks = 0, secs = 0, longest = null;
  for (const r of list) {
    tracks += r.tracklist.length;
    const len = r.tracklist.reduce((a, t) => a + parseDur(t.duration), 0);
    secs += len;
    if (r.tracklist.length >= 3 && (!longest || len > longest[1])) longest = [r, len];
  }
  if (tracks > 50) add(`Your tracklists add up to ${fmtInt(tracks)} tracks.`);
  if (secs > 36000) add(`The tracks with listed timings come to about ${fmtInt(Math.round(secs / 86400))} days of music, played back to back.`);
  if (longest && longest[1] > 3600) add(`The longest record by running time is ${by(longest[0])}, at ${fmtLen(longest[1])}.`);
  const selfTitled = list.filter((r) => r.title.toLowerCase() === r.artist.toLowerCase());
  if (selfTitled.length >= 3) add(`${selfTitled.length} of your records are self-titled, like ${by(selfTitled[Math.floor(Math.random() * selfTitled.length)])}.`);
  const longTitle = [...list].sort((a, b) => b.title.length - a.title.length)[0];
  if (longTitle && longTitle.title.length > 40) add(`Longest title in the collection: ${by(longTitle)}.`);
  if (n >= 365) add(`Playing one record a day, it would take you ${(n / 365).toFixed(1)} years to hear them all.`);
  const qty = list.reduce((a, r) => a + (r.qty || 1), 0);
  const metres = qty * 0.0035; // an LP in its jacket is about 3.5 mm thick
  if (metres >= 1) add(`Stacked flat, your records would stand about ${Math.round(metres * 3.281)} feet (${metres.toFixed(1)} m) tall.`);
  // ---- weight
  const fallbackGrams = (r) => (r.qty || 1) * ({ Vinyl: 230, CD: 100, Cassette: 60 }[r.format] || 200);
  const grams = list.reduce((a, r) => a + (r.weight || fallbackGrams(r)), 0);
  const kg = grams / 1000;
  if (kg >= 5) {
    const things = [[30, "a Labrador retriever"], [70, "an adult person"], [100, "a newborn elephant"], [150, "a giant panda"],
      [250, "a baby grand piano"], [300, "a grizzly bear"], [450, "a concert grand piano"], [550, "a horse"],
      [700, "a dairy cow"], [1300, "a small car"], [2300, "a rhinoceros"]];
    const [, thing] = things.reduce((best, t) => (Math.abs(Math.log(t[0] / kg)) < Math.abs(Math.log(best[0] / kg)) ? t : best));
    add(`All together your records weigh about <b>${fmtInt(Math.round(kg))} kg</b> (${fmtInt(Math.round(kg * 2.205))} lb). That's roughly ${thing}.`);
  }
  // ---- people
  const ids = new Set(list.flatMap((r) => r.artist_ids || []));
  const nameOf = (i) => esc(state.people.name.get(i) || "?");
  const plist = (arr) => arr.length > 2 ? `${arr.slice(0, -1).join(", ")} and ${arr[arr.length - 1]}` : arr.join(" and ");
  const links = state.people.links.map((l) => ({ ...l, artists: l.artists.filter((i) => ids.has(i)) })).filter((l) => l.artists.length >= 2);
  if (links.length) {
    const bands = new Set(links.flatMap((l) => l.artists));
    add(`<b>${fmtInt(bands.size)} artists</b> in your collection share at least one member with another artist you own.`);
    const top = links[0];
    const shown = top.artists.slice(0, 4).map(nameOf);
    if (top.artists.length > 4) shown.push(`${top.artists.length - 4} more`);
    add(`<a href="${whoHref(top.name)}">${esc(top.name)}</a> connects ${plist(shown)} in your collection.`);
    if (links.length > 1) {
      const l = links[1 + Math.floor(Math.random() * (links.length - 1))];
      add(`<a href="${whoHref(l.name)}">${esc(l.name)}</a> played in both ${nameOf(l.artists[0])} and ${nameOf(l.artists[1])}.`);
    }
  }
  const prod = topPeople(list, /^(co-)?producer$|^produced by$/i, 1)[0];
  if (prod) add(`<a href="${whoHref(prod[0])}">${esc(prod[0])}</a> produced ${prod[1]} of your records, more than anyone else.`);
  const eng = topPeople(list, /engineer|^recorded by$|^mixed by$/i, 1)[0];
  if (eng) add(`<a href="${whoHref(eng[0])}">${esc(eng[0])}</a> recorded, engineered or mixed ${eng[1]} of your records.`);
  const mast = topPeople(list, /^mastered by$|^lacquer cut by$/i, 1)[0];
  if (mast && mast[1] >= 3) add(`${mast[1]} of your records were mastered by <a href="${whoHref(mast[0])}">${esc(mast[0])}</a>.`);
  // ---- Discogs community
  const comm = list.filter((r) => r.community && r.community.have > 0);
  if (comm.length) {
    const rare = comm.reduce((a, b) => (b.community.have < a.community.have ? b : a));
    add(`Only ${fmtInt(rare.community.have)} people on Discogs own ${by(rare)}. You're one of them.`);
    const wanted = comm.reduce((a, b) => (b.community.want > a.community.want ? b : a));
    add(`${by(wanted)} is on <b>${fmtInt(wanted.community.want)}</b> Discogs wantlists.`);
    const common = comm.reduce((a, b) => (b.community.have > a.community.have ? b : a));
    add(`${by(common)} is in ${fmtInt(common.community.have)} Discogs collections, the most common record you own.`);
    const rated = comm.filter((r) => r.community.votes >= 25);
    if (rated.length) {
      const best = rated.reduce((a, b) => (b.community.rating > a.community.rating ? b : a));
      add(`Discogs users rate ${by(best)} the highest of anything you own: ${best.community.rating.toFixed(2)} out of 5.`);
    }
  }
  // ---- pressings
  const plants = [...countBy(list, (r) => (r.companies || []).filter((c) => /pressed by/i.test(c.role)).map((c) => c.name))].sort((a, b) => b[1] - a[1]);
  if (plants.length && plants[0][1] >= 3) add(`${plants[0][1]} of your records were pressed at <b>${esc(plants[0][0])}</b>.`);
  const vinyl = list.filter((r) => r.format === "Vinyl");
  const fmtTxt = (r) => `${r.format_detail || ""} ${r.format_text || ""}`;
  const COLOR = /\b(red|blue|green|yellow|orange|purple|pink|white|clear|gold|silver|gr[ae]y|brown|bone|cream|teal|aqua|olive|tan|magenta|violet|maroon|turquoise|lavender|mint|coke bottle|picture disc)\b/gi;
  const colorWords = new Map();
  let colored = 0;
  for (const r of vinyl) {
    const words = [...new Set((fmtTxt(r).match(COLOR) || []).map((w) => w.toLowerCase().replace("grey", "gray")))];
    if (words.length) { colored++; for (const w of words) colorWords.set(w, (colorWords.get(w) || 0) + 1); }
  }
  if (colored >= 3) {
    const fav = [...colorWords].sort((a, b) => b[1] - a[1])[0][0];
    add(`<b>${fmtInt(colored)}</b> of your records are on colored vinyl. The most popular color is ${esc(fav)}.`);
  }
  const heavy = vinyl.filter((r) => /180\s*g/i.test(fmtTxt(r))).length;
  if (heavy >= 3) add(`${fmtInt(heavy)} of your records are pressed on heavyweight 180-gram vinyl.`);
  const reissues = list.filter((r) => /reissue|repress/i.test(r.format_detail || "")).length;
  if (reissues >= 5) add(`${pct(reissues)}% of your records are reissues or represses.`);
  const tests = list.filter((r) => /test pressing/i.test(fmtTxt(r)));
  if (tests.length) add(`You own ${tests.length === 1 ? "a test pressing" : `${tests.length} test pressings`}, including ${by(tests[0])}.`);
  const limited = list.filter((r) => /limited edition/i.test(r.format_detail || "")).length;
  if (limited >= 5) add(`${fmtInt(limited)} of your records are limited editions.`);
  const discs = vinyl.reduce((a, r) => a + (r.qty || 1), 0);
  if (discs > vinyl.length) add(`Counting double albums and box sets, that's ${fmtInt(discs)} slabs of vinyl and ${fmtInt(discs * 2)} sides to flip.`);
  const countries = [...countBy(list, (r) => r.country)].sort((a, b) => b[1] - a[1]);
  if (countries.length >= 3) add(`Your records were pressed for ${countries.length} countries and regions. Most are from ${/^(US|UK)$/.test(countries[0][0]) ? "the " : ""}${esc(countries[0][0])}.`);
  // ---- time
  const lags = withYear.filter((r) => r.date_added && r.year >= 1900).map((r) => [r, +r.date_added.slice(0, 4) - r.year]).filter(([, l]) => l >= 0);
  if (lags.length) {
    const [r, lag] = lags.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (lag >= 10) add(`You added ${by(r)} to your collection ${lag} years after it came out.`);
  }
  if (withYear.length) {
    const avgAge = Math.round(withYear.reduce((a, r) => a + (new Date().getFullYear() - r.year), 0) / withYear.length);
    add(`The average record on your shelves is ${avgAge} years old.`);
  }
  // ---- alphabet & titles & tracks
  const letters = new Map();
  for (const a of artists.keys()) { const L = firstLetter(a); if (L !== "#") letters.set(L, (letters.get(L) || 0) + 1); }
  const missing = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((L) => !letters.has(L));
  if (missing.length && missing.length <= 6) add(`No artist in your collection starts with ${plist(missing)}.`);
  const busiestL = [...letters].sort((a, b) => b[1] - a[1])[0];
  if (busiestL) add(`${busiestL[0]} is your most crowded letter: ${busiestL[1]} artists file under it.`);
  const STOP = new Set("the and of a an in on to for from with my your our is it at by vol volume live part edition remastered deluxe".split(" "));
  const words = new Map();
  for (const r of list) for (const w of new Set(r.title.toLowerCase().match(/[a-z']{4,}/g) || [])) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1);
  const word = [...words].sort((a, b) => b[1] - a[1])[0];
  if (word && word[1] >= 4) add(`The word “${esc(word[0])}” turns up in ${word[1]} of your album titles.`);
  let shortest = null, longestT = null, mostTracks = null;
  for (const r of list) {
    if (!mostTracks || r.tracklist.length > mostTracks.tracklist.length) mostTracks = r;
    for (const t of r.tracklist) {
      const sec = parseDur(t.duration);
      if (sec >= 1 && (!shortest || sec < shortest[2])) shortest = [r, t, sec];
      if (sec >= 1 && (!longestT || sec > longestT[2])) longestT = [r, t, sec];
    }
  }
  const mmss = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
  if (shortest && shortest[2] < 60) add(`The shortest track you own is “${esc(shortest[1].title)}” on ${by(shortest[0])}, all ${mmss(shortest[2])} of it.`);
  if (longestT && longestT[2] > 900) add(`The longest single track you own is “${esc(longestT[1].title)}” on ${by(longestT[0])}, at ${mmss(longestT[2])}.`);
  if (mostTracks && mostTracks.tracklist.length >= 25) add(`${by(mostTracks)} packs in ${mostTracks.tracklist.length} tracks, more than any other record you own.`);
  if (styles.length >= 10) add(`Your records cover ${fmtInt(styles.length)} different styles.`);
  // ---- shelves
  if (state.shelves && Object.keys(state.shelves.starts).length) {
    const bins = [...countBy(list.filter((r) => /^\d+$/.test(r._bin || "")), (r) => r._bin)].sort((a, b) => b[1] - a[1]);
    if (bins.length) add(`${esc(binName(bins[0][0]))} is your fullest cubby, with ${bins[0][1]} records.`);
  }
  // money
  const h = state.meta.value_history || [];
  if (h.length && h[h.length - 1].display?.median) add(`Discogs puts your collection's median value at <b>${esc(h[h.length - 1].display.median)}</b>.`);
  if (h.length && h[h.length - 1].median && kg >= 5) add(`Pound for pound, your collection is worth about ${money(h[h.length - 1].median / (kg * 2.205))} per pound.`);
  const priced = list.filter((r) => r.price?.lowest != null).sort((a, b) => b.price.lowest - a.price.lowest);
  if (priced.length) add(`Hardest to replace: ${by(priced[0])}. The cheapest copy for sale right now is ${money(priced[0].price.lowest, priced[0].price.currency)}.`);
  const pick = list[Math.floor(Math.random() * n)];
  if (pick) add(`Pulled from the crate at random: ${by(pick)}${pick.year ? ` (${pick.year})` : ""}.`);
  return facts;
}

function startFacts(main, facts, list) {
  const box = $("#facts", main);
  if (!box || !facts.length) return;
  // a random fact on every visit, then the rest in shuffled order
  const order = facts.map((_, i) => i);
  for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
  let i = 0, paused = false, timer = 0;
  box.innerHTML = `<p class="fact" id="fact-text"></p>
    <div class="fact-nav"><button type="button" class="text-btn" id="fact-next">Another fact</button><span class="fact-count num" id="fact-count"></span></div>`;
  const show = () => {
    const el = $("#fact-text", box);
    el.classList.remove("in"); void el.offsetWidth; el.classList.add("in");
    el.innerHTML = facts[order[i]];
    $("#fact-count", box).textContent = `${i + 1} of ${facts.length}`;
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!reduceMotion) timer = setTimeout(() => { if (!paused && !document.hidden) { i = (i + 1) % facts.length; show(); } schedule(); }, 9000);
  };
  box.addEventListener("pointerenter", () => { paused = true; });
  box.addEventListener("pointerleave", () => { paused = false; });
  box.addEventListener("focusin", () => { paused = true; });
  box.addEventListener("focusout", () => { paused = false; });
  $("#fact-next", box).addEventListener("click", () => { i = (i + 1) % facts.length; show(); schedule(); });
  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-open]");
    if (a) { e.preventDefault(); openDetail(a.dataset.open, list); }
  });
  show();
  schedule();
  gallery.cleanup.push(() => clearTimeout(timer));
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function tableOf(rows, h1, h2) {
  return `<details><summary>Show as table</summary><table><thead><tr><th>${h1}</th><th>${h2}</th></tr></thead><tbody>${
    rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${typeof v === "number" ? fmtInt(v) : esc(v)}</td></tr>`).join("")}</tbody></table></details>`;
}

function barList(title, sub, rows, hrefFor, fmt = fmtInt) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return `<h2>${esc(title)}</h2><p class="sub">${esc(sub)}</p><div class="bars">${rows.map((row) => { const [k, v] = row; return `
    <a class="bar-row" href="${hrefFor(k, row)}" title="${esc(k)}: ${fmt(v)}">
      <span class="name">${esc(k)}</span>
      <span class="track"><span class="fill" style="width:calc((100% - 7ch) * ${v / max})"></span><span class="val">${fmt(v)}</span></span>
    </a>`; }).join("")}</div>${tableOf(rows.map((r) => [r[0], fmt(r[1])]), "Name", fmt === fmtInt ? "Records" : "Price")}`;
}

function columns(title, sub, rows, hrefFor) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return `<h2>${esc(title)}</h2><p class="sub">${esc(sub)}</p>
    <div class="cols">${rows.map(([d, v]) => `
      <a class="col" href="${hrefFor(d)}" title="${d}s: ${fmtInt(v)}"><span class="val">${fmtInt(v)}</span><span class="fill" style="height:calc((100% - 22px) * ${v / max})"></span></a>`).join("")}</div>
    <div class="col-labels">${rows.map(([d]) => `<span>${String(d).slice(2)}s</span>`).join("")}</div>
    ${tableOf(rows.map(([d, v]) => [`${d}s`, v]), "Decade", "Records")}`;
}

function growthSeries(dated) {
  // cumulative count at the end of each month
  const months = new Map();
  for (const r of dated) { const m = r.date_added.slice(0, 7); months.set(m, (months.get(m) || 0) + 1); }
  const keys = [...months.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  let [y, m] = keys[0].split("-").map(Number), total = 0;
  // run the line up to this month, not just the last month something was added
  const now = new Date();
  const lastKey = keys[keys.length - 1];
  const nowKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [ey, em] = (nowKey > lastKey ? nowKey : lastKey).split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    total += months.get(k) || 0;
    out.push({ k, total, added: months.get(k) || 0, t: y + (m - 1) / 12 });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function growthChart(dated) {
  const s = growthSeries(dated);
  if (s.length < 2) return "";
  return `<h2>Collection over time</h2><p class="sub">Records in the collection, by the month they were added to Discogs.</p>
    <div class="growth" id="growth"></div>
    ${tableOf(s.filter((p) => p.k.endsWith("-12") || p === s[s.length - 1]).map((p) => [p.k.slice(0, 4), p.total]), "End of", "Records")}`;
}

function wireGrowth(main, dated) {
  const box = $("#growth", main);
  if (!box) return;
  const s = growthSeries(dated).map((p) => ({ ...p, v: p.total }));
  const monthName = (k) => new Date(k + "-01T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" });
  lineChart(box, s, {
    tick: compact, end: fmtInt,
    tip: (p) => `${monthName(p.k)}: <b>${fmtInt(p.total)}</b> records${p.added ? `, +${p.added} that month` : ""}`,
    aria: `Collection size over time, reaching ${s[s.length - 1].total} records`,
  });
}

const yearFrac = (iso) => { const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso); const y = d.getFullYear(); return y + (d - new Date(y, 0, 1)) / (365.25 * 864e5); };

// A single-series line chart with a crosshair tooltip. s: [{t (fractional year), v, ...}]
function lineChart(box, s, o) {
  const draw = () => {
    const W = box.clientWidth, H = 260, L = 52, R = 72, T = 12, B = 28;
    const x0 = s[0].t, x1 = s[s.length - 1].t, ymax = niceMax(Math.max(...s.map((p) => p.v)));
    const X = (t) => L + ((t - x0) / (x1 - x0 || 1)) * (W - L - R);
    const Y = (v) => T + (1 - v / ymax) * (H - T - B);
    const ticks = [0, ymax / 4, ymax / 2, (3 * ymax) / 4, ymax];
    // x labels: years for long spans, months for short ones
    const xl = [];
    if (x1 - x0 >= 1.5) {
      const step = Math.max(1, Math.ceil((x1 - x0) / Math.max(2, Math.floor((W - L - R) / 70))));
      for (let yv = Math.ceil(x0); yv <= x1; yv += step) xl.push([yv, String(yv)]);
    } else {
      const months = Math.max(1, Math.ceil(((x1 - x0) * 12) / Math.max(2, Math.floor((W - L - R) / 60))));
      const d = new Date(Math.floor(x0), Math.round((x0 % 1) * 12), 1);
      for (; yearFrac(d.toISOString()) <= x1 + 0.001; d.setMonth(d.getMonth() + months)) {
        const t = d.getFullYear() + d.getMonth() / 12;
        if (t >= x0 - 0.001) xl.push([t, d.toLocaleDateString(undefined, { month: "short" })]);
      }
    }
    const pts = s.map((p) => `${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`);
    const last = s[s.length - 1];
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria)}">
      <g class="grid">${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("")}</g>
      <g class="axis">${ticks.map((v) => `<text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${o.tick(v)}</text>`).join("")}
        ${xl.map(([t, label]) => `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${label}</text>`).join("")}</g>
      <path class="area" d="M${pts[0]} L${pts.join(" L")} L${X(last.t)},${Y(0)} L${X(s[0].t)},${Y(0)} Z"/>
      <path class="line" d="M${pts.join(" L")}"/>
      <g class="end"><circle class="dot" cx="${X(last.t)}" cy="${Y(last.v)}" r="4.5"/><text x="${X(last.t) + 10}" y="${Y(last.v) + 4}">${o.end(last.v)}</text></g>
      <g class="hover" visibility="hidden"><line class="cross" y1="${T}" y2="${H - B}"/><circle class="dot" r="4.5"/></g>
      <rect x="${L}" y="${T}" width="${Math.max(1, W - L - R)}" height="${H - T - B}" fill="transparent" class="hit"/>
    </svg><div class="tip" hidden></div>`;
    const hover = $(".hover", box), tip = $(".tip", box), hit = $(".hit", box);
    hit.addEventListener("pointermove", (e) => {
      const rect = box.getBoundingClientRect();
      const t = x0 + ((e.clientX - rect.left - L) / (W - L - R)) * (x1 - x0);
      const p = s.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      const cx = X(p.t), cy = Y(p.v);
      hover.setAttribute("visibility", "visible");
      hover.querySelector("line").setAttribute("x1", cx); hover.querySelector("line").setAttribute("x2", cx);
      hover.querySelector("circle").setAttribute("cx", cx); hover.querySelector("circle").setAttribute("cy", cy);
      tip.hidden = false;
      tip.style.left = `${cx}px`; tip.style.top = `${cy}px`;
      tip.innerHTML = o.tip(p);
    });
    hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });
  };
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
  gallery.cleanup.push(() => ro.disconnect());
}
const niceMax = (v) => {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((c) => c >= v) || 1;
};
const compact = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : String(Math.round(v)));

// ------------------------------------------------------------------ detail
let detailList = [];

// The cover panel: main image, every Discogs photo as a strip, and the back-cover picker.
// Discogs doesn't say which photo is the back, so the user picks it once and it's remembered.
const art = { r: null, shown: 0, msg: "" };

function paintArt(animate = true) {
  const box = $("#d-art");
  const r = art.r;
  if (!box || !r) return;
  const n = r.photos || 1, back = r.back, shown = art.shown;
  const isBack = back != null && shown === back;
  const what = shown === 0 ? "Front cover" : isBack ? "Back cover" : `Photo ${shown + 1} of ${n}`;
  let flipControl;
  if (back != null) flipControl = `<button type="button" class="text-btn" data-photo="${isBack ? 0 : back}">${isBack ? "Show front" : "Show back"}</button>`;
  else flipControl = "";
  let picker = "";
  if (shown > 0 && state.meta.can_edit) {
    picker = isBack
      ? `<p class="pick">Marked as the back cover. <button type="button" class="text-btn" data-back="clear">Undo</button></p>`
      : `<p class="pick"><button type="button" class="btn" data-back="${shown}">Use as back cover</button></p>`;
  } else if (shown === 0 && back == null && n > 1 && state.meta.can_edit) {
    picker = `<p class="pick hint-text">Discogs doesn't label which photo is the back. Tap it in the photos above, then choose “Use as back cover”.</p>`;
  }
  box.innerHTML = `
    <button type="button" class="viewer ${animate ? "turn" : ""}" ${back != null ? `data-photo="${isBack ? 0 : back}"` : "disabled"}
      aria-label="${what}${back != null ? (isBack ? ", show front" : ", show back") : ""}">${sleeve(r, { photo: shown, eager: true })}</button>
    <div class="art-actions">${flipControl}<span class="what">${what}</span>
      <a class="text-btn" href="https://www.discogs.com/release/${r.id}" target="_blank" rel="noopener">View on Discogs</a></div>
    ${n > 1 ? `<div class="photo-strip" role="group" aria-label="Photos from Discogs">${Array.from({ length: n }, (_, i) => `
      <button type="button" class="thumb ${i === shown ? "on" : ""}" data-photo="${i}" aria-label="Photo ${i + 1}${i === 0 ? ", front cover" : i === back ? ", back cover" : ""}" aria-pressed="${i === shown}">
        <img src="/img/${r.id}/${i === 0 ? "front" : i}?size=thumb" alt="" loading="lazy" decoding="async">
        ${i === 0 ? `<span class="tag">Front</span>` : i === back ? `<span class="tag">Back</span>` : ""}
      </button>`).join("")}</div>` : ""}
    ${picker}
    ${art.msg ? `<p class="pick err">${esc(art.msg)}</p>` : ""}`;
  box.querySelector(".thumb.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function binHelp(r) {
  if (!state.meta.can_edit) return "";
  if (r.bin) return "Set by hand. Clear it to file automatically.";
  if (r._bin) return `Filed automatically in ${esc(binName(r._bin))}`;
  return "Where it lives on the shelf";
}

const money = (v, cur = state.meta.currency || "USD") => {
  if (v == null || isNaN(v)) return "";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: v >= 100 ? 0 : 2 }).format(v); }
  catch { return `${cur} ${(+v).toFixed(2)}`; }
};

function priceFact(r) {
  const p = r.price;
  if (!p) return "";
  const when = p.checked ? new Date(p.checked + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const listings = `https://www.discogs.com/sell/release/${r.id}`;
  const body = p.lowest != null
    ? `From <b>${money(p.lowest, p.currency)}</b> · <a href="${listings}" target="_blank" rel="noopener">${fmtInt(p.for_sale)} for sale</a>`
    : `None for sale right now`;
  return `<dt>Market</dt><dd class="price-field">${body}<span class="spark" id="d-spark"></span><small>${when ? `checked ${esc(when)}` : ""}</small></dd>`;
}

async function loadSparkline(r) {
  const el = $("#d-spark");
  if (!el) return;
  try {
    const { history } = await (await fetch(`/api/prices/${r.id}`)).json();
    const pts = (history || []).filter((h) => h[1] != null);
    if (pts.length < 2 || art.r?.id !== r.id) return;
    const W = 72, H = 20, vs = pts.map((h) => h[1]), lo = Math.min(...vs), hi = Math.max(...vs);
    const xy = pts.map((h, i) => `${(i / (pts.length - 1)) * W},${H - 2 - ((h[1] - lo) / (hi - lo || 1)) * (H - 4)}`);
    const first = vs[0], last = vs[vs.length - 1];
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Lowest price went from ${money(first)} to ${money(last)}"><polyline points="${xy.join(" ")}" fill="none" stroke="var(--chart)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    el.title = `${money(first)} → ${money(last)} since ${pts[0][0]}`;
  } catch { /* sparkline is optional */ }
}

async function setBack(photo) {
  const r = art.r;
  art.msg = "";
  try {
    const res = await fetch(`/api/backs/${r.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photo }) });
    if (!res.ok) throw new Error(res.status === 403 ? "Editing is locked on this server" : `Server answered ${res.status}`);
    const out = await res.json();
    for (const x of state.records) if (x.id === r.id) x.back = out.back ?? null;
  } catch (err) {
    art.msg = `Not saved: ${err.message}`;
  }
  paintArt(false);
}



function openDetail(uid, list = state.filtered) {
  const r = state.byUid.get(uid);
  if (!r) return;
  detailList = list;
  const dlg = $("#detail");
  const i = list.findIndex((x) => x.uid === uid);
  const prev = list[i - 1], next = list[i + 1];
  const added = r.date_added ? new Date(r.date_added).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
  const tracks = r.tracklist || [];
  const discogs = `https://www.discogs.com/release/${r.id}`;
  const fact = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
  dlg.innerHTML = `<div class="d-grid">
    <div class="d-art" id="d-art"></div>
    <div class="d-body">
      <div class="d-top">
        <div><h2 class="d-title" id="d-title">${esc(r.title)}</h2>
        <p class="d-artist"><a href="${hashFor("list", { q: r.artist, genre: "", decade: "", format: "", sort: "year" })}">${esc(r.artist)}</a></p></div>
        <button type="button" class="icon-btn" id="d-close" aria-label="Close"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <dl class="facts-list">
        ${fact("Released", esc([r.released && r.released !== String(r.year) ? r.released : r.year, r.country].filter(Boolean).join(", ")))}
        ${fact("Label", r.label ? `<a href="${hashFor("list", { q: r.label, genre: "", decade: "", format: "" })}">${esc(r.label)}</a>${r.catno ? ` <span class="num">${esc(r.catno)}</span>` : ""}` : "")}
        ${fact("Format", esc([r.format, r.format_detail, r.format_text].filter(Boolean).join(", ")))}
        ${fact("Genre", r.genres.length ? `<span class="chips">${r.genres.map((g) => `<a class="chip" href="${hashFor("list", { genre: g, q: "", decade: "" })}">${esc(g)}</a>`).join("")}</span>` : "")}
        ${fact("Style", esc(r.styles.join(", ")))}
        ${fact("Added", esc(added))}
        ${priceFact(r)}
        ${communityFact(r)}
        <dt><label for="d-bin">Bin</label></dt>
        <dd class="bin-field"><input id="d-bin" value="${esc(r.bin)}" maxlength="40" placeholder="${esc(r.bin ? "" : (r._bin ? binName(r._bin) : "—"))}" list="bin-labels" autocomplete="off" ${state.meta.can_edit ? "" : "disabled"}><small id="d-bin-msg">${binHelp(r)}</small></dd>
      </dl>
      <div class="tracks"><h3>Tracklist</h3>${tracks.length
        ? `<ol>${tracks.map((t, n) => `<li><span class="pos">${esc(t.position || n + 1)}</span><span>${esc(t.title)}</span><span class="dur">${esc(t.duration)}</span></li>`).join("")}</ol>`
        : `<p class="none">No tracklist yet. It's filled in by the next Discogs sync.</p>`}</div>
      ${creditsHtml(r)}
      <div class="d-nav">
        <button type="button" class="btn" id="d-prev" ${prev ? "" : "disabled"}>Previous</button>
        <button type="button" class="btn" id="d-next" ${next ? "" : "disabled"}>Next</button>
      </div>
    </div>
  </div>`;
  if (!dlg.open) dlg.showModal();
  dlg.focus(); // focus the sheet itself, not the first link in it
  dlg.scrollTop = 0;
  syncUrl({ r: uid });

  art.r = r;
  art.shown = 0;
  art.msg = "";
  paintArt(false);
  loadSparkline(r);
  $("#d-close").onclick = closeDetail;
  if (prev) $("#d-prev").onclick = () => step(prev);
  if (next) $("#d-next").onclick = () => step(next);
  const bin = $("#d-bin");
  const saveBin = async () => {
    const v = bin.value.trim();
    if (v === r.bin) return;
    $("#d-bin-msg").textContent = "Saving…";
    try {
      const res = await fetch(`/api/bins/${r.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bin: v }) });
      if (!res.ok) throw new Error(res.status === 403 ? "Editing is locked on this server" : `Server answered ${res.status}`);
      const out = await res.json();
      for (const x of state.records) if (x.id === r.id) x.bin = out.bin;
      computeBins();
      bin.value = r.bin;
      bin.placeholder = r.bin ? "" : (r._bin ? binName(r._bin) : "—");
      $("#d-bin-msg").textContent = r.bin ? "Saved" : `Saved. ${binHelp(r)}`;
    } catch (err) {
      $("#d-bin-msg").textContent = `Not saved: ${err.message}`;
    }
  };
  bin.addEventListener("change", saveBin);
  bin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); bin.blur(); } });

  function step(target) {
    openDetail(target.uid, detailList);
    if (state.view === "gallery" && gallery.el) { state.galleryUid = target.uid; }
  }
}

function closeDetail() {
  const dlg = $("#detail");
  if (dlg.open) dlg.close();
}

function bindDetail() {
  const dlg = $("#detail");
  dlg.addEventListener("close", () => {
    syncUrl();
    if (state.view === "gallery" && state.galleryUid) render(); // land the crate on the last viewed record
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) return closeDetail(); // backdrop
    const p = e.target.closest("[data-photo]");
    if (p && !p.disabled) { art.shown = +p.dataset.photo; art.msg = ""; return paintArt(); }
    const b = e.target.closest("[data-back]");
    if (b) setBack(b.dataset.back === "clear" ? null : +b.dataset.back);
  });
  document.addEventListener("keydown", (e) => {
    if (!dlg.open || e.target.matches("input")) return;
    if (e.key === "ArrowRight") $("#d-next")?.click();
    if (e.key === "ArrowLeft") $("#d-prev")?.click();
  });
}


// ------------------------------------------------------------------ people
// Who's on each record (credits, the artist, the band's members), and which artists in the
// collection are connected because the same person played in both.
const whoHref = (name) => hashFor("list", { who: name, q: "", genre: "", decade: "", format: "", bin: "", sort: "year" });
const artistHref = (name) => hashFor("list", { q: name, who: "", genre: "", decade: "", format: "", bin: "", sort: "year" });

function computePeople() {
  const A = state.meta.artists || {};
  const name = new Map();            // collection artist id -> display name
  const recordsBy = new Map();       // collection artist id -> record count
  for (const r of state.records) {
    for (const id of r.artist_ids || []) {
      recordsBy.set(id, (recordsBy.get(id) || 0) + 1);
      if (!name.has(id)) name.set(id, (A[id]?.name) || (r.artist_ids.length === 1 ? r.artist : ""));
    }
  }
  // person id -> { name, artists: Set(collection artist ids they're part of) }
  const persons = new Map();
  const join = (pid, pname, aid) => {
    if (!persons.has(pid)) persons.set(pid, { id: pid, name: pname, artists: new Set() });
    persons.get(pid).artists.add(aid);
  };
  for (const [idStr, a] of Object.entries(A)) {
    const id = +idStr;
    if (!recordsBy.has(id)) continue;
    for (const m of a.members || []) join(m.id, m.name, id);                     // band -> members
    for (const g of a.groups || []) if (recordsBy.has(g.id)) { join(id, a.name, id); join(id, a.name, g.id); } // person -> bands
  }
  const links = [...persons.values()].filter((p) => p.artists.size >= 2)
    .map((p) => ({ ...p, artists: [...p.artists].filter((i) => name.get(i)) }))
    .filter((p) => p.artists.length >= 2)
    .sort((x, y) => y.artists.length - x.artists.length || x.name.localeCompare(y.name));
  const byArtist = new Map();        // collection artist id -> links touching it
  for (const l of links) for (const id of l.artists) { if (!byArtist.has(id)) byArtist.set(id, []); byArtist.get(id).push(l); }
  state.people = { links, name, recordsBy, byArtist };
  for (const r of state.records) {
    const set = new Set([r.artist.toLowerCase()]);
    for (const c of r.credits || []) set.add(c.name.toLowerCase());
    for (const id of r.artist_ids || []) for (const m of A[id]?.members || []) set.add(m.name.toLowerCase());
    r._people = set;
  }
}

const KEY_ROLES = [
  ["Produced by", /^(co-)?producer$|^produced by$/i],
  ["Recorded by", /^recorded by$|^recording$/i],
  ["Engineered by", /engineer/i],
  ["Mixed by", /^mixed by$/i],
  ["Mastered by", /^mastered by$|^lacquer cut by$/i],
];

function creditsHtml(r) {
  const credits = r.credits || [];
  const A = state.meta.artists || {};
  const out = [];
  // the band, and where its people turn up elsewhere in the collection
  for (const id of r.artist_ids || []) {
    const a = A[id];
    if (!a) continue;
    if (a.members?.length) {
      const current = a.members.filter((m) => m.active), past = a.members.filter((m) => !m.active);
      const fmt = (list) => list.map((m) => `<a href="${whoHref(m.name)}">${esc(m.name)}</a>`).join(", ");
      out.push(`<dt>Members</dt><dd>${fmt(current.length ? current : past)}${current.length && past.length ? ` <span class="muted">· formerly ${fmt(past)}</span>` : ""}</dd>`);
    }
    const links = state.people.byArtist.get(id) || [];
    const others = [];
    for (const l of links) for (const other of l.artists) if (other !== id) others.push([l.name, other]);
    if (others.length) {
      const seen = new Set();
      const items = others.filter(([, o]) => !seen.has(o) && seen.add(o)).slice(0, 8)
        .map(([p, o]) => `<a href="${artistHref(state.people.name.get(o))}">${esc(state.people.name.get(o))}</a> <span class="muted">(${esc(p)})</span>`);
      out.push(`<dt>Related</dt><dd>${items.join(", ")}</dd>`);
    }
  }
  for (const [label, re] of KEY_ROLES) {
    const names = [...new Set(credits.filter((c) => re.test(c.role)).map((c) => c.name))];
    if (names.length) out.push(`<dt>${label}</dt><dd>${names.slice(0, 6).map((n) => `<a href="${whoHref(n)}">${esc(n)}</a>`).join(", ")}${names.length > 6 ? ` +${names.length - 6}` : ""}</dd>`);
  }
  const plant = (r.companies || []).find((c) => /pressed by/i.test(c.role));
  if (plant) out.push(`<dt>Pressed at</dt><dd>${esc(plant.name)}</dd>`);
  const rest = credits.filter((c) => !KEY_ROLES.some(([, re]) => re.test(c.role)));
  let more = "";
  if (rest.length) {
    const byRole = new Map();
    for (const c of rest) { if (!byRole.has(c.role)) byRole.set(c.role, []); byRole.get(c.role).push(c.name); }
    more = `<details class="all-credits"><summary>All credits (${credits.length})</summary><dl class="facts-list">${
      [...byRole].map(([role, names]) => `<dt>${esc(role)}</dt><dd>${[...new Set(names)].map((n) => `<a href="${whoHref(n)}">${esc(n)}</a>`).join(", ")}</dd>`).join("")}</dl></details>`;
  }
  if (!out.length && !more) return "";
  return `<div class="credits"><h3>People</h3><dl class="facts-list">${out.join("")}</dl>${more}</div>`;
}

function communityFact(r) {
  const c = r.community;
  if (!c) return "";
  const bits = [`${fmtInt(c.have)} own it`, `${fmtInt(c.want)} want it`];
  if (c.votes >= 5) bits.push(`rated ${c.rating.toFixed(1)} of 5 by ${fmtInt(c.votes)}`);
  return `<dt>On Discogs</dt><dd>${bits.join(" · ")}</dd>`;
}

// ------------------------------------------------------------------ bins & filing
// Every record lives in one bin: a hand-set bin wins; otherwise new records sit on the
// new-arrivals pile; otherwise the record files alphabetically by artist into the cubby
// whose "first artist" is the closest one at or before it.
function binName(label) {
  const st = state.shelves?.stacks.find((x) => x.label === label);
  return st ? st.name : `Bin ${label}`;
}

// Bin numbers read the whole wall like a page: units are bottom-aligned, so rows at the same
// height line up across units; each wall row runs left to right, top row first.
// Mirrors numbering() in app/shelves.py. Returns, per unit, the bin number of each cubby.
function cubbyNumbers(units) {
  const out = units.map((u) => new Array(u.cols * u.rows).fill(0));
  const tallest = Math.max(...units.map((u) => u.rows));
  let n = 1;
  for (let level = tallest - 1; level >= 0; level--) {
    units.forEach((u, ui) => {
      const r = u.rows - 1 - level;
      if (r < 0) return;
      for (let c = 0; c < u.cols; c++) out[ui][r * u.cols + c] = n++;
    });
  }
  return out;
}

function allBinLabels() {
  const sh = state.shelves;
  if (!sh) return [];
  const out = [];
  const total = sh.units.reduce((a, u) => a + u.cols * u.rows, 0);
  for (let n = 1; n <= total; n++) out.push(String(n));
  return out.concat(sh.stacks.map((x) => x.label));
}

function autoBin(r) {
  const sh = state.shelves;
  if (!sh) return "";
  const pile = sh.stacks.find((x) => x.new);
  if (pile && sh.arrivals_since && r.date_added && new Date(r.date_added) > new Date(sh.arrivals_since)) return pile.label;
  const starts = state._starts;
  if (!starts.length) return "";
  const key = sortKey(r.artist);
  let hit = starts[0][1];
  for (const [k, label] of starts) { if (cmpKey(k, key) <= 0) hit = label; else break; }
  return hit;
}

function computeBins() {
  const sh = state.shelves;
  state._starts = sh ? Object.entries(sh.starts).map(([label, a]) => [sortKey(a), label]).sort((x, y) => cmpKey(x[0], y[0])) : [];
  for (const r of state.records) r._bin = r.bin || autoBin(r);
  $("#bin-labels").innerHTML = allBinLabels().map((l) => `<option value="${esc(l)}">`).join("");
  $("#artist-names").innerHTML = [...new Set(state.records.map((r) => r.artist))].sort((a, b) => cmpKey(sortKey(a), sortKey(b)))
    .map((a) => `<option value="${esc(a)}">`).join("");
}

async function saveShelves(patch) {
  const res = await fetch("/api/shelves", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.shelves, ...patch }) });
  if (!res.ok) throw new Error(res.status === 403 ? "Editing is locked on this server" : `Server answered ${res.status}`);
  state.shelves = await res.json();
  computeBins();
}

// ------------------------------------------------------------------ shelves view
const CUBBY_FULL = 70; // a 13" cube cubby holds roughly 70-80 LPs

function renderShelves(main) {
  const sh = state.shelves;
  if (!sh) { main.innerHTML = emptyState("Shelves unavailable", "The shelf layout couldn't be loaded."); return; }
  const editing = state._editShelves;
  const colors = state.meta.colors || {};
  const groups = new Map(allBinLabels().map((l) => [l, []]));
  let unfiled = 0;
  for (const r of state.records) {
    if (!r._bin) unfiled++;
    else if (groups.has(r._bin)) groups.get(r._bin).push(r);
    else groups.set(r._bin, [r]); // hand-typed bin that isn't on the shelves
  }
  for (const list of groups.values()) list.sort((a, b) => cmpKey(sortKey(a.artist), sortKey(b.artist)) || (a.year || 0) - (b.year || 0));
  const pile = sh.stacks.find((x) => x.new);
  const pileCount = pile ? groups.get(pile.label).filter((r) => !r.bin).length : 0;
  const hasStarts = Object.keys(sh.starts).length > 0;

  const spines = (list) => {
    const show = list.slice(0, 90);
    return show.map((r) => {
      const h = 78 + ((r.id * 7919) % 20);
      return `<i style="--c:${colors[r.id] || sleeveColor(r.id)};--h:${h}%"></i>`;
    }).join("");
  };
  const cubby = (label, extraClass = "") => {
    const list = groups.get(label) || [];
    const range = list.length ? `${list[0].artist} – ${list[list.length - 1].artist}` : "";
    const full = list.length >= CUBBY_FULL;
    const href = hashFor("gallery", { bin: label, q: "", genre: "", decade: "", format: "", sort: "artist" });
    if (editing && !sh.stacks.some((x) => x.label === label)) {
      return `<div class="cubby editing ${extraClass}">
        <span class="cubby-label">${esc(binName(label))}</span>
        <label class="start-field"><span class="sr-only">First artist in ${esc(binName(label))}</span>
          <input data-start="${esc(label)}" value="${esc(sh.starts[label] || "")}" placeholder="First artist" list="artist-names" autocomplete="off"></label>
        <span class="cubby-count">${fmtInt(list.length)}</span></div>`;
    }
    return `<a class="cubby ${extraClass} ${full ? "full" : ""}" href="${href}" title="${esc(binName(label))}${range ? `: ${esc(range)}` : ""}">
      <span class="spines" aria-hidden="true">${spines(list)}</span>
      <span class="cubby-meta"><span class="cubby-label">${esc(/^\d+$/.test(label) ? `Bin ${label}` : label)}</span><span class="cubby-count">${fmtInt(list.length)}${full ? `<span class="full-note"> · nearly full</span>` : ""}</span></span>
      ${range ? `<span class="cubby-range">${esc(range)}</span>` : ""}</a>`;
  };

  let room = "";
  const nums = cubbyNumbers(sh.units);
  for (const [ui, u] of sh.units.entries()) {
    const stacks = sh.stacks.filter((x) => x.unit === u.id);
    room += `<div class="unit" style="--cols:${u.cols};--rows:${u.rows}">
      <div class="unit-top">${stacks.map((x) => `<div class="stack-slot" style="grid-column:${x.from_col} / ${x.to_col + 1}">${cubby(x.label, "stack")}<span class="stack-name">${esc(x.name)}</span></div>`).join("")}</div>
      <div class="frame" role="group" aria-label="${esc(u.name)}">${Array.from({ length: u.cols * u.rows }, (_, i) => cubby(String(nums[ui][i]))).join("")}</div>
      <p class="unit-name">${esc(u.name)}</p></div>`;
  }
  const stray = [...groups.keys()].filter((l) => !allBinLabels().includes(l));

  main.innerHTML = `<section class="shelves-view" aria-label="Shelves">
    <div class="shelves-head">
      <div><h2>Shelves</h2>
      <p class="sub">${editing
        ? "Type the artist of the <b>first</b> record in each cubby. Everything after it, up to the next cubby's first artist, files there automatically."
        : hasStarts ? "Click a cubby to flip through it." : "Set up filing once and every record finds its cubby, including ones you add later."}</p></div>
      <div class="shelves-actions">${editing
        ? `<button type="button" class="btn" id="sh-cancel">Cancel</button><button type="button" class="btn primary" id="sh-save">Save filing</button>`
        : `${pile && pileCount ? `<button type="button" class="btn" id="sh-shelved">I've shelved the new arrivals (${fmtInt(pileCount)})</button>` : ""}
           ${state.meta.can_edit ? `<button type="button" class="btn ${hasStarts ? "" : "primary"}" id="sh-edit">${hasStarts ? "Edit filing" : "Set up filing"}</button>` : ""}`}</div>
    </div>
    <p class="sh-msg" id="sh-msg" role="status">${unfiled && !editing ? `${fmtInt(unfiled)} record${unfiled === 1 ? " isn't" : "s aren't"} in a cubby yet.` : ""}</p>
    <div class="room ${editing ? "is-editing" : ""}">${room}</div>
    ${stray.length && !editing ? `<p class="sub">Also hand-filed outside these shelves: ${stray.map((l) => `<a href="${hashFor("gallery", { bin: l, q: "", genre: "", decade: "", format: "" })}">${esc(l)}</a> (${groups.get(l).length})`).join(", ")}</p>` : ""}
  </section>`;

  const msg = (t) => { $("#sh-msg").textContent = t; };
  $("#sh-edit")?.addEventListener("click", () => { state._editShelves = true; render(); });
  $("#sh-cancel")?.addEventListener("click", () => { state._editShelves = false; render(); });
  $("#sh-save")?.addEventListener("click", async () => {
    const starts = {};
    for (const inp of $$("[data-start]", main)) if (inp.value.trim()) starts[inp.dataset.start] = inp.value.trim();
    try { await saveShelves({ starts }); state._editShelves = false; applyFilters(); render(); toast("Filing saved"); }
    catch (err) { msg(`Not saved: ${err.message}`); }
  });
  $("#sh-shelved")?.addEventListener("click", async () => {
    try { await saveShelves({ arrivals_since: new Date().toISOString() }); applyFilters(); render(); toast("New arrivals filed into their cubbies"); }
    catch (err) { msg(`Not saved: ${err.message}`); }
  });
}

// ------------------------------------------------------------------ toast, surprise, sync
let toastT;
function toast(text) {
  const t = $("#toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 5000);
}

function bindSurprise() {
  $("#surprise-btn").addEventListener("click", () => {
    const pool = state.filtered.length ? state.filtered : state.records;
    if (!pool.length) return;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && pick.uid === art.r?.uid) pick = pool[(pool.indexOf(pick) + 1) % pool.length];
    openDetail(pick.uid, pool);
  });
}

const syncUi = { polling: 0 };
const ago = (iso) => {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};

function syncProgressText(st) {
  const p = st?.progress;
  if (!st?.running) return "";
  if (!p || !p.total) return p?.phase ? `${p.phase}…` : "Syncing…";
  const left = p.total - p.done;
  const mins = Math.ceil(left / 55); // Discogs allows ~60 requests a minute
  return `${p.phase}: ${fmtInt(p.done)} of ${fmtInt(p.total)}${left > 30 ? `, about ${mins} min left` : ""}`;
}

function paintSync(st) {
  const changed = !!state.sync?.running !== !!st.running;
  state.sync = st;
  if (changed && state.view === "stats" && state.loaded && !$("#detail").open) render();
  const btn = $("#sync-btn");
  btn.hidden = !(state.meta.can_sync && state.meta.can_edit);
  btn.classList.toggle("spinning", !!st.running);
  const prog = syncProgressText(st);
  const label = st.running ? `Syncing with Discogs. ${prog}` : `Last synced ${ago(st.synced_at || state.meta.synced_at)}. Sync now`;
  btn.title = label; btn.setAttribute("aria-label", label);
  const note = $("#sync-note");
  note.hidden = !st.running;
  note.textContent = st.running ? (st.progress?.total ? `${Math.round((st.progress.done / st.progress.total) * 100)}%` : "Syncing") : "";
  note.title = prog;
  const box = $("#people-progress");
  if (box) box.textContent = prog;
}

function checkVersion(v) {
  const n = $("#notice");
  if (v === EXPECTED_API) { n.hidden = true; return; }
  n.hidden = false;
  n.innerHTML = v < EXPECTED_API
    ? `<b>The app was updated, but the Pi is still running the old server code</b>, so some features (like credits and band members) won't show up. On the Pi, run <code>cd ~/records &amp;&amp; ./deploy/setup.sh</code> once. After that, updates apply on their own after a <code>git pull</code>.`
    : `<b>This page is out of date.</b> <a href="">Reload</a> to get the latest version.`;
}

async function pollSync(announce) {
  clearTimeout(syncUi.polling);
  let st;
  try { st = await (await fetch("/api/sync", { cache: "no-store" })).json(); } catch { return; }
  paintSync(st);
  if (st.running) { syncUi.polling = setTimeout(() => pollSync(true), 4000); return; }
  syncUi.polling = 0;
  if (!announce) return;
  if (st.state === "failed") return toast(`Sync failed: ${st.error || "see the sync log on the Pi"}`);
  const s = st.summary || {};
  const bits = [];
  if (s.added) bits.push(`${s.added} new`);
  if (s.removed) bits.push(`${s.removed} removed`);
  toast(`Sync finished${bits.length ? `: ${bits.join(", ")}` : ". Everything's up to date"}`);
  await reload();
}

function bindSync() {
  $("#sync-btn").addEventListener("click", async () => {
    if ($("#sync-btn").classList.contains("spinning")) return toast("A sync is already running");
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) toast("A sync is already running");
      else if (!res.ok) return toast(body.error || `Couldn't start a sync (${res.status})`);
      else toast("Syncing with Discogs. This page updates when it's done");
      paintSync({ running: true });
      syncUi.polling = setTimeout(() => pollSync(true), 3000);
    } catch { toast("Couldn't reach the server"); }
  });
}

async function reload() {
  const keep = { view: state.view, uid: art.r?.uid };
  await load();
  populateFilters();
  applyFilters();
  render();
  if ($("#detail").open && keep.uid && state.byUid.has(keep.uid)) openDetail(keep.uid);
}

// ------------------------------------------------------------------ theme
function bindTheme() {
  const btn = $("#theme-btn");
  const effective = () => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const label = () => {
    const other = effective() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", `Switch to ${other} theme`);
    btn.title = `Switch to ${other} theme`;
    $('meta[name="theme-color"]').content = effective() === "dark" ? "#16191d" : "#e9ecee";
  };
  btn.addEventListener("click", () => {
    const next = effective() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("rc-theme", next);
    label();
  });
  label();
}

// ------------------------------------------------------------------ boot
async function load() {
  try {
    const [res, shelvesRes] = await Promise.all([
      fetch("/api/collection", { cache: "no-cache" }),
      fetch("/api/shelves", { cache: "no-cache" }).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`The server answered ${res.status}. Check the service log on the Pi.`);
    const data = await res.json();
    state.shelves = shelvesRes?.ok ? await shelvesRes.json() : null;
    state.meta = data;
    state.records = (data.records || []).map((r) => ({
      ...r,
      _hay: [r.title, r.artist, r.label, r.catno, ...(r.styles || []), ...(r.tracklist || []).map((t) => t.title)].join(" ").toLowerCase(),
    }));
    state.byUid = new Map(state.records.map((r) => [r.uid, r]));
    state.error = null;
    checkVersion(data.api_version || 0);
    computeBins();
    computePeople();
  } catch (err) {
    state.error = err instanceof TypeError ? "The server couldn't be reached. Is the record-collection service running?" : esc(err.message);
  }
  state.loaded = true;
}

function onRoute() {
  const r = readRoute();
  reflectFilters();
  applyFilters();
  render();
  if (r && state.byUid.has(r)) openDetail(r);
  else if ($("#detail").open) $("#detail").close();
}

(async function main() {
  bindTheme();
  bindFilters();
  bindDetail();
  bindSurprise();
  bindSync();
  readRoute();
  render();
  await load();
  populateFilters();
  addEventListener("hashchange", onRoute);
  onRoute();
  pollSync(false);  // shows the button, and a spinner if the nightly sync is mid-run
  setInterval(() => { if (!syncUi.polling && !document.hidden) pollSync(false); }, 60000);
})();
