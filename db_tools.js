/**
 * Misfits Lab — database tools backed by the nightly GitHub Actions crawler.
 * Reads JSON snapshot files from the repo (raw.githubusercontent.com), cached in memory.
 * Free: no API keys, no paid services.
 */
import { z } from "zod";
import { Innertube } from "youtubei.js";
import fs from "node:fs";
import path from "node:path";

const DB_BASE = process.env.DB_BASE || "https://raw.githubusercontent.com/jirkajeking16/misfits-lab/main/data";
const DB_DIR = process.env.DB_DIR || null; // local directory override (for testing)
const CACHE_MS = 10 * 60 * 1000;

let yt = null;
async function getYT() {
  if (!yt) yt = await Innertube.create({ generate_session_locally: true });
  return yt;
}
const ok = (d) => ({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message || String(e)}` }], isError: true });
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

const cache = new Map();
async function dbFile(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;
  let data;
  if (DB_DIR) {
    data = JSON.parse(fs.readFileSync(path.join(DB_DIR, name), "utf8"));
  } else {
    const res = await fetch(`${DB_BASE}/${name}`, { headers: { "cache-control": "no-cache" } });
    if (!res.ok) throw new Error(`Database file ${name} not available yet (${res.status}). The nightly crawler may not have run — check the GitHub Actions tab of the misfits-lab repo.`);
    data = await res.json();
  }
  cache.set(name, { ts: Date.now(), data });
  return data;
}

async function resolveChannelId(youtube, input) {
  input = input.trim();
  const urlMatch = input.match(/youtube\.com\/(channel\/(UC[\w-]+)|(@[\w.-]+))/);
  if (urlMatch?.[2]) return urlMatch[2];
  if (urlMatch?.[3]) input = urlMatch[3];
  if (/^UC[\w-]{20,}$/.test(input)) return input;
  const handle = input.startsWith("@") ? input : `@${input}`;
  const resolved = await youtube.resolveURL(`https://www.youtube.com/${handle}`);
  const id = resolved?.payload?.browseId;
  if (id) return id;
  throw new Error(`Could not resolve channel: ${input}`);
}

