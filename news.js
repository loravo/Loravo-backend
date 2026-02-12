// news.js (CommonJS) — Loravo News Route
const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const router = express.Router();

/**
 * ENV you need (Render + optional local .env):
 *   NEWS_API_KEY=xxxx
 *
 * Provider: NewsAPI.org (top-headlines)
 * Returns: { ok, region, items: [ {title, source, url, image_url, published_at} ] }
 */

function pickImageUrl(article) {
  const u = article?.urlToImage;
  if (!u || typeof u !== "string") return null;
  if (!u.startsWith("http")) return null;
  return u;
}

async function fetchNewsAPI({ country = "ca", q = "", pageSize = 8 }) {
  const key = String(process.env.NEWS_API_KEY || "").trim();
  if (!key) throw new Error("Missing NEWS_API_KEY on server");

  const params = new URLSearchParams();
  params.set("apiKey", key);
  params.set("pageSize", String(pageSize));
  params.set("country", country);
  if (q) params.set("q", q);

  const url = `https://newsapi.org/v2/top-headlines?${params.toString()}`;
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  return JSON.parse(text);
}

/**
 * GET /news?country=ca&q=calgary
 * - country optional (default ca)
 * - q optional (city/topic)
 */
router.get("/news", async (req, res) => {
  try {
    const country = String(req.query.country || "ca").toLowerCase().trim();
    const q = String(req.query.q || "").trim();

    const raw = await fetchNewsAPI({ country, q, pageSize: 10 });
    const articles = Array.isArray(raw?.articles) ? raw.articles : [];

    const items = articles.slice(0, 8).map((a) => ({
      title: String(a?.title || "").trim(),
      source: String(a?.source?.name || "Source").trim(),
      url: String(a?.url || "").trim(),
      image_url: pickImageUrl(a),
      published_at: a?.publishedAt || null,
    })).filter(x => x.title && x.url);

    res.json({
      ok: true,
      region: q || null,
      items,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

module.exports = router;