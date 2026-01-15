/*************************************************
 * LORAVO – LXT-1 Backend (Trinity + Professional Reply + Stay-Ahead Alerts)
 * Stack:
 *  - Node + Express
 *  - OpenAI (Responses API; strict JSON schema when supported)
 *  - Gemini (OpenAI-compat; JSON fallback + reply)
 *  - PostgreSQL (user memory + user state + alert queue)
 *  - OpenWeather (weather signals)
 *
 * Endpoints:
 *  - GET  /                  -> service info (fixes "Cannot GET /")
 *  - GET  /health
 *  - POST /lxt1               -> strict LXT1 JSON only
 *  - POST /chat               -> { reply (professional), lxt1 (json), providers meta }
 *
 * Stay-Ahead Engine:
 *  - POST /state/location     -> update user location, detect meaningful changes, queue alerts
 *  - POST /state/weather      -> force weather check, detect meaningful changes, queue alerts
 *  - POST /signals/ingest     -> ingest any external signal (business/market/social/legal/etc) and queue if meaningful
 *  - GET  /poll               -> app polls for queued alerts (Loravo “sends a message”)
 *  - POST /trip/set           -> store active trip context (simple)
 *  - POST /news/ingest        -> ingest a “news event” and queue if meaningful
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

/* ===================== POSTGRES ===================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("connect", () => console.log("✅ Postgres connected"));

async function initDb() {
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
      alert_type TEXT NOT NULL,            -- weather | location | trip | news | signal | system
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

  // generic external signals (anything that can change position)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_signals (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT,                         -- e.g., "manual", "rss", "twitter", "bank", "calendar"
      domain TEXT,                         -- e.g., "business", "money", "health", "social", "legal", "tech", "market"
      title TEXT NOT NULL,
      summary TEXT,
      region TEXT,
      severity TEXT NOT NULL DEFAULT 'low', -- low | medium | high | critical
      action_hint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("✅ DB tables ensured");
}

/* ===================== HEALTH + ROOT ===================== */

app.get("/", (_, res) => {
  res.json({
    service: "LORAVO LXT-1 backend",
    status: "running",
    endpoints: ["/health", "/chat", "/lxt1", "/poll", "/state/location", "/state/weather", "/signals/ingest", "/news/ingest", "/trip/set"],
  });
});

app.get("/health", (_, res) => res.json({ ok: true }));

/* ===================== MODES & TOKEN LIMITS ===================== */

const TOKEN_LIMITS = { instant: 400, auto: 1000, thinking: 1800 };

function getMode(req) {
  const m = String(req.query.mode || "auto").toLowerCase();
  return ["instant", "auto", "thinking"].includes(m) ? m : "auto";
}

function getProvider(req) {
  const p = String(req.query.provider || "trinity").toLowerCase();
  return ["openai", "gemini", "trinity"].includes(p) ? p : "trinity";
}

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
    watchouts: ["Provider quota"],
    next_check: safeNowPlus(60 * 60 * 1000),
  };
}

function sanitizeToSchema(o) {
  const conf = typeof o?.confidence === "number" ? o.confidence : 0.5;
  return {
    verdict: o?.verdict || "PREPARE",
    confidence: clamp(Math.round(conf * 100) / 100, 0, 1),
    one_liner: String(o?.one_liner || "OK"),
    signals: Array.isArray(o?.signals) ? o.signals : [],
    actions: Array.isArray(o?.actions) ? o.actions : [{ now: "Retry later", time: "today", effort: "low" }],
    watchouts: Array.isArray(o?.watchouts) ? o.watchouts : [],
    next_check: String(o?.next_check || safeNowPlus(60 * 60 * 1000)),
  };
}

/**
 * Pull JSON object from OpenAI Responses API (preferred)
 */
function extractOpenAIParsedObject(data) {
  if (data?.output_parsed) return data.output_parsed;

  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.json) return part.json;
    }
  }
  return null;
}

/**
 * If a provider returns text containing JSON, extract the first {...} block safely.
 */
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
      why: "Overcast conditions correlate with travel delays",
    });
  }

  if (typeof temp === "number" && temp <= 3.5) {
    signals.push({
      name: "Low temperature",
      direction: "down",
      weight: 0.2,
      why: `It's cold (${temp.toFixed(1)}°C) — plan layers`,
    });
  }

  return signals;
}

/* ===================== USER MEMORY ===================== */

