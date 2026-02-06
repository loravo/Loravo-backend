/*************************************************
 * LORAVO – LXT-1 Backend (Trinity + Professional Reply + Stay-Ahead Alerts + Push + Quiet Hours)
 * Stack:
 *  - Node + Express
 *  - OpenAI (Responses API; strict JSON schema when supported)
 *  - Gemini (OpenAI-compat; JSON fallback + reply)
 *  - PostgreSQL (optional; user memory + state + alert queue + device tokens + prefs)
 *  - OpenWeather (weather signals)
 *
 * Endpoints:
 *  - GET  /                -> basic root
 *  - GET  /health
 *  - POST /lxt1            -> strict LXT1 JSON only
 *  - POST /chat            -> { reply (professional), lxt1 (json), providers meta }
 *
 * Stay-Ahead Engine:
 *  - POST /state/location  -> update user location, detect meaningful changes, queue alerts
 *  - POST /state/weather   -> force weather check, detect meaningful changes, queue alerts
 *  - GET  /poll            -> app polls for queued alerts (Loravo “sends a message”)
 *  - POST /trip/set        -> store active trip context (simple)
 *  - POST /news/ingest     -> ingest your own “news event” and queue if meaningful
 *
 * Push (v1):
 *  - POST /push/register   -> store iOS APNs device token (sandbox/production)
 *  - POST /push/send-test  -> send a test push to the stored token(s)
 *
 * Prefs:
 *  - POST /prefs/quiet-hours
 *  - GET  /prefs
 *
 * Query params:
 *  - provider=openai | gemini | trinity   (default: trinity)
 *  - mode=instant | auto | thinking       (default: auto)
 *************************************************/

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch"); // node-fetch@2
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*" }));

/* ===================== CONFIG ===================== */

const TOKEN_LIMITS = { instant: 400, auto: 1000, thinking: 1800 };

function getMode(req) {
  const m = String(req.query.mode || "auto").toLowerCase();
  return ["instant", "auto", "thinking"].includes(m) ? m : "auto";
}

function getProvider(req) {
  const p = String(req.query.provider || "trinity").toLowerCase();
  return ["openai", "gemini", "trinity"].includes(p) ? p : "trinity";
}
function pickAutoMode(text) {
  if (!text) return "instant";

  const t = text.toLowerCase().trim();

  // Fast / casual
  if (
    t.length < 40 ||
    /^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)
  ) {
    return "instant";
  }

  // Simple questions
  if (
    /^(what|when|where|who|is|are|do|does|can|should)\b/.test(t) &&
    t.length < 120
  ) {
    return "instant";
  }

  // Thinking required
  if (
    /(analyze|plan|compare|strategy|explain|forecast|should i|pros and cons)/.test(t) ||
    t.length > 180
  ) {
    return "thinking";
  }

  // Default
  return "instant";
}
/* ===================== DB (OPTIONAL) ===================== */
/**
 * Local Postgres often has NO SSL -> do NOT force SSL locally.
 * Render Postgres requires SSL -> do SSL in production / non-local URLs.
 */

function isLocalDbUrl(url) {
  if (!url) return true;
  const u = String(url);
  return (
    u.includes("localhost") ||
    u.includes("127.0.0.1") ||
    u.includes("::1") ||
    u.startsWith("postgres://localhost") ||
    u.startsWith("postgresql://localhost")
  );
}

const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_ENABLED = Boolean(DATABASE_URL);

const pool = DB_ENABLED
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocalDbUrl(DATABASE_URL) ? false : { rejectUnauthorized: false },
    })
  : null;

let dbReady = false;

async function initDb() {
  if (!pool) {
    console.log("ℹ️ No DATABASE_URL set — DB disabled (server still runs).");
    dbReady = false;
    return;
  }

  // user_memory
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_memory (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // user_state (last known location/weather + last alert hash to avoid repeats)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY,
      last_lat DOUBLE PRECISION,
      last_lon DOUBLE PRECISION,
      last_city TEXT,
      last_country TEXT,
      last_timezone TEXT,
      last_temp_c DOUBLE PRECISION,
      last_cloud_pct INTEGER,
      last_weather_main TEXT,
      last_weather_desc TEXT,
      last_weather_at TIMESTAMPTZ,
      last_alert_hash TEXT,
      last_alert_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // queued alerts (Loravo messages)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_queue (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,            -- weather | location | trip | news | system
      message TEXT NOT NULL,               -- what your app shows
      payload JSONB,                       -- optional extra structured info
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );
  `);

  // basic trip context
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_trip (
      user_id TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      destination TEXT,
      depart_at TIMESTAMPTZ,
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // news events (ingested)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS news_events (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      region TEXT,
      severity TEXT NOT NULL DEFAULT 'low', -- low|medium|high|critical
      action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  /**
   * push_devices
   * NOTE: YOUR DB already has UNIQUE (user_id, environment).
   * So we model that here (id PK, and unique user_id+environment).
   * This avoids conflicts with your existing table.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_token TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production', -- sandbox | production
      platform TEXT NOT NULL DEFAULT 'ios',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS push_devices_user_env_unique
    ON push_devices (user_id, environment);
  `);

  // user prefs (quiet hours, etc.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY,
      quiet_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      quiet_start TEXT,     -- "23:00"
      quiet_end TEXT,       -- "07:00"
      timezone TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  dbReady = true;
  console.log("✅ DB tables ensured");
}

/* ===================== HEALTH + ROOT ===================== */

app.get("/", (_, res) => {
  res.json({
    service: "Loravo LXT-1 backend",
    status: "running",
    endpoints: [
      "/health",
      "/chat",
      "/lxt1",
      "/state/location",
      "/state/weather",
      "/poll",
      "/trip/set",
      "/news/ingest",
      "/push/register",
      "/push/send-test",
      "/prefs/quiet-hours",
      "/prefs",
    ],
  });
});

app.get("/health", (_, res) => res.json({ ok: true, db: dbReady }));

/* ===================== LXT-1 JSON SCHEMA ===================== */

const LXT1_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence", "one_liner", "signals", "actions", "watchouts", "next_check"],
  properties: {
    verdict: { type: "string", enum: ["HOLD", "PREPARE", "MOVE", "AVOID"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    one_liner: { type: "string" },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "direction", "weight", "why"],
        properties: {
          name: { type: "string" },
          direction: { type: "string", enum: ["up", "down", "neutral"] },
          weight: { type: "number" },
          why: { type: "string" },
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["now", "time", "effort"],
        properties: {
          now: { type: "string" },
          time: { type: "string", enum: ["today", "this_week", "this_month"] },
          effort: { type: "string", enum: ["low", "med", "high"] },
        },
      },
    },
    watchouts: { type: "array", items: { type: "string" } },
    next_check: { type: "string" },
  },
};

const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "lxt1"],
  properties: {
    reply: { type: "string" },
    lxt1: LXT1_SCHEMA,
  },
};
/* ===================== HELPERS ===================== */

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeNowPlus(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function safeFallbackResult(reason = "Temporary disruption—retry shortly.") {
  return {
    verdict: "PREPARE",
    confidence: 0.5,
    one_liner: reason,
    signals: [],
    actions: [{ now: "Retry in 30–60 seconds", time: "today", effort: "low" }],
    watchouts: ["Provider quota / temporary outage"],
    next_check: safeNowPlus(60 * 60 * 1000),
  };
}

// FIX: force next_check to be future (model often returns old dates)
function sanitizeToSchema(o) {
  const conf = typeof o?.confidence === "number" ? o.confidence : 0.5;
  return {
    verdict: o?.verdict || "PREPARE",
    confidence: clamp(Math.round(conf * 100) / 100, 0, 1),
    one_liner: String(o?.one_liner || "OK"),
    signals: Array.isArray(o?.signals) ? o.signals : [],
    actions: Array.isArray(o?.actions)
      ? o.actions
      : [{ now: "Retry later", time: "today", effort: "low" }],
    watchouts: Array.isArray(o?.watchouts) ? o.watchouts : [],
    next_check: safeNowPlus(6 * 60 * 60 * 1000), // 6 hours from now
  };
}

function extractOpenAIParsedObject(data) {
  if (data?.output_parsed) return data.output_parsed;

  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.json) return part.json;
    }
  }
  return null;
}

