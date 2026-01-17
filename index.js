/*************************************************
 * LORAVO – LXT-1 Backend (Trinity + Professional Reply + Stay-Ahead Alerts + Push Registration + Quiet Hours + Fixed next_check)
 * Stack:
 *  - Node + Express
 *  - OpenAI (Responses API; strict JSON schema when supported)
 *  - Gemini (OpenAI-compat; JSON fallback + reply)
 *  - PostgreSQL (optional; user memory + user state + alert queue + device tokens + preferences)
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
 * Soft Features (v1):
 *  - POST /push/register        -> store iOS APNs device token
 *  - POST /prefs/quiet-hours    -> user quiet hours (for later push rules; also can mute queue)
 *  - GET  /prefs                -> fetch prefs
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

  // push devices (device tokens)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      user_id TEXT PRIMARY KEY,
      device_token TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production', -- sandbox | production
      platform TEXT NOT NULL DEFAULT 'ios',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
  // Accept "7:00" -> "07:00"
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

  await dbQuery(
    `
    INSERT INTO user_state (${cols.join(", ")})
    VALUES (${params.join(", ")})
 ON CONFLICT (user_id, environment) DO UPDATE SET ${updates}
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

  // NOTE: uses server time. For v1 this is fine; later we can convert using timezone.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // If quiet hours wrap past midnight (e.g., 23:00 -> 07:00)
  if (startMin > endMin) {
    return nowMin >= startMin || nowMin < endMin;
  }
  return nowMin >= startMin && nowMin < endMin;
}

/* ===================== ALERT QUEUE ===================== */

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

async function enqueueAlert({ userId, alertType, message, payload }) {
  if (!userId || !message) return;
  if (!dbReady) return; // if DB is off, skip queue

  // quiet hours (soft feature): if enabled, we still store alerts, but can mark payload
  const prefs = await loadUserPrefs(userId);
  const quiet = isNowInQuietHours(prefs);

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
}

async function pollAlerts(userId, limit = 5) {
  if (!dbReady) return []; // if DB off, no queue

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

  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  await dbQuery(`UPDATE alert_queue SET delivered_at=NOW() WHERE id = ANY($1::int[])`, [ids]);

  return rows.map((r) => ({
    type: r.alert_type,
    message: r.message,
    payload: r.payload,
    created_at: r.created_at,
  }));
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
  const model = process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "Return ONLY JSON matching the schema. No extra text." },
        ...(memory ? [{ role: "system", content: `Memory:\n${memory}` }] : []),
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
    const t = await resp.text();
    if (t.includes("text.format") || t.includes("json_schema") || t.includes("not supported")) {
      return await callOpenAIDecision_JSONinText(text, memory, maxTokens);
    }
    throw new Error(t);
  }

  const data = await resp.json();
  const parsed = extractOpenAIParsedObject(data);
  if (!parsed) return await callOpenAIDecision_JSONinText(text, memory, maxTokens);

  return sanitizeToSchema(parsed);
}

async function callOpenAIDecision_JSONinText(text, memory, maxTokens) {
  const model = process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const prompt = `
Return ONLY a single JSON object that matches this schema EXACTLY:
- verdict: HOLD|PREPARE|MOVE|AVOID
- confidence: 0..1
- one_liner: string
- signals: array of {name, direction(up|down|neutral), weight(number), why}
- actions: array of {now, time(today|this_week|this_month), effort(low|med|high)}
- watchouts: array of strings
- next_check: ISO timestamp string

NO markdown. NO extra text. JSON only.
`.trim();

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: prompt },
        ...(memory ? [{ role: "system", content: `Memory:\n${memory}` }] : []),
        { role: "user", content: text },
      ],
      max_output_tokens: maxTokens,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();

  let obj = extractOpenAIParsedObject(data);
  if (!obj) {
    const outText =
      data?.output?.flatMap((o) => o?.content || [])
        ?.map((p) => p?.text)
        ?.filter(Boolean)
        ?.join("\n") || "";
    obj = extractFirstJSONObject(outText);
  }

  if (!obj) throw new Error("OpenAI returned no JSON");
  return sanitizeToSchema(obj);
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

