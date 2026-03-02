// services/weather.js (CommonJS)
// - Router: GET /weather?lat=..&lon=..&units=metric
// - Service: services.weather.getLive({ userId, text, lat, lon, state }) -> normalized object for LXT

const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const router = express.Router();

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

async function fetchOpenWeatherBundle({ lat, lon, units = "metric" }) {
  const key = String(process.env.OPENWEATHER_API_KEY || "").trim();
  if (!key) throw new Error("Missing OPENWEATHER_API_KEY on server");

  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    throw new Error("Missing lat/lon (numbers)");
  }

  const curUrl = `https://api.openweathermap.org/data/2.5/weather?lat=${Number(lat)}&lon=${Number(
    lon
  )}&units=${encodeURIComponent(units)}&appid=${key}`;

  const fcUrl = `https://api.openweathermap.org/data/2.5/forecast?lat=${Number(lat)}&lon=${Number(
    lon
  )}&units=${encodeURIComponent(units)}&appid=${key}`;

  const [curResp, fcResp] = await Promise.all([fetch(curUrl), fetch(fcUrl)]);

  if (!curResp.ok) throw new Error(await curResp.text());
  if (!fcResp.ok) throw new Error(await fcResp.text());

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
    _fc: fc, // keep forecast if you want it
    at: new Date().toISOString(),
  };
}

/** ✅ Router stays the same behavior */
router.get("/weather", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const units = String(req.query.units || "metric");

    const bundle = await fetchOpenWeatherBundle({ lat, lon, units });

    // Keep your exact output shape for the app:
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

/** ✅ NEW: Service that LXT can call internally */
const service = {
  // LXT calls: services.weather.getLive({ userId, text, lat, lon, state })
  getLive: async ({ lat, lon }) => {
    // LXT already passes lat/lon from request or user_state.
    // Keep it tight + normalized for LXT context.
    const bundle = await fetchOpenWeatherBundle({ lat, lon, units: "metric" });

    // Return the normalized object LXT expects (simple, stable keys):
    return {
      city: bundle.city,
      temp_c: bundle.temp,
      feels_like_c: bundle.feels_like,
      humidity_pct: bundle.humidity,
      clouds_pct: bundle.clouds,
      main: bundle.main,
      description: bundle.description,
      hourly: bundle.hourly, // optional but powerful for reasoning
      at: bundle.at,
    };
  },
};

module.exports = { router, service };