function extractFirstJSONObject(text) {
  if (!text || typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeTimeHHMM(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = String(clamp(parseInt(m[1], 10), 0, 23)).padStart(2, "0");
  const mm = String(clamp(parseInt(m[2], 10), 0, 59)).padStart(2, "0");
  return `${hh}:${mm}`;
}

function minutesFromHHMM(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function cleanText(s) {
  return String(s || "").trim();
}

function isGreeting(text) {
  const t = cleanText(text).toLowerCase();
  return /^(hi|hello|hey|yo|sup|what'?s up|good (morning|afternoon|evening))[\s!.?]*$/.test(t);
}

function greetingReply() {
  const options = [
    "Hey — what can I help you with right now?",
    "Hi. What are we working on today?",
    "Hey! Tell me what you want to do, and I’ll handle it.",
  ];
  return options[Math.floor(Math.random() * options.length)];
}
// ===================== INTENT CLASSIFIER =====================
function classifyIntent(text) {
  const t = String(text || "").toLowerCase().trim();

  if (/^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)) return "greeting";

  if (/(news|headlines|what happened|what’s going on|whats going on|breaking|update me|anything i should know)/.test(t))
    return "news";

  if (/(weather|temperature|rain|snow|wind|forecast)/.test(t))
    return "weather";

  return "chat";
}
/* ===================== WEATHER ===================== */

async function getWeather(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number" || !process.env.OPENWEATHER_API_KEY) return null;

  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${process.env.OPENWEATHER_API_KEY}`;
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function weatherToSignals(w) {
  if (!w) return [];

  const signals = [];
  const cloud = w.clouds?.all ?? 0;
  const temp = w.main?.temp;

  if (cloud >= 90) {
    signals.push({
      name: "Heavy cloud cover",
      direction: "down",
      weight: 0.15,
      why: "Overcast conditions can correlate with travel delays.",
    });
  }

  if (typeof temp === "number" && temp <= 3.5) {
    signals.push({
      name: "Low temperature",
      direction: "down",
      weight: 0.2,
      why: `It's cold (${temp.toFixed(1)}°C) — plan layers.`,
    });
  }

  return signals;
}
/* ===================== LIVE CONTEXT HELPERS ===================== */

function isWeatherText(t) {
  const s = String(t || "").toLowerCase();
  return (
    s.includes("weather") ||
    s.includes("forecast") ||
    s.includes("temperature")
  );
}

function extractCityFromWeatherText(t) {
  const s = String(t || "").trim();
  const m =
    s.match(/\bweather\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
    s.match(/\bforecast\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
    s.match(/\btemperature\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i);

  if (!m) return null;
  const city = String(m[2] || "").trim();
  return city.length >= 2 ? city : null;
}

async function geocodeCity(city) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key || !city) return null;

  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(
    city
  )}&limit=1&appid=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || typeof hit.lat !== "number" || typeof hit.lon !== "number") {
      return null;
    }
    return {
      lat: hit.lat,
      lon: hit.lon,
      city: hit.name || city,
      country: hit.country || null,
    };
  } catch {
    return null;
  }
}

function normalizeWeatherForLLM(w) {
  if (!w) return null;
  return {
    city: w.name || null,
    temp_c: typeof w.main?.temp === "number" ? w.main.temp : null,
    feels_like_c:
      typeof w.main?.feels_like === "number" ? w.main.feels_like : null,
    humidity_pct:
      typeof w.main?.humidity === "number" ? w.main.humidity : null,
    clouds_pct:
      typeof w.clouds?.all === "number" ? w.clouds.all : null,
    wind_mps:
      typeof w.wind?.speed === "number" ? w.wind.speed : null,
    main: w.weather?.[0]?.main || null,
    description: w.weather?.[0]?.description || null,
    at: new Date().toISOString(),
  };
}

async function buildLiveContext({ userId, text, lat, lon }) {
  // WEATHER
  let weatherRaw = null;

  if (typeof lat === "number" && typeof lon === "number") {
    weatherRaw = await getWeather(lat, lon);
  } else if (isWeatherText(text)) {
    const city = extractCityFromWeatherText(text);
    if (city) {
      const geo = await geocodeCity(city);
      if (geo) {
        weatherRaw = await getWeather(geo.lat, geo.lon);
      }
    }
  }

  // NEWS (last few items you ingested)
  const news =
    typeof getRecentNewsForUser === "function" && userId
      ? await getRecentNewsForUser(userId, 5)
      : [];

  return {
    weather: normalizeWeatherForLLM(weatherRaw),
    news: Array.isArray(news) ? news : [],
  };
}

/* ===================== DB SAFE WRAPPERS ===================== */

async function dbQuery(sql, params) {
  if (!pool || !dbReady) return { rows: [] };
  return pool.query(sql, params);
}

/* ===================== USER MEMORY ===================== */