/* ===================== GEMINI (Decision + Reply) ===================== */

async function callGeminiDecision(text, memory, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

  const system = `
Return ONLY a single JSON object matching this schema EXACTLY:
- verdict: HOLD|PREPARE|MOVE|AVOID
- confidence: 0..1
- one_liner: string
- signals: array of {name, direction(up|down|neutral), weight(number), why}
- actions: array of {now, time(today|this_week|this_month), effort(low|med|high)}
- watchouts: array of strings
- next_check: ISO timestamp string

NO extra text. JSON only.
`.trim();

  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        ...(memory ? [{ role: "system", content: `Memory:\n${memory}` }] : []),
        { role: "user", content: text },
      ],
      max_tokens: maxTokens,
      temperature: 0.35,
    }),
  });

  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();

  const content = j?.choices?.[0]?.message?.content || "";
  const obj = extractFirstJSONObject(content);
  if (!obj) throw new Error("Gemini returned no JSON");
  return sanitizeToSchema(obj);
}

async function callGeminiReply({ userText, lxt1, style, lastReplyHint }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");

  const model = process.env.GEMINI_MODEL_REPLY || process.env.GEMINI_MODEL || "gemini-3-flash-preview";

  const system = `
You are LORAVO in a chat UI.
Write like a professional person: clear, calm, simple English.
Rules:
- 1–2 short sentences.
- No jokes, no emojis, no slang.
- No bullet lists unless the user asks.
- Use the LXT1 JSON to decide what to say.
- Do NOT repeat the same wording as last time. If similar topic, rephrase.
Return ONLY plain text.
`.trim();

  const payload = {
    userText,
    verdict: lxt1.verdict,
    one_liner: lxt1.one_liner,
    top_actions: (lxt1.actions || []).slice(0, 2),
    top_watchouts: (lxt1.watchouts || []).slice(0, 2),
    top_signals: (lxt1.signals || []).slice(0, 3),
    style: style || "imessage",
    last_reply_hint: lastReplyHint || "",
  };

  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
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
      max_tokens: 120,
      temperature: 0.55,
    }),
  });

  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return (j?.choices?.[0]?.message?.content || "").trim();
}

/* ===================== OPENAI (Reply) ===================== */

