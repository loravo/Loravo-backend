// news.js (CommonJS) — Production-ready News route with CA fallback + images
// Endpoint:
//   GET /news?country=ca&pageSize=10
//   GET /news?country=ca&q=calgary&pageSize=10
//   GET /news?q=canada&pageSize=10
//
// Env:
//   NEWSAPI_KEY=...

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const router = express.Router();

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
  if (!s) return null;
  // NewsAPI expects 2-letter ISO (us, ca, gb, etc.)
  if (s.length === 2) return s;
  // allow "canada" / "united states" → map common ones
  if (s === "canada") return "ca";
  if (s === "united states" || s === "usa" || s === "america") return "us";
  return s.slice(0, 2);
}

function mapArticles(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list
    .map((a) => ({
      title: clean(a?.title),
      description: clean(a?.description) || clean(a?.content) || null,
      url: clean(a?.url) || null,
      image_url: clean(a?.urlToImage) || null,
      source: clean(a?.source?.name) || "Unknown",
      published_at: a?.publishedAt || null,
    }))
    .filter((a) => a.title && a.url);
}

async function fetchJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j, raw: r };
}

function buildTopHeadlinesUrl({ key, country, q, pageSize }) {
  const params = new URLSearchParams();
  if (country) params.set("country", country);
  if (q) params.set("q", q);
  params.set("pageSize", String(pageSize));
  params.set("apiKey", key);
  return `https://newsapi.org/v2/top-headlines?${params.toString()}`;
}

function buildEverythingUrl({ key, q, pageSize, language = "en", sortBy = "publishedAt" }) {
  const params = new URLSearchParams();
  params.set("q", q || "canada");
  params.set("language", language);
  params.set("sortBy", sortBy);
  params.set("pageSize", String(pageSize));
  params.set("apiKey", key);
  return `https://newsapi.org/v2/everything?${params.toString()}`;
}

/**
 * GET /news
 * Query:
 *  - country=ca|us|...
 *  - city=Calgary (optional, used only to help q)
 *  - q=canada (optional)
 *  - pageSize=1..20
 */
router.get("/news", async (req, res) => {
  try {
    const key = clean(process.env.NEWSAPI_KEY);
    if (!key) {
      return res.status(400).json({ error: "Missing NEWSAPI_KEY on server" });
    }

    const country = normalizeCountry(req.query.country);
    const city = clean(req.query.city) || null;
    const qIn = clean(req.query.q) || null;
    const pageSize = clamp(req.query.pageSize || 10, 1, 20);

    // If user passes a city but no q, we lightly use it as a query hint
    const q = qIn || city || null;

    let provider = "newsapi";
    let region = { country: country || null, city: city || null };

    // 1) Primary: top-headlines
    let url = buildTopHeadlinesUrl({ key, country, q, pageSize });
    let { ok, status, json } = await fetchJson(url);

    // Sometimes top-headlines returns ok but empty; normalize output
    let total = Number(json?.totalResults || 0);
    let articles = mapArticles(json?.articles);

    // If request failed, surface the error cleanly
    if (!ok) {
      return res.status(502).json({
        ok: false,
        provider,
        error: `News provider error (${status})`,
        detail: json || null,
      });
    }

    // --- Canada fallback logic (CA often returns 0 on some accounts/regions) ---
    if (total === 0 && String(country || "").toLowerCase() === "ca") {
      // 2) Fallback A: US headlines filtered to Canada (reliable)
      const url2 = buildTopHeadlinesUrl({
        key,
        country: "us",
        q: q || "canada",
        pageSize,
      });
      const r2 = await fetchJson(url2);

      const total2 = Number(r2.json?.totalResults || 0);
      const articles2 = mapArticles(r2.json?.articles);

      if (r2.ok && total2 > 0 && articles2.length > 0) {
        provider = "newsapi_fallback_us_q_canada";
        total = total2;
        articles = articles2;
        region = { country: "ca", city: city || null };
      } else {
        // 3) Fallback B: everything endpoint (more coverage)
        const url3 = buildEverythingUrl({
          key,
          q: q || "canada",
          pageSize,
          language: "en",
          sortBy: "publishedAt",
        });
        const r3 = await fetchJson(url3);

        const total3 = Number(r3.json?.totalResults || 0);
        const articles3 = mapArticles(r3.json?.articles);

        if (r3.ok && total3 > 0 && articles3.length > 0) {
          provider = "newsapi_fallback_everything";
          total = total3;
          articles = articles3;
          region = { country: "ca", city: city || null };
        }
      }
    }

    // If still empty and user provided q, try everything as a universal fallback
    if (articles.length === 0 && q) {
      const url4 = buildEverythingUrl({
        key,
        q,
        pageSize,
        language: "en",
        sortBy: "publishedAt",
      });
      const r4 = await fetchJson(url4);

      const total4 = Number(r4.json?.totalResults || 0);
      const articles4 = mapArticles(r4.json?.articles);

      if (r4.ok && total4 > 0 && articles4.length > 0) {
        provider = provider + "_plus_everything";
        total = total4;
        articles = articles4;
      }
    }

    return res.json({
      ok: true,
      provider,
      region,
      total: articles.length, // return actual list count (more useful than huge totals)
      articles,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server error", detail: String(e?.message || e) });
  }
});

module.exports = router;