async function loadUserMemory(userId) {
  if (!userId) return "";
  const { rows } = await dbQuery(
    `SELECT content FROM user_memory WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return rows.map((r) => r.content).join("\n");
}

async function saveUserMemory(userId, text) {
  if (userId && text) {
    await dbQuery(`INSERT INTO user_memory (user_id, content) VALUES ($1,$2)`, [userId, text]);
  }
}

/* ===================== USER STATE ===================== */

async function loadUserState(userId) {
  if (!userId) return null;
  const { rows } = await dbQuery(`SELECT * FROM user_state WHERE user_id=$1 LIMIT 1`, [userId]);
  return rows[0] || null;
}

async function upsertUserState(userId, patch) {
  if (!userId || !patch || !Object.keys(patch).length) return;

  const fields = Object.keys(patch);
  const cols = ["user_id", ...fields];
  const vals = [userId, ...fields.map((k) => patch[k])];
  const params = cols.map((_, i) => `$${i + 1}`);

  const updates = fields.map((k) => `${k}=EXCLUDED.${k}`).concat(["updated_at=NOW()"]).join(", ");

  // FIXED: user_state has PK (user_id) only (no environment column)
  await dbQuery(
    `
    INSERT INTO user_state (${cols.join(", ")})
    VALUES (${params.join(", ")})
    ON CONFLICT (user_id) DO UPDATE SET ${updates}
  `,
    vals
  );
}

/* ===================== PREFS ===================== */

async function loadUserPrefs(userId) {
  if (!userId || !dbReady) return null;
  const { rows } = await dbQuery(`SELECT * FROM user_prefs WHERE user_id=$1 LIMIT 1`, [userId]);
  return rows[0] || null;
}

function isNowInQuietHours(prefs) {
  if (!prefs?.quiet_enabled) return false;

  const start = normalizeTimeHHMM(prefs.quiet_start);
  const end = normalizeTimeHHMM(prefs.quiet_end);
  if (!start || !end) return false;

  const startMin = minutesFromHHMM(start);
  const endMin = minutesFromHHMM(end);
  if (startMin == null || endMin == null) return false;

  // ✅ Use user's timezone if available; fallback to server time
  const tz = prefs.timezone || null;

  let nowMin;
  if (tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());

    const hh = Number(parts.find(p => p.type === "hour")?.value ?? "0");
    const mm = Number(parts.find(p => p.type === "minute")?.value ?? "0");
    nowMin = hh * 60 + mm;
  } else {
    const now = new Date();
    nowMin = now.getHours() * 60 + now.getMinutes();
  }

  if (startMin > endMin) return nowMin >= startMin || nowMin < endMin;
  return nowMin >= startMin && nowMin < endMin;
}

/* ===================== ALERT QUEUE ===================== */

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

async function enqueueAlert({ userId, alertType, message, payload }) {
  if (!userId || !message) return;
  if (!dbReady) return;

  const prefs = await loadUserPrefs(userId);
  const quiet = isNowInQuietHours(prefs);

  // Loravo restraint: drop non-urgent alerts entirely during quiet hours
const NON_URGENT = ["weather", "location", "news"];
if (quiet && NON_URGENT.includes(alertType)) return;

  const state = await loadUserState(userId);
  const now = Date.now();
  const lastAt = state?.last_alert_at ? new Date(state.last_alert_at).getTime() : 0;

  const hash = sha1(`${alertType}|${message}`);
  const sameAsLast = state?.last_alert_hash && state.last_alert_hash === hash;
  const inCooldown = lastAt && now - lastAt < ALERT_COOLDOWN_MS;

  if (sameAsLast && inCooldown) return;

  const mergedPayload = {
    ...(payload || {}),
    quiet_hours_active: Boolean(quiet),
  };

  await dbQuery(
    `INSERT INTO alert_queue (user_id, alert_type, message, payload) VALUES ($1,$2,$3,$4)`,
    [userId, alertType, message, JSON.stringify(mergedPayload)]
  );

  await upsertUserState(userId, {
    last_alert_hash: hash,
    last_alert_at: new Date().toISOString(),
  });

  // Auto-send push (best effort) — still keeps queue for app polling/history
  try {
    await maybeSendPushForAlert({
      userId,
      alertType,
      message,
      payload: mergedPayload,
    });
  } catch (e) {
    console.error("⚠️ auto-push failed:", e?.message || e);
  }
}

/* ===================== ALERT COMPOSERS ===================== */

function formatC(n) {
  if (typeof n !== "number") return null;
  return `${Math.round(n)}°C`;
}

function composeWeatherAlert({ prevTemp, nowTemp, prevCloud, nowCloud, city }) {
  const place = city ? ` in ${city}` : "";

  if (typeof prevTemp === "number" && typeof nowTemp === "number") {
    const delta = nowTemp - prevTemp;
    const direction = delta >= 0 ? "increased" : "dropped";

    const lines = [];
    lines.push(`Temperature ${direction} to ${formatC(nowTemp)} (was ${formatC(prevTemp)})${place}.`);

    if (nowTemp >= 28) lines.push("It will feel hot. Dress lighter and drink water.");
    else if (nowTemp <= 5) lines.push("It will feel cold. Wear a warm jacket.");
    else lines.push("Adjust clothing if you will be outside.");

    return lines.join(" ");
  }

  if (typeof prevCloud === "number" && typeof nowCloud === "number") {
    const delta = nowCloud - prevCloud;
    if (Math.abs(delta) >= 30) {
      const direction = delta >= 0 ? "increased" : "decreased";
      return `Cloud cover ${direction} to ${nowCloud}% (was ${prevCloud}%)${place}.`;
    }
  }

  return null;
}

function composeLocationAlert({ prevCity, nowCity, prevCountry, nowCountry }) {
  const from = [prevCity, prevCountry].filter(Boolean).join(", ");
  const to = [nowCity, nowCountry].filter(Boolean).join(", ");

  if (from && to && from !== to) {
    return `Location changed to ${to} (was ${from}). Loravo will adjust updates to your new area.`;
  }
  if (to && !from) {
    return `Location set to ${to}. Loravo will use this for local updates.`;
  }
  return null;
}

function isMeaningfulTempChange(prevTemp, nowTemp) {
  if (typeof prevTemp !== "number" || typeof nowTemp !== "number") return false;
  const delta = Math.abs(nowTemp - prevTemp);
  const crossedHot = prevTemp < 28 && nowTemp >= 28;
  const crossedCold = prevTemp > 5 && nowTemp <= 5;
  const crossedWarm = prevTemp < 20 && nowTemp >= 20;
  return delta >= 8 || crossedHot || crossedCold || crossedWarm;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isMeaningfulLocationChange(prevLat, prevLon, nowLat, nowLon) {
  if (typeof prevLat !== "number" || typeof prevLon !== "number") return true;
  const km = haversineKm(prevLat, prevLon, nowLat, nowLon);
  return km >= 10;
}

/* ===================== STAY-AHEAD ENGINE ===================== */

async function updateLocationAndMaybeAlert({ userId, lat, lon, city, country, timezone }) {
  if (!userId || typeof lat !== "number" || typeof lon !== "number") return;

  const prev = await loadUserState(userId);
  const meaningfulMove = isMeaningfulLocationChange(prev?.last_lat, prev?.last_lon, lat, lon);

  await upsertUserState(userId, {
    last_lat: lat,
    last_lon: lon,
    last_city: city || prev?.last_city || null,
    last_country: country || prev?.last_country || null,
    last_timezone: timezone || prev?.last_timezone || null,
  });

  if (meaningfulMove) {
    const msg = composeLocationAlert({
      prevCity: prev?.last_city,
      nowCity: city || prev?.last_city || null,
      prevCountry: prev?.last_country,
      nowCountry: country || prev?.last_country || null,
    });

    if (msg) {
      await enqueueAlert({
        userId,
        alertType: "location",
        message: msg,
        payload: { lat, lon, city, country, timezone },
      });
    }
  }
}

async function updateWeatherAndMaybeAlert({ userId, lat, lon }) {
  if (!userId || typeof lat !== "number" || typeof lon !== "number") return;

  const prev = await loadUserState(userId);
  const w = await getWeather(lat, lon);
  if (!w) return;

  const nowTemp = typeof w.main?.temp === "number" ? w.main.temp : null;
  const nowCloud = typeof w.clouds?.all === "number" ? w.clouds.all : null;
  const nowMain = w.weather?.[0]?.main || null;
  const nowDesc = w.weather?.[0]?.description || null;

  await upsertUserState(userId, {
    last_temp_c: nowTemp,
    last_cloud_pct: nowCloud,
    last_weather_main: nowMain,
    last_weather_desc: nowDesc,
    last_weather_at: new Date().toISOString(),
  });

  const prevTemp = typeof prev?.last_temp_c === "number" ? prev.last_temp_c : null;
  const prevCloud = typeof prev?.last_cloud_pct === "number" ? prev.last_cloud_pct : null;

  if (isMeaningfulTempChange(prevTemp, nowTemp)) {
    const msg = composeWeatherAlert({
      prevTemp,
      nowTemp,
      prevCloud,
      nowCloud,
      city: prev?.last_city || null,
    });

    if (msg) {
      await enqueueAlert({
        userId,
        alertType: "weather",
        message: msg,
        payload: { prevTemp, nowTemp, prevCloud, nowCloud, main: nowMain, desc: nowDesc },
      });
    }
  }
}

/* ===================== OPENAI (Decision) ===================== */

async function callOpenAIDecision(text, memory, maxTokens) {
  const model =
    process.env.OPENAI_MODEL_DECISION ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Hard timeout so Render doesn't "exit early" on hung requests
  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: `
You are LXT-1 (Loravo decision engine).
Return ONLY valid JSON that matches the schema. No extra text.

Grounding rules:
- Use ONLY the user's message + provided memory. Do NOT invent markets, finance, or breaking news unless the user explicitly asks.
- If the user says hi/hello/what’s up/small talk: keep it neutral, set verdict=HOLD, signals=[], watchouts=[], and actions should be simple.
- Prefer calm, realistic outputs. If uncertain, confidence ~0.6 and verdict=HOLD.

Focus:
- This JSON is used to help generate a human reply. Do not overreact.
`.trim(),
          },
          ...(memory
            ? [{ role: "system", content: `Memory:\n${memory}` }]
            : []),
          { role: "user", content: text },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "lxt1",
            strict: true,
            schema: LXT1_SCHEMA,
          },
        },
        max_output_tokens: maxTokens,
      }),
    });

    if (!resp.ok) {
      const bodyText = await resp.text();

      // If schema formatting isn't supported by model/provider, fall back
      const schemaNotSupported =
        /json_schema|text\.format|not supported|unsupported/i.test(bodyText);

      if (schemaNotSupported) {
        return await callOpenAIDecision_JSONinText(text, memory, maxTokens);
      }

      throw new Error(bodyText);
    }

    const data = await resp.json();
    const parsed = extractOpenAIParsedObject(data);

    // If for any reason parsed JSON isn't present, fallback to JSON-in-text extraction
    if (!parsed) {
      return await callOpenAIDecision_JSONinText(text, memory, maxTokens);
    }

    return sanitizeToSchema(parsed);
  } catch (e) {
    // Abort errors -> treat as retryable
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      throw new Error("OpenAI request timed out");
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAIDecision_JSONinText(text, memory, maxTokens) {
  const model =
    process.env.OPENAI_MODEL_DECISION ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const prompt = `
You are LXT-1 (Loravo decision engine).
Return ONLY one JSON object matching the schema EXACTLY. JSON only.

Grounding rules:
- Use ONLY the user's message + provided memory. Do NOT invent markets, finance, or breaking news unless the user explicitly asks.
- If the user message is a greeting/small talk: verdict=HOLD, confidence ~0.6, signals=[], watchouts=[], actions should be simple.

Schema:
- verdict: HOLD|PREPARE|MOVE|AVOID
- confidence: 0..1
- one_liner: string
- signals: array of {name, direction(up|down|neutral), weight(number), why}
- actions: array of {now, time(today|this_week|this_month), effort(low|med|high)}
- watchouts: array of strings
- next_check: ISO timestamp string

NO markdown. NO extra text. JSON only.
`.trim();

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: prompt },
          ...(memory
            ? [{ role: "system", content: `Memory:\n${memory}` }]
            : []),
          { role: "user", content: text },
        ],
        max_output_tokens: maxTokens,
      }),
    });

    if (!resp.ok) throw new Error(await resp.text());

    const data = await resp.json();

    // Try parsed JSON first (some providers still return it)
    let obj = extractOpenAIParsedObject(data);

    // Fallback: extract JSON from text
    if (!obj) {
      const outText =
        data?.output
          ?.flatMap((o) => o?.content || [])
          ?.map((p) => p?.text)
          ?.filter(Boolean)
          ?.join("\n") || "";

      obj = extractFirstJSONObject(outText);
    }

    if (!obj) throw new Error("OpenAI returned no JSON");
    return sanitizeToSchema(obj);
  } catch (e) {
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      throw new Error("OpenAI request timed out");
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAIDecisionWithRetry(text, memory, maxTokens, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      return await callOpenAIDecision(text, memory, maxTokens);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

/* ===================== GEMINI (Decision + Reply + News) ===================== */

function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, cancel: () => clearTimeout(t) };
}

// Make replies vary naturally (short sometimes, longer sometimes)
function pickReplyTokens(userText) {
  const t = String(userText || "").trim();
  const len = t.length;

  // Greetings / tiny prompts
  if (len <= 18) return 140;

  // Simple questions
  if (len <= 80) return 260;

  // Medium
  if (len <= 200) return 520;

  // Long / complex
  return 900; // never always maxing out
}

function isPoweredByQuestion(userText) {
  const t = String(userText || "").toLowerCase();
  return (
    t.includes("powered by") ||
    t.includes("what powers") ||
    t.includes("what are you built on") ||
    t.includes("what model") ||
    t.includes("what are you running on")
  );
}

async function callGeminiDecision(text, memory, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

  const system = `
You are LXT-1 (Loravo decision engine).
Return ONLY one valid JSON object and nothing else.

Schema:
- verdict: "HOLD" | "PREPARE" | "MOVE" | "AVOID"
- confidence: number 0..1
- one_liner: string
- signals: array of { name, direction("up"|"down"|"neutral"), weight(number), why(string) }
- actions: array of { now(string), time("today"|"this_week"|"this_month"), effort("low"|"med"|"high") }
- watchouts: array of strings
- next_check: ISO timestamp string

Rules:
- If greeting/small-talk: verdict="HOLD", confidence ~0.6, signals=[], watchouts=[], actions simple.
- No markdown. No commentary. JSON only.
`.trim();

  const { controller, cancel } = withTimeout(
    Number(process.env.GEMINI_TIMEOUT_MS || 20000)
  );

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            ...(memory ? [{ role: "system", content: `Memory:\n${memory}` }] : []),
            { role: "user", content: String(text || "") },
          ],
          max_tokens: Math.min(Number(maxTokens || 1200), 2000),
          temperature: 0.20,
        }),
      }
    );

    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();

    const content = j?.choices?.[0]?.message?.content || "";

    // Hardening: Gemini sometimes adds leading text or code fences.
    const obj = extractFirstJSONObject(content);
    if (!obj) throw new Error(`Gemini returned no JSON. Raw: ${content.slice(0, 240)}`);

    return sanitizeToSchema(obj);
  } catch (e) {
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      throw new Error("Gemini decision request timed out");
    }
    throw e;
  } finally {
    cancel();
  }
}

async function callGeminiReply({ userText, lxt1, style, lastReplyHint, liveContext }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model =
    process.env.GEMINI_MODEL_REPLY ||
    process.env.GEMINI_MODEL ||
    "gemini-3-flash-preview";

  const replyTokens = pickReplyTokens(userText);

  const system = `
You are LORAVO inside a chat UI. Write like ChatGPT at its best: natural, calm, sharp.

Behavior:
- Vary length naturally. Sometimes 1–2 short lines, sometimes 4–8 lines when needed.
- Default: 2–6 short sentences unless the user clearly wants depth.
- Be direct and human. No corporate tone.

Hard rules:
- Do NOT say: "I'm an AI", "as an AI", "I don't have access", "I can't browse", "I can’t see live data".
- Do NOT hype “headlines across the globe” unless the user asked for global news.
- If the user asks "What are you powered by?" answer: "Powered by LXT-1." (You may add: "with OpenAI/Gemini under the hood" ONLY if they press for details.)
- If weather is requested and live_context.weather exists, use it.
- If weather is requested and you DON'T have live_context.weather, ask ONE question that lets the app fetch it (city or enable location), and keep it short.
- No bullets unless user asks.
- No repeating the user’s exact wording.

Return ONLY the reply text.
`.trim();

  const payload = {
    userText: String(userText || ""),
    lxt1: lxt1 || null,
    live_context: {
      weather: liveContext?.weather || null,
      location: liveContext?.location || null,
    },
    last_reply_hint: lastReplyHint || "",
    style: style || "human",
  };

  const { controller, cancel } = withTimeout(
    Number(process.env.GEMINI_TIMEOUT_MS || 20000)
  );

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(payload) },
          ],
          max_tokens: replyTokens,
          temperature: 0.62,
          // ❌ IMPORTANT: Gemini OpenAI-compat may reject these:
          // presence_penalty: 0.20,
          // frequency_penalty: 0.25,
        }),
      }
    );

    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();

    let reply = (j?.choices?.[0]?.message?.content || "").trim();

    if (isPoweredByQuestion(userText)) {
      if (!reply.toLowerCase().includes("lxt")) reply = "Powered by LXT-1.";
      if (reply.length > 220) reply = "Powered by LXT-1.";
    }

    return reply || "Got you. What do you want to do next?";
  } catch (e) {
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      return "One sec — try that again.";
    }
    throw e;
  } finally {
    cancel();
  }
}

async function callGeminiNewsSummary({ userText, memory, newsContext }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model =
    process.env.GEMINI_MODEL_REPLY ||
    process.env.GEMINI_MODEL ||
    "gemini-3-flash-preview";

  const system = `
You are a calm, sharp assistant in a chat UI.
Summarize the user's recent news items like a human.

Rules:
- 1 to 3 short sentences max.
- No hype, no “breaking” tone.
- No sources, no headlines.
- If severity is high/critical, include one next step.
Return ONLY plain text.
`.trim();

  const payload = {
    userText: String(userText || ""),
    memory: memory || "",
    items: Array.isArray(newsContext) ? newsContext : [],
  };

  const { controller, cancel } = withTimeout(
    Number(process.env.GEMINI_TIMEOUT_MS || 20000)
  );

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(payload) },
          ],
          max_tokens: 260,
          temperature: 0.55,
          // ❌ IMPORTANT: Gemini OpenAI-compat may reject these:
          // presence_penalty: 0.10,
          // frequency_penalty: 0.20,
        }),
      }
    );

    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();

    const out = (j?.choices?.[0]?.message?.content || "").trim();
    return out || "Nothing urgent on your radar right now.";
  } catch (e) {
    if (String(e?.name || "").toLowerCase().includes("abort")) {
      return "Nothing urgent right now.";
    }
    throw e;
  } finally {
    cancel();
  }
}

/* ===================== OPENAI (Reply) ===================== */

function isPoweredByQuestion(t) {
  const s = String(t || "").toLowerCase();
  return (
    s.includes("powered by") ||
    s.includes("powerd by") ||
    s.includes("what are you powered") ||
    s.includes("what is this powered") ||
    s.includes("what model") ||
    s.includes("what are you built on") ||
    s.includes("what is your model")
  );
}

function isWeatherQuestion(t) {
  const s = String(t || "").toLowerCase();
  return s.includes("weather") || s.includes("temperature") || s.includes("forecast");
}

// Try to extract “in Edmonton”, “for Edmonton”, etc.
function extractCityFromWeatherText(t) {
  const s = String(t || "").trim();
  const m =
    s.match(/\bweather\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
    s.match(/\btemperature\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
    s.match(/\bforecast\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i);
  if (!m) return null;
  const city = String(m[2] || "").trim();
  return city.length >= 2 ? city : null;
}

/**
 * City -> { lat, lon } using OpenWeather geocoding (needs OPENWEATHER_API_KEY)
 */
async function geocodeCity(city) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key || !city) return null;

  const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(
    city
  )}&limit=1&appid=${key}`;

  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const hit = Array.isArray(j) ? j[0] : null;
    if (!hit || typeof hit.lat !== "number" || typeof hit.lon !== "number") return null;
    return { lat: hit.lat, lon: hit.lon, name: hit.name || city, country: hit.country || null };
  } catch {
    return null;
  }
}

