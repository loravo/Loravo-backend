// news.js (CommonJS) — production-ready News route for Loravo
const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const router = express.Router();

function normalizeCountry(c) {
  const s = String(c || "").trim().toLowerCase();
  return s.length === 2 ? s : "";
}

function pickRegionFromQuery(q) {
  return {
    country: normalizeCountry(q.country || q.cc || "us"),
    city: q.city ? String(q.city).trim() : null,
  };
}

router.get("/news", async (req, res) => {
  try {
    const key = String(process.env.NEWSAPI_KEY || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "Missing NEWSAPI_KEY on server" });
    }

    const region = pickRegionFromQuery(req.query);

    const pageSize = Math.max(1, Math.min(Number(req.query.pageSize || 20), 50));
    const category = req.query.category ? String(req.query.category).trim().toLowerCase() : "general";
    const q = req.query.q ? String(req.query.q).trim() : "";

    async function callNewsApi(url) {
      const r = await fetch(url);
      const rawText = await r.text();
      let j = null;
      try { j = JSON.parse(rawText); } catch {}
      return { ok: r.ok, status: r.status, json: j, rawText };
    }

    function cleanArticles(j) {
      const articles = Array.isArray(j?.articles) ? j.articles : [];
      return articles
        .filter(a => a?.title && a?.url)
        .map(a => ({
          title: a.title,
          description: a.description || "",
          source: a.source?.name || "",
          url: a.url,
          image_url: a.urlToImage || null,
          published_at: a.publishedAt || null,
        }));
    }

    // 1) Default: top-headlines by country
    const u1 = new URL("https://newsapi.org/v2/top-headlines");
    u1.searchParams.set("apiKey", key);
    u1.searchParams.set("country", region.country || "us");
    u1.searchParams.set("pageSize", String(pageSize));
    u1.searchParams.set("category", category);
    u1.searchParams.set("language", "en");
    if (q) u1.searchParams.set("q", q);

    let r1 = await callNewsApi(u1.toString());
    if (!r1.ok) {
      return res.status(r1.status).json({
        ok: false,
        provider: "newsapi",
        region,
        error: r1.json?.message || r1.rawText || `News API error ${r1.status}`,
      });
    }

    let total = Number(r1.json?.totalResults || 0);
    let articles = cleanArticles(r1.json);

    // 2) Fallback for Canada (some keys/plans return 0 for country=ca)
    if ((region.country === "ca") && total === 0) {
      const caSources = [
        "cbc-news",
        "the-globe-and-mail",
        "financial-post",
      ].join(",");

      const u2 = new URL("https://newsapi.org/v2/top-headlines");
      u2.searchParams.set("apiKey", key);
      u2.searchParams.set("sources", caSources);
      u2.searchParams.set("pageSize", String(pageSize));
      u2.searchParams.set("language", "en");
      if (q) u2.searchParams.set("q", q);

      const r2 = await callNewsApi(u2.toString());
      if (r2.ok) {
        const t2 = Number(r2.json?.totalResults || 0);
        const a2 = cleanArticles(r2.json);
        if (t2 > 0 && a2.length) {
          total = t2;
          articles = a2;
        }
      }
    }

    // 3) Final fallback: Everything search (always returns something)
    if ((region.country === "ca") && total === 0) {
      const u3 = new URL("https://newsapi.org/v2/everything");
      u3.searchParams.set("apiKey", key);
      u3.searchParams.set("pageSize", String(pageSize));
      u3.searchParams.set("language", "en");
      u3.searchParams.set("sortBy", "publishedAt");

      const fallbackQuery =
        q ||
        'canada OR toronto OR vancouver OR calgary OR ottawa OR montreal OR alberta';
      u3.searchParams.set("q", fallbackQuery);

      const r3 = await callNewsApi(u3.toString());
      if (r3.ok) {
        const t3 = Number(r3.json?.totalResults || 0);
        const a3 = cleanArticles(r3.json);
        if (t3 > 0 && a3.length) {
          total = t3;
          articles = a3;
        }
      }
    }

    return res.json({
      ok: true,
      provider: "newsapi",
      region,
      total,
      articles,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});