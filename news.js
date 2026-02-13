// news.js (CommonJS) — FREE RSS news aggregator with images
// Endpoint:
//   GET /news?country=ca&pageSize=10
//   GET /news?country=ca&city=Calgary&pageSize=10
//   GET /news?country=us&q=tech&pageSize=10
//
// No API keys required.

const express = require("express");
const Parser = require("rss-parser");

const router = express.Router();
const parser = new Parser({
  timeout: 12000,
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
  if (!s) return "ca"; // default to Canada for you
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

// Try to pull a usable image URL from RSS item fields
function extractImageUrl(item) {
  // rss-parser may give these:
  // item.enclosure.url
  // item.itunes.image
  // item.media:content / media:thumbnail might be inside item["media:content"] etc

  const enc = item?.enclosure?.url ? clean(item.enclosure.url) : null;
  if (enc && /^https?:\/\//i.test(enc)) return enc;

  const itunesImg =
    item?.itunes?.image ? clean(item.itunes.image) :
    item?.itunes?.image?.href ? clean(item.itunes.image.href) :
    null;
  if (itunesImg && /^https?:\/\//i.test(itunesImg)) return itunesImg;

  const mediaContent = item?.["media:content"] || item?.["media:thumbnail"] || null;
  // Sometimes it's an array, sometimes object
  if (Array.isArray(mediaContent)) {
    for (const m of mediaContent) {
      const u = clean(m?.$?.url || m?.url);
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  } else if (mediaContent) {
    const u = clean(mediaContent?.$?.url || mediaContent?.url);
    if (u && /^https?:\/\//i.test(u)) return u;
  }

  // Last resort: parse <img src="..."> from content/summary HTML
  const html = clean(item?.content || item?.contentSnippet || item?.summary || "");
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m && m[1] && /^https?:\/\//i.test(m[1])) return clean(m[1]);

  return null;
}

function stripHtml(s) {
  return clean(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
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
  // Simple relevance scoring (no AI, fast, free)
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

  // slight boost for “important-ish” topics
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

// -------------------- feeds --------------------

// Canada (mix so you don’t get empty)
const FEEDS_CA = [
  { name: "CBC", url: "https://www.cbc.ca/webfeed/rss/rss-topstories" },
  { name: "Global News", url: "https://globalnews.ca/feed/" },
  { name: "CTV News", url: "https://www.ctvnews.ca/rss/ctvnews-ca-top-stories-public-rss-1.822009" },
  { name: "CP24", url: "https://www.cp24.com/rss/cp24-top-stories-1.1129631" },
];

// US (reliable + lots of images)
const FEEDS_US = [
  { name: "AP News", url: "https://apnews.com/rss" },
  { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "CNN", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
];

// fallback “global”
const FEEDS_GLOBAL = [
  { name: "Reuters (Top)", url: "https://www.reutersagency.com/feed/?best-topics=top-news&post_type=best" },
];

// -------------------- route --------------------

/**
 * GET /news
 * Query:
 *  - country=ca|us (default ca)
 *  - city=Calgary (optional)
 *  - q=keyword (optional)
 *  - pageSize=1..20 (default 10)
 */
router.get("/news", async (req, res) => {
  try {
    const country = normalizeCountry(req.query.country);
    const city = clean(req.query.city) || null;
    const q = clean(req.query.q) || null;
    const pageSize = clamp(req.query.pageSize || 10, 1, 20);

    let feeds =
      country === "us" ? FEEDS_US :
      country === "ca" ? FEEDS_CA :
      FEEDS_GLOBAL;

    // If Canada + you want more coverage, quietly include one global feed
    if (country === "ca") feeds = [...feeds, ...FEEDS_GLOBAL];

    // fetch in parallel, don’t let 1 bad feed break everything
    const results = await Promise.allSettled(
      feeds.map(async (f) => {
        const feed = await parser.parseURL(f.url);
        const items = Array.isArray(feed?.items) ? feed.items : [];
        return { feedName: f.name, items };
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

        const description = stripHtml(it?.contentSnippet || it?.content || it?.summary || it?.description || "");
        const image_url = extractImageUrl(it);

        articles.push({
          title,
          description: description || null,
          url,
          image_url: image_url || null,
          source: feedName,
          published_at: isoDate(it?.isoDate || it?.pubDate || it?.date),
        });
      }
    }

    articles = dedupeByUrl(articles);

    // sort by published date first, then relevance if q/city provided
    articles.sort((a, b) => {
      const da = a.published_at ? new Date(a.published_at).getTime() : 0;
      const db = b.published_at ? new Date(b.published_at).getTime() : 0;
      return db - da;
    });

    if (q || city) {
      articles = articles
        .map((a) => ({ ...a, _score: scoreItem(a, q, city) }))
        .sort((a, b) => (b._score || 0) - (a._score || 0))
        .map(({ _score, ...rest }) => rest);
    }

    // final trim
    articles = articles.slice(0, pageSize);

    return res.json({
      ok: true,
      provider: "rss",
      region: { country, city: city || null },
      total: articles.length,
      articles,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "server error",
      detail: String(e?.message || e),
    });
  }
});

module.exports = router;