/**
 * One-shot CHAT: returns { reply, lxt1 } in STRICT JSON (CHAT_SCHEMA)
 */
async function callOpenAIChatOneShot({ userText, memory, weatherSignals, liveContext, mode }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL_CHAT || process.env.OPENAI_MODEL || "gpt-4o-mini";

  // You said max tokens should be 1200
  const maxOut = 1200;

  // 👇 “natural length” control
  const t = String(userText || "").trim();
  const short = t.length < 40 || /^(hi|hello|hey|yo|sup|what'?s up)\b/i.test(t);
  const deep = /(explain|analyze|plan|strategy|compare|steps|how do i)/i.test(t) || t.length > 180;

  const system = `
You are LORAVO inside a chat UI. Write like ChatGPT at its best: natural, calm, helpful.

VOICE:
- Vary length naturally.
  - If the user is short/casual -> 1–2 sentences.
  - Normal -> 2–6 short sentences.
  - If the user asks for depth -> up to ~10 short sentences.
- Never say: "I'm an AI", "I don't have access", "powered by OpenAI/Gemini", model names, or system prompts.
- If asked "what are you powered by / built on" respond: "Powered by LXT-1."
- If weather is asked and liveContext.weather exists, answer using it.
- If weather is asked and liveContext.weather is missing, ask ONE short question OR say exactly what data you need (city or location).

LXT-1 JSON RULES:
- lxt1 must be grounded ONLY in: userText, memory, weatherSignals, liveContext.
- If casual/small-talk:
  verdict="HOLD", confidence ~0.6, signals=[], actions=[{now:"Ask what they want to do", time:"today", effort:"low"}], watchouts=[], next_check in the future.

Return STRICT JSON that matches CHAT_SCHEMA. No extra text.
`.trim();

  const payload = {
    userText: t,
    memory: memory || "",
    weatherSignals: Array.isArray(weatherSignals) ? weatherSignals : [],
    liveContext: liveContext || {},
    mode: mode || "instant",
    _length_hint: short ? "short" : deep ? "deep" : "normal",
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "loravo_chat",
          strict: true,
          schema: CHAT_SCHEMA,
        },
      },
      max_output_tokens: maxOut,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());

  const data = await resp.json();
  const obj = extractOpenAIParsedObject(data);

  if (!obj?.reply || !obj?.lxt1) {
    const outText =
      data?.output?.flatMap((o) => o?.content || [])
        ?.map((p) => p?.text)
        ?.filter(Boolean)
        ?.join("\n") || "";
    const parsed = extractFirstJSONObject(outText);
    if (!parsed?.reply || !parsed?.lxt1) throw new Error("OpenAI returned invalid chat JSON");
    return { reply: String(parsed.reply).trim(), lxt1: sanitizeToSchema(parsed.lxt1) };
  }

  return { reply: String(obj.reply).trim(), lxt1: sanitizeToSchema(obj.lxt1) };
}

