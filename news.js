// news.js (CommonJS) — FAST FREE RSS news aggregator (stale-while-revalidate cache)
// ✅ No API keys
// ✅ Very fast responses (returns cached results immediately)
// ✅ Short timeouts per feed (won’t hang the whole request)
// ✅ Parallel fetch with per-feed limit
// ✅ HTTP caching headers (Cloudflare/Render can cache too)
//
// Endpoint:
//   GET /news?country=ca&pageSize=10
//   GET /news?country=ca&city=Calgary&pageSize=10
//   GET /news?country=us&q=tech&pageSize=10

const express = require("express");
const Parser = require("rss-parser");

const router = express.Router();

// Keep timeouts short so UI feels instant.
// If a feed is slow, we skip it instead of waiting forever.
const parser = new Parser({
  timeout: 4500, // ✅ lower = faster feel
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

function isoDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function stripHtml(s) {
  return clean(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
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

function scoreItem({ title, description }, q, city) {
  const t = (title || "").toLowerCase();
  const d = (description || "").toLowerCase();
  let score = 0;

  const bump = (term, w) => {
    if (!term) return;
    const s = term.toLowerCase();
    if (t.includes(s)) score += w * 2;
    if (d.includes(s)) score += w;
  };

  bump(q, 4);
  bump(city, 3);

  const important = [
    "storm", "warning", "emergency", "evacuation",
    "outage", "strike", "shutdown",
    "rate", "inflation", "bank", "market",
    "hack", "breach", "vulnerability", "zero-day",
    "wildfire", "earthquake", "flood",
  ];
  for (const k of important) bump(k, 0.7);

  return score;
}

function cacheKey(country, city, q, pageSize) {
  return `${country}|${clean(city).toLowerCase()}|${clean(q).toLowerCase()}|${pageSize}`;
}

// -------------------- feeds (keep them reliable + fast) --------------------
// (If you add too many feeds, you increase latency + failure chance.)

const FEEDS_CA = [
  { name: "CBC", url: "https://www.cbc.ca/webfeed/rss/rss-topstories" },
  { name: "Global News", url: "https://globalnews.ca/feed/" },
  { name: "CTV News", url: "https://www.ctvnews.ca/rss/ctvnews-ca-top-stories-public-rss-1.822009" },
  // CP24 can be slower sometimes; keep it as optional fallback (we still try it but won’t block)
  { name: "CP24", url: "https://www.cp24.com/rss/cp24-top-stories-1.1129631" },
];

const FEEDS_US = [
  { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "CNN", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "AP News", url: "https://apnews.com/rss" }, // sometimes blocks; won’t block response
];

const FEEDS_GLOBAL = [
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

// return fresh for 2 minutes; allow stale for 20 minutes (but refresh in background)
const FRESH_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 20 * 60 * 1000;

// -------------------- core fetch --------------------

async function fetchFeeds({ feeds, city, q, pageSize }) {
  // Fetch in parallel, but don’t let one slow feed hold the whole request forever.
  // rss-parser timeout already helps, but Promise.allSettled ensures partial results.
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const feed = await parser.parseURL(f.url);
      const items = Array.isArray(feed?.items) ? feed.items : [];
      return { feedName: f.name, items: items.slice(0, 25) }; // ✅ limit per feed for speed
    })
  );

  let articles = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const { feedName, items } = r.value;

    for (const it of items) {
      const title = clean(it?.title);
      const url = clean(it?.link || it?.guid);
      if (!title || !url || !/^https?:\/\//i.test(url)) continue;

      const description = stripHtml(
        it?.contentSnippet || it?.content || it?.summary || it?.description || ""
      );

      articles.push({
        title,
        description: description || null,
        url,
        image_url: extractImageUrl(it) || null,
        source: feedName,
        published_at: isoDate(it?.isoDate || it?.pubDate || it?.date),
      });
    }
  }

  articles = dedupeByUrl(articles);

  // Date-first sort (fast + sensible)
  articles.sort((a, b) => {
    const da = a.published_at ? new Date(a.published_at).getTime() : 0;
    const db = b.published_at ? new Date(b.published_at).getTime() : 0;
    return db - da;
  });

  // If q/city, then relevance sort
  if (q || city) {
    articles = articles
      .map((a) => ({ ...a, _score: scoreItem(a, q, city) }))
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .map(({ _score, ...rest }) => rest);
  }

  return articles.slice(0, pageSize);
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
    // Trigger refresh (only once)
    if (!entry.refreshing) {
      entry.refreshing = (async () => {
        try {
          const data = await buildPayload({ country, city, q, pageSize });
          CACHE.set(key, { ts: Date.now(), data, refreshing: null });
        } catch {
          // keep stale
          const e2 = CACHE.get(key);
          if (e2) e2.refreshing = null;
        }
      })();
    }
    return { mode: "stale_cache", payload: entry.data };
  }

  // 3) No cache (or too old) -> fetch now (first request will take a moment)
  const data = await buildPayload({ country, city, q, pageSize });
  CACHE.set(key, { ts: Date.now(), data, refreshing: null });
  return { mode: "miss", payload: data };
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

// -------------------- route --------------------

router.get("/news", async (req, res) => {
  try {
    const country = normalizeCountry(req.query.country);
    const city = clean(req.query.city) || null;
    const q = clean(req.query.q) || null;
    const pageSize = clamp(req.query.pageSize || 10, 1, 20);

    // ✅ CDN/client caching: returns fast + avoids re-fetch spam
    // - allow cache 60s
    // - allow stale-while-revalidate 5 minutes
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

    const { mode, payload } = await getNewsCached({ country, city, q, pageSize });

    // Helpful debug headers (optional; safe)
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

module.exports = router;