#!/usr/bin/env node
/**
 * Misfits Lab nightly crawler — InnerTube only, no API keys.
 * Discovers channels from niche seed queries, snapshots every known channel
 * (recent-video views + subs + keyword terms), writes JSON files into data/.
 * Designed to run on GitHub Actions and commit results back to the repo.
 */
import { Innertube, Log } from "youtubei.js";
import fs from "node:fs";
import path from "node:path";

try { Log.setLevel(Log.Level.NONE); } catch {}
console.debug = () => {}; console.info = () => {};

const DATA = "data";
const SNAPS = path.join(DATA, "snaps");
const MAX_CHANNELS = parseInt(process.env.MAX_CHANNELS || "4000", 10);
const MAX_NEW_PER_RUN = parseInt(process.env.MAX_NEW_PER_RUN || "600", 10);
const PACE_MS = parseInt(process.env.PACE_MS || "350", 10);
const TIME_BUDGET_MIN = parseInt(process.env.TIME_BUDGET_MIN || "270", 10);
const SNAP_RETENTION_DAYS = 35;

const started = Date.now();
const outOfTime = () => (Date.now() - started) / 60000 > TIME_BUDGET_MIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

const txt = (v) => (v && typeof v === "object" && "text" in v ? v.text : v);
const pv = (s) => {
  if (typeof s === "number") return s;
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] || 1));
};
const relToDays = (r) => {
  if (!r) return null;
  const m = String(r).match(/(\d+)\s*(minute|hour|day|week|month|year)/i);
  if (!m) return null;
  return Math.round(parseInt(m[1], 10) * ({ minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()]) * 10) / 10;
};

const STOP = new Set("the a an and or but in on at to for of with by from up about into over after this that these those is are was were be been being have has had do does did will would could should may might must can i you he she it we they my your his her its our their me him them what which who whom how why when where all any both each few more most other some such no nor not only own same so than too very s t just dont cant wont im ive youre".split(" "));
function termsOf(titles, top = 25) {
  const freq = new Map();
  for (const t of titles) {
    for (const w of String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map((e) => e[0]);
}

function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }

const yt = await Innertube.create({ generate_session_locally: true });
fs.mkdirSync(SNAPS, { recursive: true });

const channels = readJSON(path.join(DATA, "channels.json"), {});
const niches = readJSON("niches.json", { niches: [] }).niches;
const snap = {};
let requests = 0, errors = 0, discovered = 0;

async function paced(fn) {
  requests++;
  await sleep(PACE_MS);
  return fn();
}

// ---------- 1. discovery ----------
console.log(`[discovery] ${niches.length} niche queries, known channels: ${Object.keys(channels).length}`);
for (const q of niches) {
  if (outOfTime() || discovered >= MAX_NEW_PER_RUN) break;
  for (const upload_date of ["week", "month"]) {
    try {
      const s = await paced(() => yt.search(q, { type: "video", upload_date }));
      for (const r of s.results || []) {
        if (r.type !== "Video" || !r.author?.id) continue;
        if (!channels[r.author.id] && discovered < MAX_NEW_PER_RUN) {
          channels[r.author.id] = { name: r.author.name, niche: q, first_seen: today };
          discovered++;
        }
      }
    } catch { errors++; }
  }
}
console.log(`[discovery] +${discovered} new channels`);

// ---------- 2. snapshot ----------
const ids = Object.keys(channels)
  .sort((a, b) => (channels[a].last_snap || "") < (channels[b].last_snap || "") ? -1 : 1)
  .slice(0, MAX_CHANNELS);
console.log(`[snapshot] snapshotting ${ids.length} channels`);
let done = 0;
for (const id of ids) {
  if (outOfTime()) { console.log("[snapshot] time budget reached"); break; }
  const c = channels[id];
  try {
    // Source A: uploads playlist (UU...). Source B: channel Videos tab. Either may be
    // throttled depending on the egress IP, so try both.
    let parsed = [], total = null;
    try {
      let pl = await paced(() => yt.getPlaylist("UU" + id.slice(2)));
      let vids = pl.videos || [];
      if (!vids.length) { await sleep(1200); pl = await paced(() => yt.getPlaylist("UU" + id.slice(2))); vids = pl.videos || []; }
      total = pv(txt(pl.info?.total_items)) ?? null;
      parsed = vids.map((v) => {
        const [vw, pub] = (txt(v.video_info) || "").split("•").map((x) => x?.trim());
        return { title: txt(v.title), views: pv(vw) || 0, days: relToDays(pub) };
      });
    } catch {}
    if (!parsed.length) {
      // fallback: channel Videos tab
      try {
        const chPage = await paced(() => yt.getChannel(id));
        const tab = await paced(() => chPage.getVideos());
        parsed = (tab.videos || []).filter((v) => v.id).map((v) => ({
          title: txt(v.title),
          views: pv(txt(v.view_count) ?? txt(v.short_view_count)) || 0,
          days: relToDays(txt(v.published)),
        }));
      } catch {}
    }
    if (total == null) total = parsed.length;
    if (!parsed.length) { errors++; continue; } // both sources empty — don't write a zero snapshot
    const sumViews = parsed.reduce((a, v) => a + v.views, 0);
    // exact-ish channel age: only when we can see the full history on one page
    if (parsed.length >= total && parsed.length) {
      const oldest = parsed[parsed.length - 1];
      if (oldest.days != null) c.started_days = Math.round(oldest.days);
      c.started_asof = today;
    }
    c.uploads = total;
    c.terms = termsOf(parsed.map((v) => v.title));
    // subs via channel header
    try {
      const ch = await paced(() => yt.getChannel(id));
      const hs = JSON.stringify(ch.header ?? {}) + JSON.stringify(ch.metadata ?? {});
      const subs = pv((hs.match(/"([\d.,]+[KMB]?)\s+subscribers"/) || [])[1]);
      if (subs) c.subs = subs;
      if (!c.name) c.name = ch.metadata?.title;
    } catch { errors++; }
    c.last_snap = today;
    snap[id] = { v: sumViews, s: c.subs ?? null, n: total };
    done++;
    if (done % 200 === 0) console.log(`[snapshot] ${done}/${ids.length} (req ${requests}, err ${errors})`);
  } catch { errors++; }
}

// ---------- 3. write ----------
fs.writeFileSync(path.join(DATA, "channels.json"), JSON.stringify(channels));
fs.writeFileSync(path.join(SNAPS, `${today}.json`), JSON.stringify(snap));
// prune old snaps
for (const f of fs.readdirSync(SNAPS)) {
  const d = f.replace(".json", "");
  if ((Date.now() - new Date(d).getTime()) / 86400000 > SNAP_RETENTION_DAYS) fs.unlinkSync(path.join(SNAPS, f));
}
const snapDates = fs.readdirSync(SNAPS).map((f) => f.replace(".json", "")).sort();
fs.writeFileSync(path.join(DATA, "meta.json"), JSON.stringify({
  last_run: new Date().toISOString(),
  channels_tracked: Object.keys(channels).length,
  snapshotted_today: done,
  discovered_today: discovered,
  requests, errors,
  snap_dates: snapDates,
}, null, 2));
console.log(`[done] tracked=${Object.keys(channels).length} snapped=${done} discovered=${discovered} requests=${requests} errors=${errors}`);
