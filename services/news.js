// services/news.js (CommonJS) — FAST + FREE RSS news aggregator (stale-while-revalidate cache)
// ✅ No API keys
// ✅ Fast: returns cached results immediately
// ✅ Won’t hang: per-feed timeout + allSettled + per-feed item cap
// ✅ Dedup + relevance scoring (q/city) + recency preference
// ✅ Memory-safe: cache size cap + periodic pruning
//
// Endpoint:
//   GET /news?country=ca&pageSize=10
//   GET /news?country=ca&city=Calgary&pageSize=10
//   GET /news?country=us&q=tech&pageSize=10
//
// BONUS (for LXT wiring later):
// - this module exports an Express router (default) AND attaches `service`:
//     require("./services/news").service.getLive({ country, city, q, pageSize })
//
// So index.js can keep doing: app.use("/", newsRoute)

const express = require("express");
const Parser = require("rss-parser");

const router = express.Router();

// Keep timeouts short so UI feels instant.
// If a feed is slow, we skip it instead of waiting forever.
const parser = new Parser({
  timeout: 4500,
  headers: {
    "User-Agent": "LoravoNewsBot/1.0 (+https://loravo.app)",
    Accept: "application/rss+xml,application/xml,text/xml,*/*",
  },
});

// -------------------- helpers --------------------

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function clean(s) {
  return String(s || "").trim();
}

function normalizeCountry(c) {
  const s = clean(c).toLowerCase();
  if (!s) return "ca";
  if (s.length === 2) return s;
  if (s === "canada") return "ca";
  if (["united states", "usa", "us", "america"].includes(s)) return "us";
  return s.slice(0, 2);
}