async function loadUserMemory(userId) {
  if (!userId) return "";
  const { rows } = await pool.query(
    `SELECT content FROM user_memory WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  return rows.map((r) => r.content).join("\n");
}

async function saveUserMemory(userId, text) {
  if (userId && text) {
    await pool.query(`INSERT INTO user_memory (user_id, content) VALUES ($1,$2)`, [userId, text]);
  }
}

/* ===================== USER STATE ===================== */

async function loadUserState(userId) {
  if (!userId) return null;
  const { rows } = await pool.query(`SELECT * FROM user_state WHERE user_id=$1 LIMIT 1`, [userId]);
  return rows[0] || null;
}

async function upsertUserState(userId, patch) {
  if (!userId) return;

  const fields = Object.keys(patch || {});
  if (!fields.length) return;

  const cols = ["user_id", ...fields];
  const vals = [userId, ...fields.map((k) => patch[k])];
  const params = cols.map((_, i) => `$${i + 1}`);

  const updates = fields.map((k) => `${k}=EXCLUDED.${k}`).concat(["updated_at=NOW()"]).join(", ");

  await pool.query(
    `
    INSERT INTO user_state (${cols.join(", ")})
    VALUES (${params.join(", ")})
    ON CONFLICT (user_id) DO UPDATE SET ${updates}
  `,
    vals
  );
}

/* ===================== ALERT QUEUE ===================== */

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

async function enqueueAlert({ userId, alertType, message, payload }) {
  if (!userId || !message) return;

  const state = await loadUserState(userId);
  const now = Date.now();
  const lastAt = state?.last_alert_at ? new Date(state.last_alert_at).getTime() : 0;

  const hash = sha1(`${alertType}|${message}`);
  const sameAsLast = state?.last_alert_hash && state.last_alert_hash === hash;
  const inCooldown = lastAt && now - lastAt < ALERT_COOLDOWN_MS;

  if (sameAsLast && inCooldown) return;

  await pool.query(
    `INSERT INTO alert_queue (user_id, alert_type, message, payload) VALUES ($1,$2,$3,$4)`,
    [userId, alertType, message, payload ? JSON.stringify(payload) : null]
  );

  await upsertUserState(userId, {
    last_alert_hash: hash,
    last_alert_at: new Date().toISOString(),
  });
}

async function pollAlerts(userId, limit = 5) {
  const { rows } = await pool.query(
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
  await pool.query(`UPDATE alert_queue SET delivered_at=NOW() WHERE id = ANY($1::int[])`, [ids]);

  return rows.map((r) => ({
    type: r.alert_type,
    message: r.message,
    payload: r.payload,
    created_at: r.created_at,
  }));
}

/* ===================== PROFESSIONAL ALERT COMPOSER ===================== */

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

function composeGenericSignalAlert({ title, region, summary, actionHint }) {
  const parts = [];
  parts.push(`${title}.`);
  if (region) parts.push(`Area: ${region}.`);
  if (summary) parts.push(summary);
  if (actionHint) parts.push(actionHint);
  return parts.join(" ").replace(/\s+/g, " ").trim();
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
        payload: {
          prevTemp,
          nowTemp,
          prevCloud,
          nowCloud,
          main: nowMain,
          desc: nowDesc,
        },
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

/**
 * Reply style:
 * - professional
 * - simple English
 * - no jokes/emojis/slang
 * - 1–2 short sentences
 */
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
    } else if (decisionProvider === "gemini") {
      tried.push("openai");
      const reply = await callOpenAIReply({ userText, lxt1, style, lastReplyHint });
      return { reply, replyProvider: "openai", tried };
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

  const weather =
    typeof lat === "number" && typeof lon === "number"
      ? await getWeather(lat, lon)
      : null;

  const weatherSignals = weatherToSignals(weather);

  // Decision JSON
  const decision = await getDecision({ provider, text, memory, maxTokens });
  let lxt1 = decision.lxt1;

  // Merge weather signals into result.signals
  lxt1.signals = [...weatherSignals, ...(lxt1.signals || [])];

  // Save memory (user’s message)
  await saveUserMemory(user_id, text);

  const lastReplyHint = state?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

  // Human reply (for chat UI)
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
      _model_hint: {
        openai_decision: process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini",
        gemini_decision: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
      },
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

    res.json({ ok: true });
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /signals/ingest
 * Body: { user_id, title, summary?, domain?, region?, severity?, action? }
 * Queues only if severity is medium/high/critical.
 * This is the “anything else” endpoint: you can feed any signal and Loravo will message when it matters.
 */
app.post("/signals/ingest", async (req, res) => {
  try {
    const { user_id, title, summary, domain, region, severity, action } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!title) return res.status(400).json({ error: "Missing title" });

    const sev = String(severity || "low").toLowerCase();
    const meaningful = ["medium", "high", "critical"].includes(sev);

    await pool.query(
      `
      INSERT INTO user_signals (user_id, source, domain, title, summary, region, severity, action_hint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
      [
        user_id,
        "manual",
        domain || "general",
        title,
        summary || null,
        region || null,
        sev,
        action || null,
      ]
    );

    if (meaningful) {
      const message = composeGenericSignalAlert({
        title,
        region,
        summary,
        actionHint: action,
      });

      await enqueueAlert({
        userId: user_id,
        alertType: "signal",
        message,
        payload: { title, summary, domain: domain || "general", region, severity: sev, action },
      });
    }

    res.json({ ok: true, queued: meaningful });
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
    res.json({ ok: true, alerts });
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

    await pool.query(
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

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * POST /news/ingest
 * Body: { user_id, title, summary, region?, severity?, action? }
 * Queues only if severity is medium/high/critical.
 */
app.post("/news/ingest", async (req, res) => {
  try {
    const { user_id, title, summary, region, severity, action } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "Missing user_id" });
    if (!title) return res.status(400).json({ error: "Missing title" });

    const sev = String(severity || "low").toLowerCase();
    const meaningful = ["medium", "high", "critical"].includes(sev);

    if (meaningful) {
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

    res.json({ ok: true, queued: meaningful });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/* ===================== START ===================== */

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ LORAVO running on ${PORT}`));
  })
  .catch((e) => {
    console.error("❌ DB init failed:", e);
    process.exit(1);
  });

/* ===================== QUICK TESTS =====================

# 0) Root
curl -s "http://localhost:3000/" | jq

# 1) Chat (professional reply + JSON)
curl -s -X POST "http://localhost:3000/chat?provider=trinity&mode=auto" \
  -H "Content-Type: application/json" \
  -d '{
    "text":"I have a flight tomorrow. How should I prepare?",
    "user_id":"test_flight",
    "lat":53.5461,
    "lon":-113.4938,
    "style":"imessage"
  }' | jq

# 2) Decision JSON only
curl -s -X POST "http://localhost:3000/lxt1?provider=trinity&mode=auto" \
  -H "Content-Type: application/json" \
  -d '{
    "text":"I have a flight tomorrow. How should I prepare?",
    "user_id":"test_flight",
    "lat":53.5461,
    "lon":-113.4938
  }' | jq

# 3) Update location (queues location + weather alert if meaningful)
curl -s -X POST "http://localhost:3000/state/location" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"test_flight",
    "lat":53.5461,
    "lon":-113.4938,
    "city":"Edmonton",
    "country":"Canada"
  }' | jq

# 4) Force weather check (queues alert if temperature changed meaningfully)
curl -s -X POST "http://localhost:3000/state/weather" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"test_flight",
    "lat":53.5461,
    "lon":-113.4938
  }' | jq

# 5) Poll alerts (Loravo “sends messages”)
curl -s "http://localhost:3000/poll?user_id=test_flight&limit=5" | jq

# 6) Trip set
curl -s -X POST "http://localhost:3000/trip/set" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"test_flight",
    "active": true,
    "destination":"New York",
    "depart_at":"2026-01-20T18:00:00Z",
    "notes":"Carry-on only"
  }' | jq

# 7) Ingest a news event (queues only if medium/high/critical)
curl -s -X POST "http://localhost:3000/news/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"test_flight",
    "title":"Major delay expected on Highway 2",
    "summary":"Traffic is slowing near construction zones.",
    "region":"Edmonton–Calgary",
    "severity":"high",
    "action":"Leave earlier or take an alternate route."
  }' | jq

# 8) Ingest ANY signal (business / money / social / legal / tech / anything)
curl -s -X POST "http://localhost:3000/signals/ingest" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id":"test_flight",
    "domain":"money",
    "title":"Credit card payment due in 48 hours",
    "summary":"Your balance is high and interest will start if not paid.",
    "region":"Canada",
    "severity":"high",
    "action":"Pay at least the statement balance today."
  }' | jq

===================================== */