/**
 * Reply-only: returns just text (GPT-like).
 * This is the one you’ll usually call after you already have lxt1.
 */
async function callOpenAIReply({ userText, lxt1, style, lastReplyHint, liveContext }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL_REPLY || process.env.OPENAI_MODEL || "gpt-4o-mini";

  // You said max tokens should be 1200
  const maxOut = 1200;

  const t = String(userText || "").trim();

  // ✅ HARD OVERRIDES (so it always behaves right)
  if (isPoweredByQuestion(t)) {
    return "Powered by LXT-1.";
  }

  // ✅ Weather without lat/lon: “weather in Edmonton”
  // If you don't have liveContext.weather, we attempt city->lat/lon using OpenWeather geocode + getWeather()
  if (isWeatherQuestion(t) && !liveContext?.weather) {
    const city = extractCityFromWeatherText(t);
    if (city) {
      const geo = await geocodeCity(city);
      if (geo?.lat != null && geo?.lon != null) {
        const w = await getWeather(geo.lat, geo.lon);
        if (w) {
          const temp = typeof w.main?.temp === "number" ? Math.round(w.main.temp) : null;
          const desc = w.weather?.[0]?.description || w.weather?.[0]?.main || null;
          const feels = typeof w.main?.feels_like === "number" ? Math.round(w.main.feels_like) : null;

          const parts = [];
          parts.push(`${geo.name}${geo.country ? `, ${geo.country}` : ""}:`);
          if (temp != null && desc) parts.push(`${temp}°C and ${desc}.`);
          else if (temp != null) parts.push(`${temp}°C right now.`);
          else if (desc) parts.push(`${desc}.`);
          if (feels != null) parts.push(`Feels like ${feels}°C.`);
          return parts.join(" ").replace(/\s+/g, " ").trim();
        }
      }
    }
    // fallback: ask ONE short question
    return "Which city are you in (or share lat/lon), and do you want current temp or the next 24 hours?";
  }

  // 👇 Natural length control
  const short = t.length < 40 || /^(hi|hello|hey|yo|sup|what'?s up)\b/i.test(t);
  const deep = /(explain|analyze|plan|strategy|compare|steps|how do i)/i.test(t) || t.length > 180;

  const system = `
You are LORAVO — a calm, intelligent assistant in a chat UI.

VOICE:
- Vary length naturally.
  - Short/casual -> 1–2 sentences.
  - Normal -> 2–6 short sentences.
  - Depth request -> up to ~10 short sentences.
- Sound like ChatGPT-quality (human, clear, modern).
- Never say: "I'm an AI", "I don't have access", "powered by OpenAI/Gemini", model names.
- Don't over-apologize. No corporate tone.
- Ask ONE short clarifying question only if truly needed.

IMPORTANT:
- If asked "what are you powered by / built on": reply exactly "Powered by LXT-1."
Return ONLY the reply text.
`.trim();

  const payload = {
    userText: t,
    verdict: lxt1?.verdict || null,
    one_liner: lxt1?.one_liner || null,
    top_actions: (lxt1?.actions || []).slice(0, 3),
    top_watchouts: (lxt1?.watchouts || []).slice(0, 3),
    top_signals: (lxt1?.signals || []).slice(0, 4),
    live_context: liveContext || {},
    style: style || "human",
    last_reply_hint: lastReplyHint || "",
    _length_hint: short ? "short" : deep ? "deep" : "normal",
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) },
      ],
      max_output_tokens: maxOut,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());

  const data = await resp.json();
  const outText =
    data?.output?.flatMap((o) => o?.content || [])
      ?.map((p) => p?.text)
      ?.filter(Boolean)
      ?.join("\n") || "";

  return outText.trim() || "Got you — what do you want to do next?";
}
/* ===================== TRINITY ORCHESTRATION ===================== */

