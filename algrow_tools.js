/**
 * Misfits Lab — Algrow-style research tools (free, InnerTube-based).
 * Self-contained: has its own helper copies so it can be registered standalone.
 */
import { z } from "zod";
import { Innertube } from "youtubei.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

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
const durSec = (d) => { if (!d) return 0; const p = String(d).split(":").map(Number); return p.reduce((a, b) => a * 60 + b, 0); };
const relToDays = (r) => {
  if (!r) return null;
  const m = String(r).match(/(\d+)\s*(minute|hour|day|week|month|year)/i);
  if (!m) return null;
  return Math.round(parseInt(m[1], 10) * ({ minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()]) * 10) / 10;
};
const isEnglish = (t) => {
  if (!t) return false;
  if (/[ऀ-ॿ؀-ۿ一-鿿가-힯぀-ヿ฀-๿]/.test(t)) return false;
  return /\b(the|my|your|how|that|and|to|of|for|you|what|why|over)\b/i.test(t);
};

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

async function uploadsOf(youtube, channelId, prefix = "UU", _retry = 0) {
  const pl = await youtube.getPlaylist(prefix + channelId.slice(2));
  const total = pv(txt(pl.info?.total_items));
  if ((pl.videos || []).length === 0 && _retry < 2) {
    await new Promise((r) => setTimeout(r, 1500 * (_retry + 1)));
    return uploadsOf(youtube, channelId, prefix, _retry + 1);
  }
  const videos = (pl.videos || []).map((v) => {
    const [vw, pub] = (txt(v.video_info) || "").split("•").map((s) => s?.trim());
    return { id: v.id, title: txt(v.title), duration: v.duration?.text, views: pv(vw), published: pub || null, published_days_ago: relToDays(pub) };
  });
  return { videos, total: total ?? videos.length };
}

async function channelHeader(youtube, channelId) {
  const ch = await youtube.getChannel(channelId);
  const s = JSON.stringify(ch.header ?? {}) + JSON.stringify(ch.metadata ?? {});
  return {
    ch,
    title: ch.metadata?.title,
    description: ch.metadata?.description,
    subs: pv((s.match(/"([\d.,]+[KMB]?)\s+subscribers"/) || [])[1]),
    subs_text: (s.match(/"([\d.,]+[KMB]?)\s+subscribers"/) || [])[1] || null,
  };
}