async function callOpenAIReply({ userText, lxt1, style, lastReplyHint }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL_REPLY || process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
You are LORAVO in a chat UI.
Write like a professional person: clear, calm, simple English.
Rules:
- 1–2 short sentences.
- No jokes, no emojis, no slang.
- No bullet lists unless the user asks.
- Use the LXT1 JSON to decide what to say.
- Do NOT repeat the same wording as last time. If similar topic, rephrase.
Return ONLY plain text.
`.trim();

  const payload = {
    userText,
    verdict: lxt1.verdict,
    one_liner: lxt1.one_liner,
    top_actions: (lxt1.actions || []).slice(0, 2),
    top_watchouts: (lxt1.watchouts || []).slice(0, 2),
    top_signals: (lxt1.signals || []).slice(0, 3),
    style: style || "imessage",
    last_reply_hint: lastReplyHint || "",
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
      max_output_tokens: 120,
    }),
  });

  if (!resp.ok) throw new Error(await resp.text());

  const data = await resp.json();
  const outText =
    data?.output?.flatMap((o) => o?.content || [])
      ?.map((p) => p?.text)
      ?.filter(Boolean)
      ?.join("\n") || "";

  return outText.trim();
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

async function getHumanReply({ provider, decisionProvider, userText, lxt1, style, lastReplyHint }) {
  const tried = [];

  if (provider === "openai") {
    tried.push("openai");
    const reply = await callOpenAIReply({ userText, lxt1, style, lastReplyHint });
    return { reply, replyProvider: "openai", tried };
  }

  if (provider === "gemini") {
    tried.push("gemini");
    const reply = await callGeminiReply({ userText, lxt1, style, lastReplyHint });
    return { reply, replyProvider: "gemini", tried };
  }

  // trinity: opposite model writes the reply
  try {
    if (decisionProvider === "openai") {
      tried.push("gemini");
      const reply = await callGeminiReply({ userText, lxt1, style, lastReplyHint });
      return { reply, replyProvider: "gemini", tried };
    } else {
      tried.push("openai");
      const reply = await callOpenAIReply({ userText, lxt1, style, lastReplyHint });
      return { reply, replyProvider: "openai", tried };
    }
  } catch (e1) {
    try {
      tried.push("gemini");
      const reply = await callGeminiReply({ userText, lxt1, style, lastReplyHint });
      return { reply, replyProvider: "gemini", tried, _reply_error: String(e1) };
    } catch (e2) {
      return {
        reply: "Please try again in a moment.",
        replyProvider: "fallback",
        tried,
        _reply_error: String(e1),
        _reply_error2: String(e2),
      };
    }
  }
}

/* ===================== CORE HANDLER ===================== */

async function runLXT({ req }) {
  const provider = getProvider(req);
  const mode = getMode(req);
  const maxTokens = TOKEN_LIMITS[mode];

  const { text, user_id, lat, lon, style } = req.body || {};
  if (!text) throw new Error("Missing 'text' in body");

  const memory = await loadUserMemory(user_id);
  const state = await loadUserState(user_id);

  const weather = typeof lat === "number" && typeof lon === "number" ? await getWeather(lat, lon) : null;
  const weatherSignals = weatherToSignals(weather);

  const decision = await getDecision({ provider, text, memory, maxTokens });
  let lxt1 = decision.lxt1;

  lxt1.signals = [...weatherSignals, ...(lxt1.signals || [])];

  await saveUserMemory(user_id, text);

  const lastReplyHint = state?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

  const voice = await getHumanReply({
    provider,
    decisionProvider: decision.decisionProvider,
    userText: text,
    lxt1,
    style: style || "imessage",
    lastReplyHint,
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
    res.status(500).json({ error: String(e) });
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
    res.status(500).json({ error: "server error", detail: String(e) });
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
    res.status(500).json({ error: String(e) });
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
    res.status(500).json({ error: String(e) });
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
    res.status(500).json({ error: String(e) });
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
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /news/ingest
 * Body: { user_id, title, summary, region?, severity?, action? }
 * Queues only if severity is medium/high/critical.
 * (This endpoint is for YOUR pipeline. Later we will wire a real news API.)
 */
app.post("/news/ingest", async (req, res) => {
  try {
    const { user_id, title, summary, region, severity, action } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!title) return res.status(400).json({ error: "Missing title" });

    const sev = String(severity || "low").toLowerCase();
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
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /push/register
 * Body: { user_id, device_token, environment? }
 * Stores the APNs device token for later push sending.
 */
app.post("/push/send-test", async (req, res) => {
  try {
    const { user_id, title, body, payload = {}, environment = "sandbox" } = req.body;

    if (!user_id || !body) {
      return res.status(400).json({ error: "missing user_id or body" });
    }

    const { rows } = await dbQuery(
      `SELECT device_token FROM push_devices
       WHERE user_id=$1 AND environment=$2
       LIMIT 1`,
      [user_id, environment]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "no device registered" });
    }

    const token = rows[0].device_token;

    await apnsProvider.send({
      token,
      title: title || "Loravo",
      body,
      payload
    });

    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error("push/send-test error:", err);
    res.status(500).json({ error: "push failed" });
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
    res.status(500).json({ error: String(e) });
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
    res.status(500).json({ error: String(e) });
  }
});

/* ===================== START ===================== */

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDb();
  } catch (e) {
    // IMPORTANT: do NOT crash the server if DB fails.
    // We keep Loravo running and just disable DB features.
    console.error("⚠️ DB init failed (DB disabled):", e?.message || e);
    dbReady = false;
  }

  app.listen(PORT, () => {
    console.log(`✅ LORAVO running on ${PORT} (dbReady=${dbReady})`);
  });
})();