async function getDecision({ provider, text, memory, maxTokens }) {
  const tried = [];

  if (provider === "openai") {
    tried.push("openai");
    const lxt1 = await callOpenAIDecisionWithRetry(text, memory, maxTokens);
    return { lxt1, decisionProvider: "openai", tried };
  }

  if (provider === "gemini") {
    tried.push("gemini");
    const lxt1 = await callGeminiDecision(text, memory, maxTokens);
    return { lxt1, decisionProvider: "gemini", tried };
  }

  // trinity
  try {
    tried.push("openai");
    const lxt1 = await callOpenAIDecisionWithRetry(text, memory, maxTokens);
    return { lxt1, decisionProvider: "openai", tried };
  } catch (openaiErr) {
    try {
      tried.push("gemini");
      const lxt1 = await callGeminiDecision(text, memory, maxTokens);
      return { lxt1, decisionProvider: "gemini", tried, _openai_error: String(openaiErr) };
    } catch (gemErr) {
      return {
        lxt1: safeFallbackResult("Provider failed — retry shortly."),
        decisionProvider: "fallback",
        tried,
        _openai_error: String(openaiErr),
        _gemini_error: String(gemErr),
      };
    }
  }
}

async function getHumanReply({
  provider,
  decisionProvider,
  userText,
  lxt1,
  style,
  lastReplyHint,
  liveContext,
}) {
  if (provider === "openai") {
    const reply = await callOpenAIReply({
      userText,
      lxt1,
      style: style || "human",
      lastReplyHint,
      liveContext,
    });
    return { reply, replyProvider: "openai", tried: ["openai"] };
  }

  if (provider === "gemini") {
    const reply = await callGeminiReply({
      userText,
      lxt1,
      style: style || "human",
      lastReplyHint,
      liveContext,
    });
    return { reply, replyProvider: "gemini_flash", tried: ["gemini_flash"] };
  }

  // trinity: gemini reply first, fallback openai reply
  try {
    const reply = await callGeminiReply({
      userText,
      lxt1,
      style: style || "human",
      lastReplyHint,
      liveContext,
    });
    return { reply, replyProvider: "gemini_flash", tried: ["gemini_flash"] };
  } catch (e) {
    const reply = await callOpenAIReply({
      userText,
      lxt1,
      style: style || "human",
      lastReplyHint,
      liveContext,
    });
    return {
      reply,
      replyProvider: "openai_fallback",
      tried: ["gemini_flash", "openai"],
      _reply_error: String(e?.message || e),
    };
  }
}

/* ===================== CORE HANDLER ===================== */
async function runLXT({ req }) {
  const provider = getProvider(req);
  let mode = getMode(req);

  const { text, user_id, lat, lon, style } = req.body || {};
  if (!text) throw new Error("Missing 'text' in body");
const state = await loadUserState(user_id);
const memory = await loadUserMemory(user_id);
  // intent router (you already have classifyIntent + pickAutoMode)
  const intent = typeof classifyIntent === "function" ? classifyIntent(text) : "chat";

  // AUTO chooses instant vs thinking based on message
  if (mode === "auto" && typeof pickAutoMode === "function") {
    mode = pickAutoMode(text);
  }
  const maxTokens = TOKEN_LIMITS[mode] || TOKEN_LIMITS.auto;

  /* ===================== NEWS FAST PATH ===================== */
if (intent === "news") {
  const newsItems = await getRecentNewsForUser(user_id, 5);

  const reply = await callGeminiNewsSummary({
    userText: text,
    memory,
    newsContext: newsItems,
  });

  await saveUserMemory(user_id, text);

  return {
    provider: "gemini",
    mode,
    reply,
    lxt1: null,
    providers: {
      decision: "news_fast",
      reply: "gemini_news",
      triedDecision: ["news_fast"],
      triedReply: ["gemini_news"],
    },
    _errors: {},
  };
}
 
  /* ===================== FAST PATH: greeting ===================== */
  if (intent === "greeting") {
    return {
      provider: "loravo_fastpath",
      mode: "instant",
      reply: "Hey — what’s on your mind?",
      lxt1: null,
      providers: {
        decision: "fastpath",
        reply: "fastpath",
        triedDecision: ["fastpath"],
        triedReply: ["fastpath"],
      },
      _errors: {},
    };
  }

  /* ===================== LOAD CONTEXT ===================== */
  const liveContext = await buildLiveContext({
  userId: user_id,
  text,
  lat,
  lon,
});

const weatherRaw =
  typeof lat === "number" && typeof lon === "number"
    ? await getWeather(lat, lon)
    : null;

const weatherSignals = weatherRaw ? weatherToSignals(weatherRaw) : [];

  /* ===================== CHAT: human response ===================== */
  // If you want chat to feel best: keep it SINGLE-PASS (no decision->reply double call)
if (intent === "chat") {
    // Use the existing reply model, but give it useful live context in lxt1
    const lxt1ForChat = {
      verdict: "HOLD",
      confidence: 0.8,
      one_liner: "General chat.",
      signals: weatherSignals,
      actions: [],
      watchouts: [],
      next_check: safeNowPlus(6 * 60 * 60 * 1000),
    };

    const reply = await callGeminiReply({
  userText: text,
  lxt1: lxt1ForChat,
  style: style || "human",
  lastReplyHint: state?.last_alert_hash ? "Rephrase; avoid repeating." : "",
  liveContext: {
  weather: liveContext?.weather || null,
  location: {
    lat: typeof lat === "number" ? lat : null,
    lon: typeof lon === "number" ? lon : null,
    city: state?.last_city || null,
    country: state?.last_country || null,
    timezone: state?.last_timezone || null,
   },
  },
});
    await saveUserMemory(user_id, text);

    return {
      provider: "gemini",
      mode,
      reply,
      lxt1: null,
      providers: {
        decision: "chat_fast",
        reply: "gemini",
        triedDecision: ["chat_fast"],
        triedReply: ["gemini"],
      },
      _errors: {},
    };
  }

  /* ===================== DECISION PATH ===================== */
  const decision = await getDecision({ provider, text, memory, maxTokens });
  let lxt1 = decision.lxt1 || safeFallbackResult("Temporary issue—retry.");

  lxt1.signals = [...weatherSignals, ...(lxt1.signals || [])];

  await saveUserMemory(user_id, text);

  const lastReplyHint = state?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

  const voice = await getHumanReply({
  provider,
  decisionProvider: decision.decisionProvider,
  userText: text,
  lxt1,
  style: style || "human",
  lastReplyHint,
  liveContext,
});

  return {
    provider,
    mode,
    lxt1,
    reply: voice.reply,
    providers: {
      decision: decision.decisionProvider,
      reply: voice.replyProvider,
      triedDecision: decision.tried,
      triedReply: voice.tried,
    },
    _errors: {
      openai: decision._openai_error,
      gemini: decision._gemini_error,
      reply: voice._reply_error,
      reply2: voice._reply_error2,
    },
  };
}
/* ===================== PUSH (APNs) ===================== */
/* ===================== PUSH (APNs) ===================== */