function stripHtml(s) {
  return clean(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

function safeUrl(u) {
  const s = clean(u);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}

function isoDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function millis(d) {
  const i = isoDate(d);
  return i ? new Date(i).getTime() : 0;
}

function extractImageUrl(item) {
  const enc = item?.enclosure?.url ? clean(item.enclosure.url) : null;
  if (enc && /^https?:\/\//i.test(enc)) return enc;

  const itunesImg =
    item?.itunes?.image ? clean(item.itunes.image)
    : item?.itunes?.image?.href ? clean(item.itunes.image.href)
    : null;
  if (itunesImg && /^https?:\/\//i.test(itunesImg)) return itunesImg;

  const mediaContent = item?.["media:content"] || item?.["media:thumbnail"] || null;
  if (Array.isArray(mediaContent)) {
    for (const m of mediaContent) {
      const u = clean(m?.$?.url || m?.url);
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  } else if (mediaContent) {
    const u = clean(mediaContent?.$?.url || mediaContent?.url);
    if (u && /^https?:\/\//i.test(u)) return u;
  }

  // last resort: try find <img src="..."> in html
  const html = clean(item?.content || item?.contentSnippet || item?.summary || "");
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1] && /^https?:\/\//i.test(m[1])) return clean(m[1]);

  return null;
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const u = it.url;
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(it);
  }
  return out;
}

function scoreItem({ title, description, source }, q, city) {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const s = (source || "").toLowerCase();
  let score = 0;

  const bump = (term, w) => {
    if (!term) return;
    const x = String(term).toLowerCase();
    if (t.includes(x)) score += w * 2.2;
    if (d.includes(x)) score += w;
    if (s.includes(x)) score += w * 0.2;
  };

  bump(q, 4);
  bump(city, 3);

  // “Matters-now” keywords
  const important = [
    "storm", "warning", "emergency", "evacuation",
    "outage", "strike", "shutdown",
    "rate", "inflation", "bank", "market",
    "hack", "breach", "vulnerability", "zero-day",
    "wildfire", "earthquake", "flood",
    "tariff", "sanction", "border", "trade",
    "recall", "fraud", "lawsuit",
  ];
  for (const k of important) bump(k, 0.75);

  return score;
}

function cacheKey(country, city, q, pageSize) {
  return `${country}|${clean(city).toLowerCase()}|${clean(q).toLowerCase()}|${pageSize}`;
}

// -------------------- feeds (keep them reliable + fast) --------------------
// Keep list small; too many feeds increases latency + failure chance.

const FEEDS_CA = [
  { name: "CBC", url: "https://www.cbc.ca/webfeed/rss/rss-topstories" },
  { name: "Global News", url: "https://globalnews.ca/feed/" },
  { name: "CTV News", url: "https://www.ctvnews.ca/rss/ctvnews-ca-top-stories-public-rss-1.822009" },
  { name: "CP24", url: "https://www.cp24.com/rss/cp24-top-stories-1.1129631" },
];

const FEEDS_US = [
  { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  // CNN’s RSS is sometimes flaky; keep it but don’t rely on it
  { name: "CNN", url: "https://rss.cnn.com/rss/cnn_topstories.rss" },
  // AP can block; still safe because we never block response
  { name: "AP News", url: "https://apnews.com/rss" },
];

const FEEDS_GLOBAL = [
  // Reuters feed can be heavier; still fine with caps + timeouts
  { name: "Reuters (Top)", url: "https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best" },
];

// -------------------- FAST CACHE (stale-while-revalidate) --------------------

/**
 * cache entry:
 *  {
 *    ts: number,
 *    data: object,
 *    refreshing: Promise|null
 *  }
 */
const CACHE = new Map();

// return fresh for 5 minutes; allow stale for 20 minutes (but refresh in background)
const FRESH_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 20 * 60 * 1000;

// memory safety
const CACHE_MAX_KEYS = 250;           // cap cache map keys
const CACHE_PRUNE_EVERY_MS = 2 * 60 * 1000;

function pruneCache() {
  if (CACHE.size <= CACHE_MAX_KEYS) return;

  // remove oldest first
  const entries = Array.from(CACHE.entries()).sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
  const removeCount = Math.max(0, CACHE.size - CACHE_MAX_KEYS);
  for (let i = 0; i < removeCount; i++) CACHE.delete(entries[i][0]);
}

setInterval(() => {
  // drop entries that are ancient
  const now = Date.now();
  for (const [k, v] of CACHE.entries()) {
    if (!v?.ts) continue;
    if (now - v.ts > STALE_TTL_MS * 3) CACHE.delete(k);
  }
  pruneCache();
}, CACHE_PRUNE_EVERY_MS).unref?.();

// -------------------- core fetch --------------------

async function fetchFeeds({ feeds, city, q, pageSize }) {
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const feed = await parser.parseURL(f.url);
      const items = Array.isArray(feed?.items) ? feed.items : [];
      return { feedName: f.name, items: items.slice(0, 25) }; // cap per feed for speed
    })
  );

  let articles = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { feedName, items } = r.value;

    for (const it of items) {
      const title = clean(it?.title);
      const url = safeUrl(it?.link || it?.guid);
      if (!title || !url) continue;

      const description = stripHtml(it?.contentSnippet || it?.content || it?.summary || it?.description || "");

      const published_at =
        isoDate(it?.isoDate) ||
        isoDate(it?.pubDate) ||
        isoDate(it?.date) ||
        isoDate(it?.published) ||
        null;

      articles.push({
        title,
        description: description || null,
        url,
        image_url: extractImageUrl(it) || null,
        source: feedName,
        published_at,
      });
    }
  }

  articles = dedupeByUrl(articles);

  // Prefer recent items (and drop truly ancient items to avoid “stale feeds” feeling)
  const now = Date.now();
  const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  const recent = articles.filter((a) => {
    const t = a.published_at ? millis(a.published_at) : 0;
    return !t || now - t <= MAX_AGE_MS;
  });
  articles = recent.length ? recent : articles;

  // Date-first sort (sensible baseline)
  articles.sort((a, b) => (millis(b.published_at) || 0) - (millis(a.published_at) || 0));

  // If q/city, then relevance sort (but keep recency bias by blending)
  if (q || city) {
    articles = articles
      .map((a) => {
        const rel = scoreItem(a, q, city);
        const ageMs = a.published_at ? Math.max(0, now - millis(a.published_at)) : 0;
        const recencyBoost = ageMs ? Math.max(0, 1.2 - ageMs / (24 * 60 * 60 * 1000)) : 0.3; // up to ~1.2 for last 24h
        return { ...a, _score: rel + recencyBoost };
      })
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .map(({ _score, ...rest }) => rest);
  }

  return articles.slice(0, pageSize);
}

async function buildPayload({ country, city, q, pageSize }) {
  let feeds =
    country === "us" ? FEEDS_US :
    country === "ca" ? FEEDS_CA :
    FEEDS_GLOBAL;

  // Canada: add ONE global feed for coverage (still fast)
  if (country === "ca") feeds = [...feeds, ...FEEDS_GLOBAL];

  const articles = await fetchFeeds({ feeds, city, q, pageSize });

  return {
    ok: true,
    provider: "rss",
    region: { country, city: city || null },
    total: articles.length,
    articles,
    fetched_at: new Date().toISOString(),
  };
}

async function getNewsCached({ country, city, q, pageSize }) {
  const key = cacheKey(country, city, q, pageSize);
  const now = Date.now();
  const entry = CACHE.get(key);

  // 1) Fresh cache -> instant
  if (entry && entry.data && now - entry.ts <= FRESH_TTL_MS) {
    return { mode: "fresh_cache", payload: entry.data };
  }

  // 2) Stale cache -> return immediately AND refresh in background
  if (entry && entry.data && now - entry.ts <= STALE_TTL_MS) {
    if (!entry.refreshing) {
      entry.refreshing = (async () => {
        try {
          const data = await buildPayload({ country, city, q, pageSize });
          CACHE.set(key, { ts: Date.now(), data, refreshing: null });
          pruneCache();
        } catch {
          const e2 = CACHE.get(key);
          if (e2) e2.refreshing = null; // keep stale
        }
      })();
    }
    return { mode: "stale_cache", payload: entry.data };
  }

  // 3) Miss -> fetch now
  const data = await buildPayload({ country, city, q, pageSize });
  CACHE.set(key, { ts: Date.now(), data, refreshing: null });
  pruneCache();
  return { mode: "miss", payload: data };
}

// -------------------- LXT-friendly service (attached to router) --------------------
// Keeps backward compatibility: require("./services/news") is still a router usable by app.use().
// But index.js (later) can also do: const newsService = require("./services/news").service;

const service = {
  // This matches how LXT wants to “pull live news”
  // Example: service.getLive({ country:"ca", city:"Calgary", q:null, pageSize:10 })
  getLive: async ({ country = "ca", city = null, q = null, pageSize = 10 } = {}) => {
    const c = normalizeCountry(country);
    const size = clamp(pageSize, 1, 20);
    const { payload } = await getNewsCached({ country: c, city: clean(city) || null, q: clean(q) || null, pageSize: size });
    return payload;
  },
};

// -------------------- route --------------------

router.get("/news", async (req, res) => {
  try {
    const country = normalizeCountry(req.query.country);
    const city = clean(req.query.city) || null;
    const q = clean(req.query.q) || null;
    const pageSize = clamp(req.query.pageSize || 10, 1, 20);

    // CDN/client caching:
    // - allow cache 60s
    // - allow stale-while-revalidate 5 minutes
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

    const { mode, payload } = await getNewsCached({ country, city, q, pageSize });

    // Helpful debug header (safe)
    res.setHeader("X-News-Cache", mode);

    return res.json(payload);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(e?.message || e),
    });
  }
});

// Backward compatible export (router), plus attach `service`
module.exports = router;
module.exports.service = service;