#!/usr/bin/env node
/**
 * Misfits Lab — YouTube research MCP server (InnerTube via youtubei.js)
 * No API key, no quota. Algrow/vidIQ-style research tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Innertube } from "youtubei.js";
import { registerAlgrowTools } from "./algrow_tools.js";
import { registerDbTools } from "./db_tools.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

let yt = null;
async function getYT() {
  if (!yt) yt = await Innertube.create({ generate_session_locally: true });
  return yt;
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  return {
    content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
    isError: true,
  };
}
const txt = (v) => (v && typeof v === "object" && "text" in v ? v.text : v);
const parseViews = (s) => {
  if (typeof s === "number") return s;
  if (!s) return null;
  const m = String(s).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};
/** "3 weeks ago" -> days */
function relToDays(rel) {
  if (!rel) return null;
  const m = rel.match(/(\d+)\s*(minute|hour|day|week|month|year)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
  return Math.round(n * unit * 10) / 10;
}
function ageDays(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export function buildServer() {
  const server = new McpServer({ name: "Misfits Lab", version: "2.1.0" });
  registerTools(server);
  registerAlgrowTools(server);
  registerDbTools(server);
  return server;
}

function registerTools(server) {


// ============ helpers ============
function extractVideoId(input) {
  const m = input.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(input)) return input;
  throw new Error(`Could not extract video ID from: ${input}`);
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

/** All channel uploads via the hidden "UU..." uploads playlist. Reliable for any layout. */
async function channelUploads(youtube, channelId, _retry = 0) {
  const pl = await youtube.getPlaylist("UU" + channelId.slice(2));
  const total = parseViews(txt(pl.info?.total_items));
  if ((pl.videos || []).length === 0 && (total || 0) > 0 && _retry < 2) {
    await new Promise((r) => setTimeout(r, 600));
    return channelUploads(youtube, channelId, _retry + 1);
  }
  const videos = (pl.videos || []).map((v) => {
    const info = txt(v.video_info) || "";
    const [viewsPart, publishedPart] = info.split("•").map((s) => s?.trim());
    return {
      id: v.id,
      title: txt(v.title),
      duration: v.duration?.text,
      views: parseViews(viewsPart),
      published: publishedPart || null,
      published_days_ago: relToDays(publishedPart),
    };
  });
  return { videos, total_uploads: total ?? videos.length };
}

/** Channel about info: joined date, total views, country. */
async function channelAbout(youtube, channelId) {
  const out = { joined: null, total_views: null, country: null };
  try {
    const ch = await youtube.getChannel(channelId);
    let aboutStr = "";
    try {
      aboutStr = JSON.stringify(await ch.getAbout());
    } catch {
      aboutStr = JSON.stringify(ch);
    }
    out.joined =
      (aboutStr.match(/Joined\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})/) || [])[1] || null;
    const viewsM = aboutStr.match(/"([\d,]{4,})\s+views"/);
    out.total_views = viewsM ? parseViews(viewsM[1]) : null;
    out.country =
      (aboutStr.match(/"country":\s*(?:\{[^}]*"text":\s*)?"([^"]{2,30})"/) || [])[1] || null;
    out.subscribers =
      (aboutStr.match(/"([\d.,]+[KMB]?)\s+subscribers"/) || [])[1] || null;
    out.title = (aboutStr.match(/"title":\s*"([^"]+)"/) || [])[1] || null;
  } catch {}
  return out;
}

/** Extract & classify monetization links from a description. */
const SOCIAL = /instagram\.com|tiktok\.com|twitter\.com|x\.com\/|facebook\.com|youtube\.com|youtu\.be|spotify\.com|threads\.net/i;
const CLASSIFY = [
  [/patreon\.com|skool\.com|discord\.gg|circle\.so/i, "Community/Membership"],
  [/gumroad\.com|payhip\.com|lemonsqueezy\.com|stan\.store|whop\.com|sellfy\.com|itch\.io|etsy\.com|beacons\.ai|ko-fi\.com|buymeacoffee\.com/i, "Digital Product"],
  [/teachable\.com|thinkific\.com|kajabi\.com|podia\.com|udemy\.com/i, "Course"],
  [/amzn\.to|amazon\.[a-z.]+/i, "Affiliate (Amazon)"],
  [/linktr\.ee|bio\.link|linkin\.bio/i, "Link hub"],
];
function detectMonetization(description) {
  if (!description) return [];
  const urls = [...description.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0]);
  const found = [];
  for (const url of urls) {
    if (SOCIAL.test(url)) continue;
    let type = "Own website (possible product)";
    for (const [re, label] of CLASSIFY) {
      if (re.test(url)) { type = label; break; }
    }
    if (!found.some((f) => f.url === url)) found.push({ type, url });
  }
  return found.slice(0, 8);
}

