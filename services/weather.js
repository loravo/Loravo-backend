// services/weather.js (CommonJS)
// - Router: GET /weather?lat=..&lon=..&units=metric
// - Service: services.weather.getLive({ userId, text, lat, lon, state }) -> normalized object for LXT
//
// FIXES:
// ✅ If user asks "weather in Edmonton", we geocode Edmonton and use that (even if device lat/lon is sent)
// ✅ Still supports coordinates and plain device-location weather
// ✅ Accepts lat/lon as strings or numbers

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const router = express.Router();

function toNum(x) {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

function sfSymbolFromOWIcon(icon) {
  const code = String(icon || "").toLowerCase();
  if (code.startsWith("01")) return "sun.max.fill";
  if (code.startsWith("02")) return "cloud.sun.fill";
  if (code.startsWith("03")) return "cloud.fill";
  if (code.startsWith("04")) return "smoke.fill";
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

// ---- City / coordinates parsing ----

function extractCoordinatesFromText(t) {
  const s = String(t || "");
  const m = s.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// "weather in Edmonton" / "Edmonton weather"
function extractCityFromWeatherText(t) {
  const s = String(t || "").trim();

  const m1 =
    s.match(/\b(weather|forecast|temperature|temp)\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
    s.match(/\b(weather|forecast|temperature|temp)\s+([a-zA-Z\s.'-]{2,})$/i);

  if (m1) {
    const city = String(m1[m1.length - 1] || "").trim().replace(/\?+$/g, "").trim();
    return city.length >= 2 ? city : null;
  }

  const m2 = s.match(/^([a-zA-Z\s.'-]{2,})\s+(weather|forecast|temperature|temp)\b/i);
  if (m2) {
    const city = String(m2[1] || "").trim().replace(/\?+$/g, "").trim();
    return city.length >= 2 ? city : null;
  }

  return null;
}

async function geocodeCity_OpenWeather(city) {
  const key = String(process.env.OPENWEATHER_API_KEY || "").trim();
  if (!key) throw new Error("Missing OPENWEATHER_API_KEY on server");
  const q = String(city || "").trim();
  if (!q) return null;

  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(q)}&limit=1&appid=${key}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const hit = Array.isArray(j) ? j[0] : null;
  if (!hit || typeof hit.lat !== "number" || typeof hit.lon !== "number") return null;

  return { lat: hit.lat, lon: hit.lon, name: hit.name || q, country: hit.country || null, state: hit.state || null };
}

async function fetchOpenWeatherBundle({ lat, lon, units = "metric" }) {
  const key = String(process.env.OPENWEATHER_API_KEY || "").trim();
  if (!key) throw new Error("Missing OPENWEATHER_API_KEY on server");

  const la = toNum(lat);
  const lo = toNum(lon);
  if (la == null || lo == null) {
    throw new Error("Missing lat/lon (numbers)");
  }

  const curUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${la}&lon=${lo}&units=${encodeURIComponent(
    units
  )}&appid=${key}`;

  const fcUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${la}&lon=${lo}&units=${encodeURIComponent(
    units
  )}&appid=${key}`;

  const [curResp, fcResp] = await Promise.all([fetch(curUrl), fetch(fcUrl)]);

  if (!curResp.ok) throw new Error(await curResp.text());
  if (!fcResp.ok) throw new Error(await fcResp.text());

  const cur = await curResp.json();
  const fc = await fcResp.json();

  const now = Math.floor(Date.now() / 1000);
  const list = fc?.list || [];

  const f4 = pickClosestForecast(list, now + 4 * 3600);
  const f8 = pickClosestForecast(list, now + 8 * 3600);
  const f12 = pickClosestForecast(list, now + 12 * 3600);

  const curIcon = cur?.weather?.[0]?.icon || "";
  const curMain = cur?.weather?.[0]?.main || "";
  const curDesc = cur?.weather?.[0]?.description || "";

  const hourly = [
    { label: "Now", temp: toIntTemp(cur?.main?.temp), symbol: sfSymbolFromOWIcon(curIcon) },
    { label: "4h", temp: toIntTemp(f4?.main?.temp), symbol: sfSymbolFromOWIcon(f4?.weather?.[0]?.icon) },
    { label: "8h", temp: toIntTemp(f8?.main?.temp), symbol: sfSymbolFromOWIcon(f8?.weather?.[0]?.icon) },
    { label: "12h", temp: toIntTemp(f12?.main?.temp), symbol: sfSymbolFromOWIcon(f12?.weather?.[0]?.icon) },
  ];

  return {
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
    raw: cur,
    _fc: fc,
    at: new Date().toISOString(),
  };
}

/** ✅ Router stays the same behavior */
router.get("/weather", async (req, res) => {
  try {
    const lat = req.query.lat;
    const lon = req.query.lon;
    const units = String(req.query.units || "metric");

    const bundle = await fetchOpenWeatherBundle({ lat, lon, units });

    return res.json({
      ok: true,
      city: bundle.city,
      units: bundle.units,
      temp: bundle.temp,
      feels_like: bundle.feels_like,
      humidity: bundle.humidity,
      clouds: bundle.clouds,
      main: bundle.main,
      description: bundle.description,
      hourly: bundle.hourly,
      raw: bundle.raw,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/** ✅ Service that LXT can call internally */
const service = {
  // LXT calls: services.weather.getLive({ userId, text, lat, lon, state })
  getLive: async ({ text, lat, lon }) => {
    // 1) If coordinates are literally in the text, use them (most explicit)
    const textCoords = extractCoordinatesFromText(text);

    // 2) If user asked "weather in CITY", override device coords with city geocode
    const city = extractCityFromWeatherText(text);
    const cityGeo = city ? await geocodeCity_OpenWeather(city) : null;

    const finalLat = textCoords?.lat ?? cityGeo?.lat ?? toNum(lat);
    const finalLon = textCoords?.lon ?? cityGeo?.lon ?? toNum(lon);

    if (finalLat == null || finalLon == null) {
      // Don’t hallucinate weather. Tell LXT it needs a location.
      return null;
    }

    const bundle = await fetchOpenWeatherBundle({ lat: finalLat, lon: finalLon, units: "metric" });

    // If we geocoded a city, prefer that name (feels consistent)
    const placeName = cityGeo?.name || bundle.city;

    return {
      city: placeName,
      temp_c: bundle.temp,
      feels_like_c: bundle.feels_like,
      humidity_pct: bundle.humidity,
      clouds_pct: bundle.clouds,
      main: bundle.main,
      description: bundle.description,
      hourly: bundle.hourly,
      at: bundle.at,
    };
  },
};

module.exports = { router, service };