// services/news.js (CommonJS) — FAST + FREE RSS news aggregator (stale-while-revalidate cache)
// ✅ No API keys
// ✅ Fast: returns cached results immediately
// ✅ Won’t hang: per-feed timeout + allSettled + per-feed item cap
// ✅ Dedup + relevance scoring (q/city) + recency preference
// ✅ Memory-safe: cache size cap + periodic pruning
// ✅ LXT-ready service export
//
// Endpoint:
//   GET /news?country=ca&pageSize=10
//   GET /news?country=ca&city=Calgary&pageSize=10
//   GET /news?country=us&q=tech&pageSize=10
//
// Exports:
//   module.exports = router
//   module.exports.service.getLive({ userId, country, city, q, pageSize })
//   module.exports.service.getRecentForUser({ userId, limit })
//   module.exports.service.summarizeForChat({ userId, memory, items })

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

/* ===================== HELPERS ===================== */

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

function normalizeCity(city) {
  const s = clean(city);
  if (!s) return null;
  return s.replace(/\s+/g, " ").trim();
}

function extractImageUrl(item) {
  const enc = item?.enclosure?.url ? clean(item.enclosure.url) : null;
  if (enc && /^https?:\/\//i.test(enc)) return enc;

  const itunesImg =
    item?.itunes?.image
      ? clean(item.itunes.image)
      : item?.itunes?.image?.href
      ? clean(item.itunes.image.href)
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

function dedupeNearDuplicateTitles(items) {
  const seen = new Set();
  const out = [];

  for (const it of items) {
    const key = clean(it.title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!key) continue;
    if (seen.has(key)) continue;

    seen.add(key);
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

  const important = [
    "storm", "warning", "emergency", "evacuation",
    "outage", "strike", "shutdown",
    "rate", "inflation", "bank", "market",
    "hack", "breach", "vulnerability", "zero-day",
    "wildfire", "earthquake", "flood",
    "tariff", "sanction", "border", "trade",
    "recall", "fraud", "lawsuit",
    "election", "policy", "interest rates",
  ];
  for (const k of important) bump(k, 0.75);

  return score;
}

function cacheKey(country, city, q, pageSize) {
  return `${country}|${clean(city).toLowerCase()}|${clean(q).toLowerCase()}|${pageSize}`;
}

/* ===================== FEEDS ===================== */

const FEEDS_CA = [
  { name: "CBC", url: "https://www.cbc.ca/webfeed/rss/rss-topstories" },
  { name: "Global News", url: "https://globalnews.ca/feed/" },
  { name: "CTV News", url: "https://www.ctvnews.ca/rss/ctvnews-ca-top-stories-public-rss-1.822009" },
  { name: "CP24", url: "https://www.cp24.com/rss/cp24-top-stories-1.1129631" },
];

const FEEDS_US = [
  { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "CNN", url: "https://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "AP News", url: "https://apnews.com/rss" },
];

const FEEDS_GLOBAL = [
  { name: "Reuters", url: "https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best" },
];

/* ===================== CACHE ===================== */

const CACHE = new Map();

const FRESH_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 20 * 60 * 1000;

const CACHE_MAX_KEYS = 250;
const CACHE_PRUNE_EVERY_MS = 2 * 60 * 1000;

function pruneCache() {
  if (CACHE.size <= CACHE_MAX_KEYS) return;

  const entries = Array.from(CACHE.entries()).sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
  const removeCount = Math.max(0, CACHE.size - CACHE_MAX_KEYS);
  for (let i = 0; i < removeCount; i++) CACHE.delete(entries[i][0]);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CACHE.entries()) {
    if (!v?.ts) continue;
    if (now - v.ts > STALE_TTL_MS * 3) CACHE.delete(k);
  }
  pruneCache();
}, CACHE_PRUNE_EVERY_MS).unref?.();

/* ===================== CORE FETCH ===================== */

async function fetchFeeds({ feeds, city, q, pageSize }) {
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const feed = await parser.parseURL(f.url);
      const items = Array.isArray(feed?.items) ? feed.items : [];
      return { feedName: f.name, items: items.slice(0, 25) };
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

      const description = stripHtml(
        it?.contentSnippet || it?.content || it?.summary || it?.description || ""
      );

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
  articles = dedupeNearDuplicateTitles(articles);

  const now = Date.now();
  const MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
  const recent = articles.filter((a) => {
    const t = a.published_at ? millis(a.published_at) : 0;
    return !t || now - t <= MAX_AGE_MS;
  });
  articles = recent.length ? recent : articles;

  articles.sort((a, b) => (millis(b.published_at) || 0) - (millis(a.published_at) || 0));

  if (q || city) {
    articles = articles
      .map((a) => {
        const rel = scoreItem(a, q, city);
        const ageMs = a.published_at ? Math.max(0, now - millis(a.published_at)) : 0;
        const recencyBoost = ageMs ? Math.max(0, 1.2 - ageMs / (24 * 60 * 60 * 1000)) : 0.3;
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

  if (entry && entry.data && now - entry.ts <= FRESH_TTL_MS) {
    return { mode: "fresh_cache", payload: entry.data };
  }

  if (entry && entry.data && now - entry.ts <= STALE_TTL_MS) {
    if (!entry.refreshing) {
      entry.refreshing = (async () => {
        try {
          const data = await buildPayload({ country, city, q, pageSize });
          CACHE.set(key, { ts: Date.now(), data, refreshing: null });
          pruneCache();
        } catch {
          const e2 = CACHE.get(key);
          if (e2) e2.refreshing = null;
        }
      })();
    }
    return { mode: "stale_cache", payload: entry.data };
  }

  const data = await buildPayload({ country, city, q, pageSize });
  CACHE.set(key, { ts: Date.now(), data, refreshing: null });
  pruneCache();
  return { mode: "miss", payload: data };
}

/* ===================== SIMPLE CHAT SUMMARIZER ===================== */

function summarizeItemsForChat(items, userText = "") {
  const list = Array.isArray(items) ? items.slice(0, 5) : [];
  if (!list.length) return "I’m not seeing anything solid to call out right now.";

  const aheadMode = /(what happened|what’s happening|whats happening|what is new|what’s going on|whats going on|anything i should know)/i.test(
    String(userText || "")
  );

  if (aheadMode) {
    const now = list[0];
    const next = list[1];

    const parts = [];
    parts.push(`Now: ${now.title}.`);
    if (now.description) parts.push(now.description.slice(0, 140) + (now.description.length > 140 ? "…" : ""));
    if (next?.title) parts.push(`Next to watch: ${next.title}.`);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  const top = list.slice(0, 3).map((x) => x.title);
  return top.join(" ");
}

/* ===================== SERVICE ===================== */

const service = {
  // LXT live pull
  getLive: async ({ userId, country = "ca", city = null, q = null, pageSize = 10 } = {}) => {
    const c = normalizeCountry(country);
    const size = clamp(pageSize, 1, 20);
    const finalCity = normalizeCity(city);
    const finalQ = clean(q) || null;

    const { payload } = await getNewsCached({
      country: c,
      city: finalCity,
      q: finalQ,
      pageSize: size,
    });

    return payload;
  },

  // DB fallback for LXT/index.js if needed
  getRecentForUser: async ({ userId, limit = 6 } = {}) => {
    return [];
  },

  // Human-tight news summary for chat
  summarizeForChat: async ({ userId, memory, items, userText } = {}) => {
    return summarizeItemsForChat(items, userText);
  },
};

/* ===================== ROUTE ===================== */

router.get("/news", async (req, res) => {
  try {
    const country = normalizeCountry(req.query.country);
    const city = normalizeCity(req.query.city);
    const q = clean(req.query.q) || null;
    const pageSize = clamp(req.query.pageSize || 10, 1, 20);

    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");

    const { mode, payload } = await getNewsCached({ country, city, q, pageSize });

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
module.exports.service = service;