export function registerDbTools(server) {
  // ---------- db_status ----------
  server.tool(
    "db_status",
    "Status of the Misfits Lab tracking database (nightly crawler): channels tracked, last run, available snapshot dates.",
    {},
    async () => {
      try { return ok(await dbFile("meta.json")); } catch (e) { return fail(e); }
    }
  );

  // ---------- db_growth ----------
  server.tool(
    "db_growth",
    "ALGROW-STYLE instant growth data for any TRACKED channel: daily view/subscriber series and 24h/multi-day deltas from the nightly snapshot database. No waiting — works immediately if the channel is in the database.",
    { channel: z.string().describe("Channel ID, @handle, or URL") },
    async ({ channel }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const meta = await dbFile("meta.json");
        const channels = await dbFile("channels.json");
        if (!channels[id]) return fail(new Error("Channel not in tracking database yet. It will be picked up if it appears in a niche search, or ask me to add its niche to niches.json."));
        const dates = (meta.snap_dates || []).slice(-14);
        const series = [];
        for (const d of dates) {
          try {
            const snap = await dbFile(`snaps/${d}.json`);
            if (snap[id]) series.push({ date: d, recent_views_total: snap[id].v, subs: snap[id].s, uploads: snap[id].n });
          } catch {}
        }
        const deltas = [];
        for (let i = 1; i < series.length; i++) {
          deltas.push({
            from: series[i - 1].date, to: series[i].date,
            views_gained: series[i].recent_views_total - series[i - 1].recent_views_total,
            subs_gained: series[i].subs != null && series[i - 1].subs != null ? series[i].subs - series[i - 1].subs : null,
            new_uploads: series[i].uploads - series[i - 1].uploads,
          });
        }
        return ok({ channel: channels[id].name, channel_id: id, niche: channels[id].niche, subs: channels[id].subs, uploads: channels[id].uploads, started_days_ago: channels[id].started_days ?? null, series, deltas });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- db_leaderboard ----------
  server.tool(
    "db_leaderboard",
    "ALGROW-STYLE growth leaderboard over ALL tracked channels: top gainers by views (or subscribers) since the previous snapshot. Filter by subscriber range or niche.",
    {
      metric: z.enum(["views_gained", "subs_gained"]).default("views_gained"),
      min_subs: z.number().int().default(0),
      max_subs: z.number().int().default(100000000),
      niche_contains: z.string().optional().describe("Filter to channels discovered via niche queries containing this text"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ metric, min_subs, max_subs, niche_contains, limit }) => {
      try {
        const meta = await dbFile("meta.json");
        const dates = meta.snap_dates || [];
        if (dates.length < 2) return fail(new Error(`Need at least 2 snapshots for deltas — have ${dates.length}. Deltas appear after the second nightly run.`));
        const [prevD, currD] = dates.slice(-2);
        const [prev, curr, channels] = await Promise.all([dbFile(`snaps/${prevD}.json`), dbFile(`snaps/${currD}.json`), dbFile("channels.json")]);
        const rows = [];
        for (const [id, c] of Object.entries(curr)) {
          const p = prev[id];
          if (!p) continue;
          const info = channels[id] || {};
          const subs = c.s ?? info.subs;
          if (subs != null && (subs < min_subs || subs > max_subs)) continue;
          if (niche_contains && !(info.niche || "").toLowerCase().includes(niche_contains.toLowerCase())) continue;
          rows.push({
            channel: info.name, channel_id: id, url: `https://www.youtube.com/channel/${id}`,
            subs, niche: info.niche,
            views_gained: c.v - p.v,
            subs_gained: c.s != null && p.s != null ? c.s - p.s : null,
            new_uploads: c.n - p.n,
            started_days_ago: info.started_days ?? null,
          });
        }
        rows.sort((a, b) => (b[metric] ?? -Infinity) - (a[metric] ?? -Infinity));
        return ok({ window: `${prevD} -> ${currD}`, channels_compared: rows.length, top: rows.slice(0, limit) });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- db_similar ----------
  server.tool(
    "db_similar",
    "ALGROW-STYLE similarity search with match scores: ranks all tracked channels by content-keyword overlap (cosine on crawled title terms) plus audience-size closeness.",
    {
      channel: z.string().describe("Channel ID, @handle, or URL"),
      min_subs: z.number().int().default(0),
      max_subs: z.number().int().default(100000000),
      limit: z.number().int().min(1).max(30).default(10),
    },
    async ({ channel, min_subs, max_subs, limit }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const channels = await dbFile("channels.json");
        let meTerms = channels[id]?.terms;
        let meSubs = channels[id]?.subs;
        if (!meTerms) {
          // channel not tracked: compute terms live from its uploads
          const pl = await youtube.getPlaylist("UU" + id.slice(2));
          const titles = (pl.videos || []).map((v) => txt(v.title) || "");
          if (!titles.length) return fail(new Error("Could not read channel videos to compute similarity."));
          const freq = new Map();
          for (const t of titles) for (const w of t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) { if (w.length >= 3) freq.set(w, (freq.get(w) || 0) + 1); }
          meTerms = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map((e) => e[0]);
        }
        const meSet = new Set(meTerms);
        const rows = [];
        for (const [cid, c] of Object.entries(channels)) {
          if (cid === id || !c.terms?.length) continue;
          if (c.subs != null && (c.subs < min_subs || c.subs > max_subs)) continue;
          const overlap = c.terms.filter((t) => meSet.has(t)).length;
          if (!overlap) continue;
          const jaccard = overlap / (meSet.size + c.terms.length - overlap);
          const sizeCloseness = meSubs && c.subs ? 1 / (1 + Math.abs(Math.log10(c.subs / meSubs))) : 0.5;
          rows.push({
            channel: c.name, channel_id: cid, url: `https://www.youtube.com/channel/${cid}`,
            subs: c.subs, niche: c.niche,
            match_pct: Math.round((jaccard * 0.75 + sizeCloseness * 0.25) * 100),
            shared_terms: c.terms.filter((t) => meSet.has(t)).slice(0, 8),
          });
        }
        rows.sort((a, b) => b.match_pct - a.match_pct);
        return ok({ source_channel_id: id, tracked_channels_scanned: Object.keys(channels).length, similar: rows.slice(0, limit) });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- channel_history ----------
  server.tool(
    "channel_history",
    "EXACT channel age for ANY channel (even 1000+ uploads): paginates the full uploads playlist via InnerTube to find the true first upload. Slower for big channels (up to ~30s).",
    {
      channel: z.string().describe("Channel ID, @handle, or URL"),
      max_pages: z.number().int().min(1).max(30).default(15).describe("100 videos per page"),
    },
    async ({ channel, max_pages }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        let pl = await youtube.getPlaylist("UU" + id.slice(2));
        const total = pv(txt(pl.info?.total_items));
        let videos = [...(pl.videos || [])];
        let pages = 1;
        while (pl.has_continuation && pages < max_pages) {
          pl = await pl.getContinuation();
          videos.push(...(pl.videos || []));
          pages++;
        }
        const parsed = videos.map((v) => {
          const [vw, pub] = (txt(v.video_info) || "").split("•").map((x) => x?.trim());
          return { title: txt(v.title), views: pv(vw), published: pub, days: relToDays(pub) };
        });
        const oldest = parsed[parsed.length - 1];
        const complete = videos.length >= (total || 0);
        return ok({
          channel_id: id,
          total_uploads: total,
          videos_seen: videos.length,
          history_complete: complete,
          first_upload: oldest ? { title: oldest.title, published: oldest.published, days_ago: oldest.days } : null,
          started_uploading_days_ago: complete ? oldest?.days : `>${oldest?.days} (pagination capped)`,
          first_5_videos: parsed.slice(-5).reverse(),
        });
      } catch (e) { return fail(e); }
    }
  );
}