const http2 = require("http2");

function base64urlBuffer(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlJson(obj) {
  return base64urlBuffer(Buffer.from(JSON.stringify(obj)));
}

function getApnsConfig() {
  const keyId = String(process.env.APNS_KEY_ID || "").trim();
  const teamId = String(process.env.APNS_TEAM_ID || "").trim();

  // Use APNS_TOPIC (bundle id). If you prefer, APNS_BUNDLE_ID also works.
  const topic = String(process.env.APNS_TOPIC || process.env.APNS_BUNDLE_ID || "").trim();

  // You said you already have APNS_KEY_P8_B64
  const p8b64 = String(process.env.APNS_KEY_P8_B64 || "").trim();

  if (!keyId || !teamId || !topic || !p8b64) {
    throw new Error(
      "Missing APNS env vars (APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC/APNS_BUNDLE_ID, APNS_KEY_P8_B64)"
    );
  }

  // Decode base64 -> PEM text
  let pem = Buffer.from(p8b64, "base64").toString("utf8").trim();
  pem = pem.replace(/\r\n/g, "\n").trim();

  // If they encoded ONLY the middle part, rebuild the PEM
  if (!pem.includes("BEGIN PRIVATE KEY") && !pem.includes("BEGIN EC PRIVATE KEY")) {
    pem = `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`;
  }

  // Convert PEM to KeyObject (this avoids many OpenSSL decoder issues)
  let keyObject;
  try {
    keyObject = crypto.createPrivateKey({ key: pem, format: "pem" });
  } catch (e) {
    throw new Error(`APNS key decode failed: ${e?.message || e}`);
  }

  return { keyId, teamId, topic, keyObject };
}

function makeApnsJwt() {
  const { keyId, teamId, keyObject } = getApnsConfig();

  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: teamId, iat: Math.floor(Date.now() / 1000) };

  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;

  let sig;
  try {
    // ES256 (ECDSA with SHA-256) signature in JOSE format
    sig = crypto.sign(null, Buffer.from(unsigned), {
      key: keyObject,
      dsaEncoding: "ieee-p1363",
    });
  } catch (e) {
    throw new Error(`JWT sign failed: ${e?.message || e}`);
  }

  return `${unsigned}.${base64urlBuffer(sig)}`;
}

async function apnsSendStrict({ deviceToken, title, body, payload, environment }) {
  const { topic } = getApnsConfig();
  const jwt = makeApnsJwt();

  const host = String(environment || "production") === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";

  const notification = {
    aps: {
      alert: { title: title || "Loravo", body: body || "" },
      sound: "default",
    },
    ...(payload || {}),
  };

  const client = http2.connect(`https://${host}`);

  const headers = {
    ":method": "POST",
    ":path": `/3/device/${deviceToken}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": "alert",
  };

  return await new Promise((resolve) => {
    let respData = "";
    const req = client.request(headers);

    req.setEncoding("utf8");
    req.on("response", (headers) => {
      const status = headers[":status"];
      req.on("data", (chunk) => (respData += chunk));
      req.on("end", () => {
        client.close();
        resolve({
          ok: Number(status) >= 200 && Number(status) < 300,
          status: Number(status),
          body: respData || "",
        });
      });
    });

    req.on("error", (err) => {
      client.close();
      resolve({ ok: false, status: 500, body: String(err?.message || err) });
    });

    req.write(JSON.stringify(notification));
    req.end();
  });
}

/* ===================== PUSH DB HELPERS ===================== */

function normalizeEnv(e) {
  const v = String(e || "production").toLowerCase().trim();
  return v === "sandbox" ? "sandbox" : "production";
}

async function getUserDevices(userId) {
  if (!dbReady) return [];
  const { rows } = await dbQuery(
    `SELECT user_id, device_token, environment, platform, updated_at FROM push_devices WHERE user_id=$1 ORDER BY updated_at DESC`,
    [userId]
  );
  return rows || [];
}

async function registerDevice({ userId, deviceToken, environment, platform = "ios" }) {
  const env = normalizeEnv(environment);
  const token = String(deviceToken || "").trim();
  if (!token) throw new Error("Missing device_token");

  // matches YOUR db constraint: UNIQUE(user_id, environment)
  await dbQuery(
    `
    INSERT INTO push_devices (user_id, device_token, environment, platform)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (user_id, environment) DO UPDATE SET
      device_token=EXCLUDED.device_token,
      platform=EXCLUDED.platform,
      updated_at=NOW()
  `,
    [userId, token, env, platform]
  );

  return { environment: env };
}

/* ===================== PREFS HELPERS (for push send-test) ===================== */

async function getPrefs(userId) {
  return (await loadUserPrefs(userId)) || null;
}

function isInQuietHours(prefs) {
  return isNowInQuietHours(prefs);
}

/* ===================== AUTO PUSH (best-effort) ===================== */

async function maybeSendPushForAlert({ userId, alertType, message, payload }) {
  if (!dbReady) return;

  // Respect quiet hours unless force_push = true
  const prefs = await getPrefs(userId);
  const force = Boolean(payload?.force_push);
  if (!force && isInQuietHours(prefs)) return;

  const devices = await getUserDevices(userId);
  if (!devices.length) return;

  const pushPayload = {
    kind: alertType,
    user_id: userId,
    message,
    ...(payload || {}),
  };

  for (const d of devices) {
    const r = await apnsSendStrict({
      deviceToken: d.device_token,
      title: "Loravo",
      body: message,
      payload: pushPayload,
      environment: normalizeEnv(d.environment),
    });

    if (!r.ok) {
      console.error("⚠️ APNs send failed:", r.status, r.body);
    }
  }
}

/* ===================== ALERT POLLING ===================== */

async function pollAlerts(userId, limit = 5) {
  if (!dbReady) return [];

  const { rows } = await dbQuery(
    `
    SELECT id, alert_type, message, payload, created_at
    FROM alert_queue
    WHERE user_id=$1 AND delivered_at IS NULL
    ORDER BY created_at ASC
    LIMIT $2
    `,
    [userId, limit]
  );

  const alerts = rows || [];
  if (!alerts.length) return [];

  const ids = alerts.map((a) => a.id);
  await dbQuery(
    `
    UPDATE alert_queue
    SET delivered_at = NOW()
    WHERE id = ANY($1::int[])
    `,
    [ids]
  );

  return alerts.map((a) => ({
    id: a.id,
    type: a.alert_type,
    message: a.message,
    payload: a.payload,
    created_at: a.created_at,
  }));
}

/* ===================== ALERT HISTORY ===================== */

async function getAlertHistory(userId, limit = 50, offset = 0) {
  if (!dbReady) return [];

  const { rows } = await dbQuery(
    `
    SELECT id, alert_type, message, payload, created_at, delivered_at
    FROM alert_queue
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset]
  );

  return rows || [];
}
async function getRecentNewsForUser(userId, limit = 6) {
  if (!dbReady || !userId) return [];
  const { rows } = await dbQuery(
    `
    SELECT title, summary, region, severity, action, created_at
    FROM news_events
    WHERE user_id=$1
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  return rows || [];
}
/* ===================== ENDPOINTS ===================== */

app.post("/lxt1", async (req, res) => {
  try {
    const result = await runLXT({ req });
    res.json({
      ...result.lxt1,
      _provider: result.providers.decision,
      _providers: result.providers,
      ...(result._errors?.openai || result._errors?.gemini ? { _errors: result._errors } : {}),
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const result = await runLXT({ req });
    res.json({
      reply: result.reply,
      lxt1: result.lxt1,
      _providers: result.providers,
      ...(result._errors?.openai || result._errors?.gemini || result._errors?.reply
        ? { _errors: result._errors }
        : {}),
    });
  } catch (e) {
    res.status(500).json({ error: "server error", detail: String(e?.message || e) });
  }
});

/**
 * POST /state/location
 * Body: { user_id, lat, lon, city?, country?, timezone? }
 */
app.post("/state/location", async (req, res) => {
  try {
    const { user_id, lat, lon, city, country, timezone } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (typeof lat !== "number" || typeof lon !== "number")
      return res.status(400).json({ error: "Missing lat/lon (numbers)" });

    await updateLocationAndMaybeAlert({ userId: user_id, lat, lon, city, country, timezone });
    await updateWeatherAndMaybeAlert({ userId: user_id, lat, lon });

    res.json({ ok: true, db: dbReady });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * POST /state/weather
 * Body: { user_id, lat, lon }
 */
app.post("/state/weather", async (req, res) => {
  try {
    const { user_id, lat, lon } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (typeof lat !== "number" || typeof lon !== "number")
      return res.status(400).json({ error: "Missing lat/lon (numbers)" });

    await updateWeatherAndMaybeAlert({ userId: user_id, lat, lon });
    res.json({ ok: true, db: dbReady });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * GET /poll?user_id=...&limit=5
 */
app.get("/poll", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "");
    const limit = Number(req.query.limit || 5);
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const alerts = await pollAlerts(userId, clamp(limit, 1, 20));
    res.json({ ok: true, db: dbReady, alerts });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * GET /history?user_id=...&limit=50&offset=0
 */
app.get("/history", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "");
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const offset = Number(req.query.offset || 0);

    if (!userId) {
      return res.status(400).json({ error: "Missing user_id" });
    }

    const history = await getAlertHistory(userId, limit, offset);
    res.json({ ok: true, db: dbReady, history });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * POST /trip/set
 * Body: { user_id, active, destination?, depart_at?, notes? }
 */
app.post("/trip/set", async (req, res) => {
  try {
    const { user_id, active, destination, depart_at, notes } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!dbReady) return res.status(200).json({ ok: true, db: false, note: "DB disabled — trip not stored." });

    await dbQuery(
      `
      INSERT INTO user_trip (user_id, active, destination, depart_at, notes)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET
        active=EXCLUDED.active,
        destination=EXCLUDED.destination,
        depart_at=EXCLUDED.depart_at,
        notes=EXCLUDED.notes,
        updated_at=NOW()
    `,
      [
        user_id,
        Boolean(active),
        destination || null,
        depart_at ? new Date(depart_at).toISOString() : null,
        notes || null,
      ]
    );

    if (active && destination) {
      await enqueueAlert({
        userId: user_id,
        alertType: "trip",
        message: `Trip set to ${destination}. Loravo will monitor weather and important local changes for this trip.`,
        payload: { destination, depart_at, notes },
      });
    }

    res.json({ ok: true, db: dbReady });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * POST /news/ingest
 * Body: { user_id, title, summary, region?, severity?, action? }
 */
app.post("/news/ingest", async (req, res) => {
  try {
    const { user_id, title, summary, region, severity, action } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!title) return res.status(400).json({ error: "Missing title" });

    const sev = String(severity || "low").toLowerCase();

    // ✅ Always store ingested news so chat can recall it (even low)
    if (dbReady) {
      await dbQuery(
        `
        INSERT INTO news_events (user_id, title, summary, region, severity, action)
        VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [user_id, title, summary || null, region || null, sev, action || null]
      );
    }

    // queue alert only if meaningful
    const meaningful = ["medium", "high", "critical"].includes(sev);

    if (meaningful && dbReady) {
      const parts = [];
      parts.push(`${title}.`);
      if (region) parts.push(`Area: ${region}.`);
      if (summary) parts.push(summary);
      if (action) parts.push(action);

      const message = parts.join(" ").replace(/\s+/g, " ").trim();

      await enqueueAlert({
        userId: user_id,
        alertType: "news",
        message,
        payload: { title, summary, region, severity: sev, action },
      });
    }

    res.json({ ok: true, db: dbReady, queued: meaningful && dbReady });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});
