// weather.js (CommonJS router)
// Usage in index.js:
//   const weatherRouter = require("./weather");
//   app.use(weatherRouter);

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2

const router = express.Router();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

router.get("/weather", async (req, res) => {
  try {
    const lat = num(req.query.lat);
    const lon = num(req.query.lon);
    const units = String(req.query.units || "metric").toLowerCase() === "imperial" ? "imperial" : "metric";

    if (lat == null || lon == null) {
      return res.status(400).json({ error: "Missing lat/lon (numbers)" });
    }

    const key = process.env.OPENWEATHER_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "Missing OPENWEATHER_API_KEY on server" });
    }

    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=${units}&appid=${key}`;
    const r = await fetch(url);
    const j = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ error: "OpenWeather error", detail: j });
    }

    const temp = j?.main?.temp;
    const feels_like = j?.main?.feels_like;
    const humidity = j?.main?.humidity;
    const clouds = j?.clouds?.all;
    const main = j?.weather?.[0]?.main;
    const description = j?.weather?.[0]?.description;
    const city = j?.name;

    res.json({
      ok: true,
      city: city || null,
      units,
      temp: typeof temp === "number" ? Math.round(temp) : null,
      feels_like: typeof feels_like === "number" ? Math.round(feels_like) : null,
      humidity: typeof humidity === "number" ? humidity : null,
      clouds: typeof clouds === "number" ? clouds : null,
      main: main || null,
      description: description || null,
      raw: j,
    });
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e?.message || e) });
  }
});

module.exports = router;