// news.js (CommonJS) — Production News route for LORAVO
// Uses NewsAPI.org + optional OpenWeather reverse geocode for country/city
//
// ENV needed:
//   NEWS_API_KEY=...
// Optional (for auto country/city from lat/lon):
//   OPENWEATHER_API_KEY=...
//
// Mount in index.js:
//   const newsRoute = require("./news");
//   app.use("/", newsRoute);

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const router = express.Router();

/* ===================== CONFIG ===================== */

const NEWS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const cache = new Map(); // key -> { at, data }

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanText(v) {
  return String(v || "").trim();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > NEWS_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
}

function normalizeCountryCode(c) {
  const s = cleanText(c).toLowerCase();
  if (!s) return null;
  if (s.length === 2) return s;
  // minimal mapping if someone passes "canada", "usa", etc.
  if (s === "canada") return "ca";
  if (s === "united states" || s === "usa" || s === "us") return "us";
  if (s === "uk" || s === "united kingdom" || s === "britain") return "gb";
  return null;
}

function mapArticle(a) {
  return {
    title: a?.title || "",
    description: a?.description || "",
    url: a?.url || "",
    image_url: a?.urlToImage || null,
    source: a?.source?.name || "",
    published_at: a?.publishedAt || null,
  };
}

/* ===================== OPTIONAL: reverse geocode via OpenWeather ===================== */

async function reverseGeocodeOpenWeather(lat, lon) {
  const key = cleanText(process.env.OPENWEATHER_API_KEY);
  if (!key) return null;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${key}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit) return null;

    return {
      city: hit.name || null,
      country: (hit.country || "").toLowerCase() || null, // "ca"
    };
  } catch {
    return null;
  }
}

/* ===================== NEWSAPI fetch ===================== */

async function fetchTopHeadlines({ country, q, category, pageSize }) {
  const key = cleanText(process.env.NEWS_API_KEY);
  if (!key) throw new Error("Missing NEWS_API_KEY on server");

  const params = new URLSearchParams();
  if (country) params.set("country", country);
  if (q) params.set("q", q);
  if (category) params.set("category", category);
  params.set("pageSize", String(pageSize));
  params.set("language", "en");

  const url = `https://newsapi.org/v2/top-headlines?${params.toString()}`;
  const r = await fetch(url, {
    headers: { "X-Api-Key": key },
  });

  const rawText = await r.text();
  let j = null;
  try {
    j = JSON.parse(rawText);
  } catch {
    // keep null
  }

  if (!r.ok) {
    const msg =
      (j && (j.message || j.error)) ||
      rawText ||
      `NewsAPI error (${r.status})`;
    throw new Error(msg);
  }

  return j;
}

async function fetchEverything({ q, pageSize, sortBy }) {
  const key = cleanText(process.env.NEWS_API_KEY);
  if (!key) throw new Error("Missing NEWS_API_KEY on server");

  const params = new URLSearchParams();
  params.set("q", q || "technology OR business OR markets");
  params.set("pageSize", String(pageSize));
  params.set("language", "en");
  params.set("sortBy", sortBy || "publishedAt");

  const url = `https://newsapi.org/v2/everything?${params.toString()}`;
  const r = await fetch(url, {
    headers: { "X-Api-Key": key },
  });

  const rawText = await r.text();
  let j = null;
  try {
    j = JSON.parse(rawText);
  } catch {
    // keep null
  }

  if (!r.ok) {
    const msg =
      (j && (j.message || j.error)) ||
      rawText ||
      `NewsAPI error (${r.status})`;
    throw new Error(msg);
  }

  return j;
}

/* ===================== ROUTES ===================== */

/**
 * GET /news
 *
 * Query:
 *  - lat=...&lon=...         (optional; helps derive country/city via OpenWeather)
 *  - country=ca              (optional; overrides)
 *  - q=...                   (optional search)
 *  - category=business|tech|... (optional)
 *  - limit=10                (optional)
 *
 * Returns:
 *  { ok, region:{country, city}, total, articles:[...], fetched_at, provider }
 */
router.get("/news", async (req, res) => {
  try {
    const lat = toNumber(req.query.lat);
    const lon = toNumber(req.query.lon);

    const limit = clamp(Number(req.query.limit || 10), 1, 30);
    const q = cleanText(req.query.q);
    const category = cleanText(req.query.category) || null;

    // Determine region (country/city)
    let country = normalizeCountryCode(req.query.country);
    let city = null;

    // If no explicit country but we have lat/lon, reverse geocode it
    if (!country && typeof lat === "number" && typeof lon === "number") {
      const geo = await reverseGeocodeOpenWeather(lat, lon);
      if (geo?.country) country = geo.country;
      if (geo?.city) city = geo.city;
    }

    // If still missing country, default to CA (since you’re in Canada most times)
    if (!country) country = "ca";

    const cacheKey = `news:${country}:${category || ""}:${q || ""}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    // Prefer top-headlines for “Apple News style” local feed
    const j = await fetchTopHeadlines({
      country,
      q: q || undefined,
      category: category || undefined,
      pageSize: limit,
    });

    const articles = Array.isArray(j?.articles) ? j.articles.map(mapArticle) : [];

    const out = {
      ok: true,
      provider: "newsapi",
      region: { country, city },
      total: articles.length,
      articles,
      fetched_at: new Date().toISOString(),
    };

    cacheSet(cacheKey, out);
    return res.json(out);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

/**
 * GET /news/everything
 * (Optional richer search when you want broader results than top-headlines)
 *
 * Query:
 *  - q=... (required-ish; fallback provided)
 *  - limit=10
 */
router.get("/news/everything", async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 10), 1, 30);
    const q = cleanText(req.query.q) || "technology OR business OR AI";

    const cacheKey = `everything:${q}:${limit}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const j = await fetchEverything({
      q,
      pageSize: limit,
      sortBy: "publishedAt",
    });

    const articles = Array.isArray(j?.articles) ? j.articles.map(mapArticle) : [];

    const out = {
      ok: true,
      provider: "newsapi",
      query: q,
      total: articles.length,
      articles,
      fetched_at: new Date().toISOString(),
    };

    cacheSet(cacheKey, out);
    return res.json(out);
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

module.exports = router;