/**
 * POST /push/register
 * Body: { user_id, device_token, environment? }
 */
app.post("/push/register", async (req, res) => {
  try {
    const { user_id, device_token, environment } = req.body || {};

    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!device_token) return res.status(400).json({ error: "Missing device_token" });
    if (!environment) return res.status(400).json({ error: "Missing environment" });
    if (!dbReady) return res.status(200).json({ ok: true, db: false, note: "DB disabled" });

    await registerDevice({
      userId: String(user_id),
      deviceToken: String(device_token),
      environment: String(environment),
      platform: "ios",
    });

    return res.json({ ok: true, db: true });
  } catch (e) {
    console.error("❌ /push/register error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * POST /push/send-test
 * Body: { user_id, environment?, title?, body, payload?, force? }
 */
app.post("/push/send-test", async (req, res) => {
  try {
    const { user_id, environment, title, body, payload, force } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    if (!dbReady) return res.status(200).json({ ok: true, db: false, note: "DB disabled — cannot send test push." });

    const envWanted = environment ? normalizeEnv(environment) : null;

    let devices = await getUserDevices(String(user_id));
    if (envWanted) devices = devices.filter((d) => normalizeEnv(d.environment) === envWanted);

    if (!devices.length) return res.status(400).json({ error: "No device registered for this user_id (and environment)" });

    const prefs = await getPrefs(String(user_id));
    if (!force && isInQuietHours(prefs)) {
      return res.json({ ok: true, db: true, skipped: true, reason: "quiet_hours" });
    }

    const results = [];
    for (const d of devices) {
      const r = await apnsSendStrict({
        deviceToken: d.device_token,
        title: title || "Loravo",
        body: body || "Test push from Loravo.",
        payload: payload || { test: true },
        environment: normalizeEnv(d.environment),
      });
      results.push({ env: normalizeEnv(d.environment), status: r.status, ok: r.ok, body: r.body });
    }

    res.json({ ok: true, db: true, results });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * POST /prefs/quiet-hours
 * Body: { user_id, enabled, start, end, timezone? }
 */
app.post("/prefs/quiet-hours", async (req, res) => {
  try {
    const { user_id, enabled, start, end, timezone } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!dbReady) return res.status(200).json({ ok: true, db: false, note: "DB disabled — prefs not stored." });

    const s = normalizeTimeHHMM(start);
    const e = normalizeTimeHHMM(end);
    if (!s || !e) return res.status(400).json({ error: "start/end must be HH:MM (e.g., 23:00)" });

    await dbQuery(
      `
      INSERT INTO user_prefs (user_id, quiet_enabled, quiet_start, quiet_end, timezone)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (user_id) DO UPDATE SET
        quiet_enabled=EXCLUDED.quiet_enabled,
        quiet_start=EXCLUDED.quiet_start,
        quiet_end=EXCLUDED.quiet_end,
        timezone=EXCLUDED.timezone,
        updated_at=NOW()
    `,
      [user_id, Boolean(enabled), s, e, timezone || null]
    );

    res.json({ ok: true, db: dbReady });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * GET /prefs?user_id=...
 */
app.get("/prefs", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "");
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!dbReady) return res.status(200).json({ ok: true, db: false, prefs: null });

    const prefs = await loadUserPrefs(userId);
    res.json({
      ok: true,
      db: dbReady,
      prefs: prefs
        ? {
            quiet_enabled: Boolean(prefs.quiet_enabled),
            quiet_start: prefs.quiet_start || null,
            quiet_end: prefs.quiet_end || null,
            timezone: prefs.timezone || null,
            updated_at: prefs.updated_at,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ===================== START ===================== */

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error("⚠️ DB init failed (DB disabled):", e?.message || e);
    dbReady = false;
  }

  app.listen(PORT, () => {
    console.log(`✅ LORAVO running on ${PORT} (dbReady=${dbReady})`);
  });
})();