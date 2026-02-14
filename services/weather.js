// weather.js (CommonJS router)
// GET /weather?lat=..&lon=..&units=metric

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const router = express.Router();

function sfSymbolFromOWIcon(icon) {
  // OpenWeather icon codes: 01d, 02n, etc.
  const code = String(icon || "").toLowerCase();

  if (code.startsWith("01")) return "sun.max.fill";
  if (code.startsWith("02")) return "cloud.sun.fill";
  if (code.startsWith("03")) return "cloud.fill";
  if (code.startsWith("04")) return "smoke.fill"; // broken clouds
  if (code.startsWith("09")) return "cloud.drizzle.fill";
  if (code.startsWith("10")) return "cloud.rain.fill";
  if (code.startsWith("11")) return "cloud.bolt.rain.fill";
  if (code.startsWith("13")) return "cloud.snow.fill";
  if (code.startsWith("50")) return "cloud.fog.fill";

  return "cloud.sun.fill";
}

function toIntTemp(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function pickClosestForecast(list, targetUnixSec) {
  if (!Array.isArray(list) || !list.length) return null;
  let best = list[0];
  let bestDiff = Math.abs(Number(best.dt) - targetUnixSec);

  for (const it of list) {
    const diff = Math.abs(Number(it.dt) - targetUnixSec);
    if (diff < bestDiff) {
      best = it;
      bestDiff = diff;
    }
  }
  return best;
}

router.get("/weather", async (req, res) => {
  try {
    const key = String(process.env.OPENWEATHER_API_KEY || "").trim();
    if (!key) return res.status(400).json({ error: "Missing OPENWEATHER_API_KEY on server" });

    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const units = String(req.query.units || "metric");

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Missing lat/lon (numbers)" });
    }

    // 1) Current weather
    const curUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=${encodeURIComponent(
      units
    )}&appid=${key}`;

    // 2) 5-day / 3-hour forecast (free tier)
    const fcUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=${encodeURIComponent(
      units
    )}&appid=${key}`;

    const [curResp, fcResp] = await Promise.all([fetch(curUrl), fetch(fcUrl)]);

    if (!curResp.ok) return res.status(curResp.status).json({ error: await curResp.text() });
    if (!fcResp.ok) return res.status(fcResp.status).json({ error: await fcResp.text() });

    const cur = await curResp.json();
    const fc = await fcResp.json();

    const now = Math.floor(Date.now() / 1000);
    const list = fc?.list || [];

    const t4 = now + 4 * 3600;
    const t8 = now + 8 * 3600;
    const t12 = now + 12 * 3600;

    const f4 = pickClosestForecast(list, t4);
    const f8 = pickClosestForecast(list, t8);
    const f12 = pickClosestForecast(list, t12);

    const curIcon = cur?.weather?.[0]?.icon || "";
    const curMain = cur?.weather?.[0]?.main || "";
    const curDesc = cur?.weather?.[0]?.description || "";

    const hourly = [
      {
        label: "Now",
        temp: toIntTemp(cur?.main?.temp),
        symbol: sfSymbolFromOWIcon(curIcon),
      },
      {
        label: "4h",
        temp: toIntTemp(f4?.main?.temp),
        symbol: sfSymbolFromOWIcon(f4?.weather?.[0]?.icon),
      },
      {
        label: "8h",
        temp: toIntTemp(f8?.main?.temp),
        symbol: sfSymbolFromOWIcon(f8?.weather?.[0]?.icon),
      },
      {
        label: "12h",
        temp: toIntTemp(f12?.main?.temp),
        symbol: sfSymbolFromOWIcon(f12?.weather?.[0]?.icon),
      },
    ];

    return res.json({
      ok: true,
      city: cur?.name || fc?.city?.name || "—",
      units,
      temp: toIntTemp(cur?.main?.temp),
      feels_like: toIntTemp(cur?.main?.feels_like),
      humidity: Number.isFinite(Number(cur?.main?.humidity)) ? Number(cur.main.humidity) : null,
      clouds: Number.isFinite(Number(cur?.clouds?.all)) ? Number(cur.clouds.all) : null,
      main: curMain,
      description: curDesc,
      hourly,
      raw: cur, // keep what you already had
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;