const SOCIAL = /instagram\.com|tiktok\.com|twitter\.com|x\.com\/|facebook\.com|youtube\.com|youtu\.be|spotify\.com|threads/i;
const CLASS = [
  [/patreon\.com|skool\.com|discord\.gg|circle\.so/i, "Community/Membership"],
  [/gumroad|payhip|stan\.store|whop\.com|sellfy|itch\.io|etsy\.com|beacons\.ai|ko-fi|buymeacoffee|lemonsqueezy|lovable\.app|shopify|teespring|fourthwall/i, "Digital Product/Store"],
  [/teachable|thinkific|kajabi|podia|udemy/i, "Course"],
  [/amzn\.to|amazon\.[a-z.]+/i, "Affiliate (Amazon)"],
  [/linktr\.ee|bio\.link|linkin\.bio/i, "Link hub"],
];
function classifyLinks(text) {
  if (!text) return [];
  let urls = [...String(text).matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map((m) => m[0]);
  urls = urls.map((u) => { const m = u.match(/[?&]q=(https?%3A[^&"]+)/); return m ? decodeURIComponent(m[1]) : u; });
  const out = [];
  for (const u of urls) {
    if (SOCIAL.test(u) || /googleusercontent|ytimg|gstatic|schema\.org|googleapis/i.test(u)) continue;
    let type = "Own website (possible product)";
    for (const [re, label] of CLASS) if (re.test(u)) { type = label; break; }
    if (!out.some((o) => o.url === u)) out.push({ type, url: u });
  }
  return out;
}

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")); } catch { return fallback; } }
function writeJSON(file, data) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }

async function mapLimit(items, limit, fn) {
  const out = []; const work = [...items];
  const worker = async () => { while (work.length) { const item = work.shift(); try { const r = await fn(item); if (r) out.push(r); } catch {} } };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

export function registerAlgrowTools(server) {
  // ---------- channel_finder ----------
  server.tool(
    "channel_finder",
    "ALGROW-STYLE filtered channel search: find channels in a niche matching subscriber range, view performance, age, language, and monetization filters. The full research pipeline in one call. SLOW (1-3 min) — searches, screens subs, computes long-form view averages, optionally checks selling links.",
    {
      query: z.string().describe("Niche/topic, e.g. 'glow up for women'"),
      min_subs: z.number().int().default(0),
      max_subs: z.number().int().default(100000000),
      min_avg_views: z.number().int().default(0).describe("Minimum average views of 10 recent long-form videos"),
      max_channel_age_days: z.number().int().optional().describe("Only channels whose first upload is within N days"),
      english_only: z.boolean().default(false),
      check_monetization: z.boolean().default(false).describe("Also scan for selling links (slower)"),
      max_results: z.number().int().min(1).max(15).default(8),
    },
    async ({ query, min_subs, max_subs, min_avg_views, max_channel_age_days, english_only, check_monetization, max_results }) => {
      try {
        const youtube = await getYT();
        const cands = new Map();
        for (const opts of [{ type: "video", upload_date: "month", sort_by: "view_count" }, { type: "video" }]) {
          try {
            const s = await youtube.search(query, opts);
            for (const r of (s.results || []).slice(0, 20)) {
              if (r.type === "Video" && r.author?.id && !cands.has(r.author.id))
                cands.set(r.author.id, { id: r.author.id, name: r.author.name });
            }
          } catch {}
        }
        const screened = await mapLimit([...cands.values()].slice(0, 35), 5, async (c) => {
          const { subs, subs_text, title } = await channelHeader(youtube, c.id);
          if (!subs || subs < min_subs || subs > max_subs) return null;
          const { videos, total } = await uploadsOf(youtube, c.id);
          const lf = videos.filter((v) => durSec(v.duration) >= 180 && typeof v.views === "number").slice(0, 10);
          if (lf.length < 3) return null;
          if (english_only && lf.filter((v) => isEnglish(v.title)).length < lf.length * 0.7) return null;
          if (max_channel_age_days != null) {
            const oldest = videos[videos.length - 1];
            if (videos.length < total || oldest?.published_days_ago == null || oldest.published_days_ago > max_channel_age_days) return null;
          }
          const avg = Math.round(lf.reduce((a, v) => a + v.views, 0) / lf.length);
          if (avg < min_avg_views) return null;
          const best = lf.reduce((a, v) => (v.views > a.views ? v : a), lf[0]);
          let monetization;
          if (check_monetization) {
            monetization = [];
            for (const v of videos.slice(0, 2)) {
              try { const i = await youtube.getInfo(v.id); monetization.push(...classifyLinks(i.basic_info?.short_description)); } catch {}
            }
            monetization = monetization.filter((m, i, a) => a.findIndex((x) => x.url === m.url) === i).slice(0, 5);
          }
          return {
            channel: title ?? c.name, channel_id: c.id, url: `https://www.youtube.com/channel/${c.id}`,
            subscribers: subs_text, uploads: total,
            avg_views_longform: avg, views_to_subs_ratio: +(avg / subs).toFixed(2),
            longforms_over_100k: lf.filter((v) => v.views >= 100000).length + "/" + lf.length,
            best_recent: { title: best.title, views: best.views, published: best.published },
            ...(monetization ? { selling: monetization.length > 0, monetization } : {}),
          };
        });
        screened.sort((a, b) => b.views_to_subs_ratio - a.views_to_subs_ratio);
        return ok({ query, screened: cands.size, matched: Math.min(screened.length, max_results), channels: screened.slice(0, max_results) });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- similar_channels ----------
  server.tool(
    "similar_channels",
    "ALGROW-STYLE: find channels similar to a given channel. Takes the channel's top-performing video titles, searches them, and ranks other channels by how often they appear (topical overlap) and audience-size closeness.",
    {
      channel: z.string().describe("Channel ID, @handle, or URL"),
      max_results: z.number().int().min(1).max(15).default(8),
    },
    async ({ channel, max_results }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const me = await channelHeader(youtube, id);
        const { videos } = await uploadsOf(youtube, id);
        const top = videos.filter((v) => durSec(v.duration) >= 180 && v.views).sort((a, b) => b.views - a.views).slice(0, 4);
        if (!top.length) return fail(new Error("No long-form videos to base similarity on"));
        const hits = new Map();
        for (const v of top) {
          try {
            const s = await youtube.search(v.title, { type: "video" });
            for (const r of (s.results || []).slice(0, 15)) {
              if (r.type !== "Video" || !r.author?.id || r.author.id === id) continue;
              const e = hits.get(r.author.id) ?? { id: r.author.id, name: r.author.name, overlap: 0, sample: [] };
              e.overlap++;
              if (e.sample.length < 2) e.sample.push(txt(r.title));
              hits.set(r.author.id, e);
            }
          } catch {}
        }
        const ranked = [...hits.values()].sort((a, b) => b.overlap - a.overlap).slice(0, max_results * 2);
        const detailed = await mapLimit(ranked, 5, async (c) => {
          const h = await channelHeader(youtube, c.id);
          if (!h.subs) return null;
          const sizeCloseness = me.subs ? 1 / (1 + Math.abs(Math.log10(h.subs / me.subs))) : 0.5;
          return {
            channel: h.title ?? c.name, channel_id: c.id, url: `https://www.youtube.com/channel/${c.id}`,
            subscribers: h.subs_text, topical_overlap: c.overlap + "/" + top.length,
            similarity_score: +((c.overlap / top.length) * 0.7 + sizeCloseness * 0.3).toFixed(2),
            matched_videos: c.sample,
          };
        });
        detailed.sort((a, b) => b.similarity_score - a.similarity_score);
        return ok({ source: me.title, source_subs: me.subs_text, similar: detailed.slice(0, max_results) });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- channel_monetization ----------
  server.tool(
    "channel_monetization",
    "ALGROW-STYLE monetization profile: scans the channel About page and recent + top video descriptions for selling links. Returns every method found with evidence (which video/page).",
    { channel: z.string().describe("Channel ID, @handle, or URL") },
    async ({ channel }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const { ch, title } = await channelHeader(youtube, id);
        const findings = [];
        try {
          const about = JSON.stringify(await ch.getAbout());
          for (const l of classifyLinks(about)) findings.push({ ...l, evidence: "channel About page" });
        } catch {}
        const { videos } = await uploadsOf(youtube, id);
        const lf = videos.filter((v) => v.views);
        const toScan = [...lf.slice(0, 3), ...lf.sort((a, b) => b.views - a.views).slice(0, 2)]
          .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i).slice(0, 5);
        for (const v of toScan) {
          try {
            const i = await youtube.getInfo(v.id);
            for (const l of classifyLinks(i.basic_info?.short_description))
              findings.push({ ...l, evidence: `description of "${v.title?.slice(0, 50)}" (${v.views} views)` });
          } catch {}
        }
        const unique = findings.filter((m, i, a) => a.findIndex((x) => x.url === m.url) === i);
        const byType = {};
        for (const f of unique) (byType[f.type] = byType[f.type] || []).push({ url: f.url, evidence: f.evidence });
        return ok({ channel: title, channel_id: id, selling: unique.length > 0, methods: byType });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- channel_shorts ----------
  server.tool(
    "channel_shorts",
    "Browse a channel's Shorts (the real Shorts tab via the UUSH uploads playlist), newest first.",
    {
      channel: z.string().describe("Channel ID, @handle, or URL"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ channel, limit }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const { videos, total } = await uploadsOf(youtube, id, "UUSH");
        return ok({ channel: id, total_shorts: total, count: Math.min(videos.length, limit), shorts: videos.slice(0, limit) });
      } catch (e) { return fail(e); }
    }
  );

  // ---------- watchlist ----------
  server.tool(
    "watchlist_add",
    "Add channels to your watchlist (Algrow folders-lite). Watched channels get growth tracking via watchlist_report.",
    { channels: z.array(z.string()).describe("Channel IDs, @handles, or URLs") },
    async ({ channels }) => {
      try {
        const youtube = await getYT();
        const list = readJSON("watchlist.json", []);
        const added = [];
        for (const c of channels) {
          const id = await resolveChannelId(youtube, c);
          if (list.some((w) => w.id === id)) continue;
          const h = await channelHeader(youtube, id);
          list.push({ id, name: h.title, added: new Date().toISOString().slice(0, 10) });
          added.push(h.title ?? id);
        }
        writeJSON("watchlist.json", list);
        return ok({ added, total_watched: list.length });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "watchlist_remove",
    "Remove a channel from the watchlist.",
    { channel: z.string() },
    async ({ channel }) => {
      try {
        const youtube = await getYT();
        const id = await resolveChannelId(youtube, channel);
        const list = readJSON("watchlist.json", []);
        const next = list.filter((w) => w.id !== id);
        writeJSON("watchlist.json", next);
        return ok({ removed: list.length - next.length, total_watched: next.length });
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "watchlist_list",
    "List watched channels.",
    {},
    async () => ok({ watchlist: readJSON("watchlist.json", []) })
  );

  // ---------- watchlist_report ----------
  server.tool(
    "watchlist_report",
    "ALGROW-STYLE growth leaderboard for your watchlist: snapshots every watched channel and reports view gains since the last report — your morning briefing. Run it daily (or schedule it) for 24h deltas.",
    {},
    async () => {
      try {
        const youtube = await getYT();
        const list = readJSON("watchlist.json", []);
        if (!list.length) return fail(new Error("Watchlist is empty — add channels with watchlist_add"));
        const snaps = readJSON("watchlist_snaps.json", {});
        const now = Date.now();
        const rows = await mapLimit(list, 4, async (w) => {
          const { videos } = await uploadsOf(youtube, w.id);
          const current = {}; let totalRecent = 0;
          for (const v of videos.filter((v) => v.id && typeof v.views === "number")) { current[v.id] = v.views; totalRecent += v.views; }
          const prev = snaps[w.id];
          let gained = null, hours = null, newVideos = [];
          if (prev) {
            hours = +((now - prev.ts) / 3600000).toFixed(1);
            gained = 0;
            for (const [vid, views] of Object.entries(current)) {
              if (prev.videos[vid] != null) gained += views - prev.videos[vid];
              else newVideos.push(videos.find((v) => v.id === vid)?.title);
            }
          }
          snaps[w.id] = { ts: now, videos: current };
          return { channel: w.name, channel_id: w.id, views_gained: gained, hours_since_last: hours, new_videos: newVideos, tracked_videos: Object.keys(current).length };
        });
        writeJSON("watchlist_snaps.json", snaps);
        rows.sort((a, b) => (b.views_gained ?? -1) - (a.views_gained ?? -1));
        return ok({ report_time: new Date().toISOString(), channels: rows, note: rows.some((r) => r.views_gained == null) ? "Channels with null gains were baselined now — deltas appear on the next report." : undefined });
      } catch (e) { return fail(e); }
    }
  );
}