// ============ core tools ============
server.tool(
  "youtube_search",
  "Search YouTube for videos, channels, or playlists. Supports upload-date filter and sorting — use upload_date to find recent content in a niche.",
  {
    query: z.string().describe("Search query"),
    type: z.enum(["video", "channel", "playlist", "all"]).default("video"),
    upload_date: z.enum(["any", "hour", "today", "week", "month", "year"]).default("any"),
    sort_by: z.enum(["relevance", "upload_date", "view_count", "rating"]).default("relevance"),
    limit: z.number().int().min(1).max(50).default(15),
  },
  async ({ query, type, upload_date, sort_by, limit }) => {
    try {
      const youtube = await getYT();
      const filters = {};
      if (type !== "all") filters.type = type;
      if (upload_date !== "any") filters.upload_date = upload_date;
      if (sort_by !== "relevance") filters.sort_by = sort_by;
      const search = await youtube.search(query, filters);
      const results = (search.results || [])
        .filter((r) => ["Video", "Channel", "Playlist", "CompactVideo"].includes(r.type))
        .slice(0, limit)
        .map((r) => ({
          type: r.type,
          id: r.id,
          title: txt(r.title) ?? txt(r.author?.name),
          channel: r.author?.name,
          channel_id: r.author?.id,
          views: txt(r.view_count) ?? txt(r.short_view_count),
          duration: r.duration?.text,
          published: txt(r.published),
          subscribers: txt(r.subscriber_count),
        }));
      return ok({ query, count: results.length, results });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "video_info",
  "Full metadata for a video: views, likes, tags, description (with monetization links detected), duration, publish date.",
  { video_id: z.string().describe("YouTube video ID or URL") },
  async ({ video_id }) => {
    try {
      const id = extractVideoId(video_id);
      const youtube = await getYT();
      const info = await youtube.getInfo(id);
      const b = info.basic_info;
      return ok({
        id: b.id,
        title: b.title,
        channel: b.channel?.name,
        channel_id: b.channel?.id,
        views: b.view_count,
        likes: b.like_count,
        duration_seconds: b.duration,
        published: info.primary_info?.published?.text,
        category: b.category,
        tags: b.keywords,
        monetization_links: detectMonetization(b.short_description),
        description: b.short_description?.slice(0, 1500),
        thumbnail: b.thumbnail?.[0]?.url,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "channel_info",
  "Channel stats incl. AGE: subscribers, uploads, total views, country, joined date, and when they STARTED UPLOADING (Algrow-style 'started X days ago').",
  { channel: z.string().describe("Channel ID (UC...), @handle, or channel URL") },
  async ({ channel }) => {
    try {
      const youtube = await getYT();
      const id = await resolveChannelId(youtube, channel);
      const about = await channelAbout(youtube, id);
      let uploads = null;
      try {
        uploads = await channelUploads(youtube, id);
      } catch {}
      const oldest = uploads?.videos?.[uploads.videos.length - 1];
      const allUploadsOnPage = uploads && uploads.videos.length >= (uploads.total_uploads || 0);
      return ok({
        id,
        title: about.title,
        subscribers: about.subscribers,
        total_views: about.total_views,
        total_uploads: uploads?.total_uploads,
        joined: about.joined,
        account_age_days: ageDays(about.joined),
        started_uploading: oldest ? oldest.published : null,
        started_uploading_days_ago: allUploadsOnPage ? oldest?.published_days_ago : oldest ? `>${oldest.published_days_ago} (older videos exist)` : null,
        country: about.country,
        url: `https://www.youtube.com/channel/${id}`,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "channel_videos",
  "List a channel's uploads with views and publish recency (uses the uploads playlist — works for any channel layout).",
  {
    channel: z.string().describe("Channel ID (UC...), @handle, or channel URL"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ channel, limit }) => {
    try {
      const youtube = await getYT();
      const id = await resolveChannelId(youtube, channel);
      const { videos, total_uploads } = await channelUploads(youtube, id);
      return ok({ channel: id, total_uploads, count: Math.min(videos.length, limit), videos: videos.slice(0, limit) });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "video_transcript",
  "Get the transcript/captions of a video as plain text.",
  { video_id: z.string().describe("YouTube video ID or URL") },
  async ({ video_id }) => {
    try {
      const id = extractVideoId(video_id);
      const youtube = await getYT();
      const info = await youtube.getInfo(id);
      const t = await info.getTranscript();
      const segments = t?.transcript?.content?.body?.initial_segments || [];
      const text = segments
        .map((s) => txt(s.snippet) ?? s.snippet?.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return fail(new Error("No transcript available"));
      return ok({ id, length_chars: text.length, transcript: text.slice(0, 50000) });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "video_comments",
  "Top or newest comments on a video with like counts.",
  {
    video_id: z.string().describe("YouTube video ID or URL"),
    limit: z.number().int().min(1).max(50).default(20),
    sort: z.enum(["top", "newest"]).default("top"),
  },
  async ({ video_id, limit, sort }) => {
    try {
      const id = extractVideoId(video_id);
      const youtube = await getYT();
      const comments = await youtube.getComments(
        id,
        sort === "top" ? "TOP_COMMENTS" : "NEWEST_FIRST"
      );
      const items = (comments.contents || []).slice(0, limit).map((t) => ({
        author: t.comment?.author?.name,
        text: txt(t.comment?.content),
        likes: t.comment?.like_count,
        published: t.comment?.published_time,
      }));
      return ok({ id, count: items.length, comments: items });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "trending_videos",
  "Currently trending YouTube videos.",
  { limit: z.number().int().min(1).max(50).default(20) },
  async ({ limit }) => {
    try {
      const youtube = await getYT();
      const trending = await youtube.getTrending();
      const videos = (trending.videos || []).slice(0, limit).map((v) => ({
        id: v.id,
        title: txt(v.title),
        channel: v.author?.name,
        views: txt(v.view_count) ?? txt(v.short_view_count),
        published: txt(v.published),
      }));
      return ok({ count: videos.length, videos });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "related_videos",
  "Videos YouTube recommends next to a given video.",
  {
    video_id: z.string().describe("YouTube video ID or URL"),
    limit: z.number().int().min(1).max(30).default(15),
  },
  async ({ video_id, limit }) => {
    try {
      const id = extractVideoId(video_id);
      const youtube = await getYT();
      const info = await youtube.getInfo(id);
      const related = (info.watch_next_feed || [])
        .filter((v) => v.id)
        .slice(0, limit)
        .map((v) => ({
          id: v.id,
          title: txt(v.title) ?? txt(v.metadata?.title),
          channel: v.author?.name,
          views: txt(v.view_count) ?? txt(v.short_view_count),
          published: txt(v.published),
        }));
      return ok({ source_video: id, count: related.length, related });
    } catch (e) {
      return fail(e);
    }
  }
);

// ============ Algrow/vidIQ-style tools ============
server.tool(
  "find_new_channels",
  "ALGROW-STYLE: Find channels that STARTED UPLOADING recently in a niche and detect how they monetize (digital products, communities, courses). Searches recent videos, checks first-upload age, scans descriptions for selling links. Slow (30-90s) — be patient.",
  {
    query: z.string().describe("Niche/topic to search, e.g. 'amish frugal living'"),
    max_channel_age_days: z.number().int().min(1).max(365).default(60).describe("Only channels whose FIRST upload is within this many days"),
    max_channels: z.number().int().min(1).max(10).default(6),
  },
  async ({ query, max_channel_age_days, max_channels }) => {
    try {
      const youtube = await getYT();
      const search = await youtube.search(query, { type: "video", upload_date: "month" });
      const seen = new Set();
      const candidates = [];
      for (const r of search.results || []) {
        if (r.type !== "Video" || !r.author?.id || seen.has(r.author.id)) continue;
        seen.add(r.author.id);
        candidates.push({ channel_id: r.author.id, channel: r.author.name });
        if (candidates.length >= max_channels * 3) break;
      }
      const results = [];
      for (const c of candidates) {
        if (results.length >= max_channels) break;
        try {
          const { videos, total_uploads } = await channelUploads(youtube, c.channel_id);
          if (!videos.length) continue;
          const oldest = videos[videos.length - 1];
          const fullHistory = videos.length >= (total_uploads || 0);
          const startedDays = oldest.published_days_ago;
          if (!fullHistory || startedDays == null || startedDays > max_channel_age_days) continue;
          const about = await channelAbout(youtube, c.channel_id);
          const recent = videos.slice(0, 10);
          const avgViews = Math.round(
            recent.reduce((a, v) => a + (v.views || 0), 0) / recent.length
          );
          let monetization = [];
          for (const v of videos.slice(0, 2)) {
            try {
              const info = await youtube.getInfo(v.id);
              monetization.push(...detectMonetization(info.basic_info?.short_description));
            } catch {}
          }
          monetization = monetization.filter(
            (m, i, arr) => arr.findIndex((x) => x.url === m.url) === i
          );
          results.push({
            channel: c.channel,
            channel_id: c.channel_id,
            url: `https://www.youtube.com/channel/${c.channel_id}`,
            started_uploading_days_ago: startedDays,
            uploads: total_uploads,
            subscribers: about.subscribers,
            total_views: about.total_views,
            avg_recent_views: avgViews,
            selling: monetization.length > 0,
            monetization,
            latest_video: { id: videos[0].id, title: videos[0].title, views: videos[0].views, published: videos[0].published },
          });
        } catch {}
      }
      results.sort((a, b) => (b.avg_recent_views || 0) - (a.avg_recent_views || 0));
      return ok({ query, max_channel_age_days, found: results.length, channels: results });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "channel_outliers",
  "VIDIQ-STYLE: Find a channel's outlier videos — views vs. the channel's median (outlier score). Score >3 = strong outlier worth studying.",
  {
    channel: z.string().describe("Channel ID, @handle, or URL"),
    limit: z.number().int().min(5).max(100).default(50),
  },
  async ({ channel, limit }) => {
    try {
      const youtube = await getYT();
      const id = await resolveChannelId(youtube, channel);
      const { videos } = await channelUploads(youtube, id);
      const withViews = videos.slice(0, limit).filter((v) => typeof v.views === "number" && v.views > 0);
      if (withViews.length < 3) return fail(new Error("Not enough view data"));
      const sorted = [...withViews].sort((a, b) => a.views - b.views);
      const median = sorted[Math.floor(sorted.length / 2)].views;
      const scored = withViews
        .map((v) => ({ ...v, outlier_score: +(v.views / median).toFixed(2) }))
        .sort((a, b) => b.outlier_score - a.outlier_score);
      return ok({
        channel: id,
        videos_analyzed: withViews.length,
        median_views: median,
        outliers: scored.filter((v) => v.outlier_score >= 2),
        all: scored,
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "keyword_research",
  "VIDIQ-STYLE keyword research: autocomplete suggestions (what people search) + competition snapshot of top results (avg views, freshness, channel names).",
  { keyword: z.string().describe("Seed keyword") },
  async ({ keyword }) => {
    try {
      const youtube = await getYT();
      let suggestions = [];
      try {
        suggestions = await youtube.getSearchSuggestions(keyword);
      } catch {}
      const search = await youtube.search(keyword, { type: "video" });
      const top = (search.results || [])
        .filter((r) => r.type === "Video")
        .slice(0, 20)
        .map((r) => ({
          title: txt(r.title),
          channel: r.author?.name,
          views: parseViews(txt(r.view_count) ?? txt(r.short_view_count)),
          published: txt(r.published),
        }));
      const views = top.map((t) => t.views).filter((v) => typeof v === "number");
      const recentCount = top.filter((t) => /day|week|hour|minute/.test(t.published || "")).length;
      return ok({
        keyword,
        suggestions,
        competition: {
          top_results_analyzed: top.length,
          avg_views: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
          max_views: views.length ? Math.max(...views) : null,
          min_views: views.length ? Math.min(...views) : null,
          results_from_last_month: recentCount,
          freshness_signal: recentCount >= 5 ? "active niche — new videos ranking" : "older videos dominate — opportunity or dead niche",
        },
        top_results: top.slice(0, 10),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "track_views",
  "ALGROW-STYLE realtime deltas: snapshots a channel's video view counts and reports the CHANGE since the last snapshot (e.g. +380K in 24h). First call creates a baseline; call again later (or schedule it) to see deltas.",
  { channel: z.string().describe("Channel ID, @handle, or URL") },
  async ({ channel }) => {
    try {
      const youtube = await getYT();
      const id = await resolveChannelId(youtube, channel);
      const { videos } = await channelUploads(youtube, id);
      const about = await channelAbout(youtube, id);
      const now = Date.now();
      const snapshot = {
        ts: now,
        total_views: about.total_views,
        videos: Object.fromEntries(videos.filter((v) => v.id).map((v) => [v.id, v.views])),
      };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, `${id}.json`);
      let prev = null;
      try {
        prev = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      fs.writeFileSync(file, JSON.stringify(snapshot));
      if (!prev) {
        return ok({
          channel: id,
          status: "baseline created",
          note: "Call track_views again later (e.g. in 24h, or via a scheduled task) to get view deltas.",
          current: videos.slice(0, 10).map((v) => ({ id: v.id, title: v.title, views: v.views })),
        });
      }
      const hours = +((now - prev.ts) / 3600000).toFixed(1);
      const deltas = videos
        .filter((v) => v.id)
        .map((v) => ({
          id: v.id,
          title: v.title,
          views: v.views,
          gained: prev.videos[v.id] != null ? v.views - prev.videos[v.id] : "new video",
        }))
        .sort(
          (a, b) =>
            (typeof b.gained === "number" ? b.gained : Infinity) -
            (typeof a.gained === "number" ? a.gained : 0)
        );
      return ok({
        channel: id,
        hours_since_last_snapshot: hours,
        channel_views_gained:
          about.total_views != null && prev.total_views != null
            ? about.total_views - prev.total_views
            : null,
        video_deltas: deltas.slice(0, 15),
      });
    } catch (e) {
      return fail(e);
    }
  }
);
}
