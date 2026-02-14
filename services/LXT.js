/*************************************************
 * LXT.js — Loravo LXT Engine (AI brain)
 * ✅ No Express routes here.
 * ✅ index.js wires HTTP endpoints + DB + push + routes.
 *
 * Gmail integration:
 * ✅ Reads OAuth tokens from DB (gmail_tokens)
 * ✅ Uses Gmail API directly (fast)
 *************************************************/

const fetch = require("node-fetch"); // node-fetch@2
const crypto = require("crypto");
const { google } = require("googleapis");

/* ===================== FACTORY ===================== */

function createLXT({ pool, getDbReady }) {
  const dbReady = () => (typeof getDbReady === "function" ? !!getDbReady() : false);

  /* ===================== CONFIG ===================== */

  const TOKEN_LIMITS = { instant: 400, auto: 1000, thinking: 1800 };

  function getMode(req) {
    const m = String(req?.query?.mode || "auto").toLowerCase();
    return ["instant", "auto", "thinking"].includes(m) ? m : "auto";
  }

  function getProvider(req) {
    const p = String(req?.query?.provider || "trinity").toLowerCase();
    return ["openai", "gemini", "trinity"].includes(p) ? p : "trinity";
  }

  function pickAutoMode(text) {
    if (!text) return "instant";
    const t = String(text).toLowerCase().trim();

    if (t.length < 40 || /^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)) return "instant";

    if (/^(what|when|where|who|is|are|do|does|can|should)\b/.test(t) && t.length < 120) {
      return "instant";
    }

    if (/(analyze|plan|compare|strategy|explain|forecast|should i|pros and cons)/.test(t) || t.length > 180) {
      return "thinking";
    }

    return "instant";
  }

  /* ===================== SCHEMAS ===================== */

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

  /* ===================== UTIL HELPERS ===================== */

  function clamp(n, a, b) {
    const x = Number(n);
    if (!Number.isFinite(x)) return a;
    return Math.max(a, Math.min(b, x));
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

  // Force next_check to future; clamp confidence; ensure arrays exist
  function sanitizeToSchema(o) {
    const conf = typeof o?.confidence === "number" ? o.confidence : 0.6;
    return {
      verdict: o?.verdict || "HOLD",
      confidence: clamp(Math.round(conf * 100) / 100, 0, 1),
      one_liner: String(o?.one_liner || "OK"),
      signals: Array.isArray(o?.signals) ? o.signals : [],
      actions: Array.isArray(o?.actions)
        ? o.actions
        : [{ now: "Proceed normally", time: "today", effort: "low" }],
      watchouts: Array.isArray(o?.watchouts) ? o.watchouts : [],
      next_check: safeNowPlus(6 * 60 * 60 * 1000),
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

  function withTimeout(ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    return { controller, cancel: () => clearTimeout(t) };
  }

  function stripHtml(s) {
    return String(s || "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<\/?[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* ===================== INTENT ===================== */

  function classifyIntent(text) {
    const t = String(text || "").toLowerCase().trim();

    if (/^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)) return "greeting";
    if (/(news|headlines|what happened|what’s going on|whats going on|breaking|update me|anything i should know)/.test(t))
      return "news";
    if (/(weather|temperature|temp\b|forecast|rain|snow|wind)/.test(t)) return "weather";

    // ✅ Gmail / email intent
    if (
      /(gmail|email|inbox|unread|important email|summari[sz]e.*email|summari[sz]e.*inbox|reply to.*email|send.*email|check.*email|new emails)/.test(
        t
      )
    )
      return "email";

    return "chat";
  }

  function isPoweredByQuestion(userText) {
    const t = String(userText || "").toLowerCase();
    return (
      t.includes("powered by") ||
      t.includes("powerd by") ||
      t.includes("what powers") ||
      t.includes("what are you built on") ||
      t.includes("what model") ||
      t.includes("what are you running on")
    );
  }

  function isWeatherQuestion(t) {
    const s = String(t || "").toLowerCase();
    return s.includes("weather") || s.includes("forecast") || s.includes("temperature") || /\btemp\b/.test(s);
  }

  // “weather in Edmonton”, “forecast for Paris”, “temperature in Toronto”
  function extractCityFromWeatherText(t) {
    const s = String(t || "").trim();
    const m =
      s.match(/\bweather\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
      s.match(/\bforecast\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
      s.match(/\btemperature\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i) ||
      s.match(/\btemp\s+(in|for)\s+([a-zA-Z\s.'-]{2,})$/i);

    if (!m) return null;
    const city = String(m[2] || "").trim();
    return city.length >= 2 ? city : null;
  }

  function pickReplyTokens(userText) {
    const t = String(userText || "").trim();
    const len = t.length;
    if (len <= 18) return 140;
    if (len <= 80) return 260;
    if (len <= 200) return 520;
    return 900;
  }

  /* ===================== DB WRAPPERS ===================== */

  async function dbQuery(sql, params) {
    if (!pool || dbReady() !== true) return { rows: [] };
    return pool.query(sql, params);
  }

  async function loadUserMemory(userId) {
    if (!userId) return "";
    const { rows } = await dbQuery(
      `SELECT content FROM user_memory WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    return (rows || []).map((r) => r.content).join("\n");
  }

  async function saveUserMemory(userId, text) {
    if (!userId || !text) return;
    await dbQuery(`INSERT INTO user_memory (user_id, content) VALUES ($1,$2)`, [userId, text]);
  }

  async function loadUserState(userId) {
    if (!userId) return null;
    const { rows } = await dbQuery(`SELECT * FROM user_state WHERE user_id=$1 LIMIT 1`, [userId]);
    return rows?.[0] || null;
  }

  async function getRecentNewsForUser(userId, limit = 6) {
    if (dbReady() !== true || !userId) return [];
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

  /* ===================== GMAIL (FAST, DIRECT) ===================== */

  async function loadGmailRecord(userId) {
    if (!userId) return null;
    const { rows } = await dbQuery(
      `SELECT user_id, email, tokens, updated_at FROM gmail_tokens WHERE user_id=$1 LIMIT 1`,
      [String(userId)]
    );
    return rows?.[0] || null;
  }

  function requireGmailEnv() {
    const CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
    const CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
    const REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
    }
    return { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI };
  }

  async function getAuthedGmail(userId) {
    const rec = await loadGmailRecord(userId);
    if (!rec?.tokens) {
      const err = new Error("Gmail not connected. Connect Gmail first.");
      err.status = 401;
      throw err;
    }

    const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = requireGmailEnv();
    const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

    // pg might return object already; or string
    const tokens = typeof rec.tokens === "string" ? JSON.parse(rec.tokens) : rec.tokens;
    oauth2.setCredentials(tokens);

    // auto-save refreshed tokens
    oauth2.on("tokens", async (newTokens) => {
      try {
        const merged = { ...(tokens || {}), ...(newTokens || {}) };
        await dbQuery(`UPDATE gmail_tokens SET tokens=$2, updated_at=NOW() WHERE user_id=$1`, [
          String(userId),
          merged,
        ]);
      } catch {
        // ignore
      }
    });

    return google.gmail({ version: "v1", auth: oauth2 });
  }

  async function gmailList({ userId, q, max = 6 }) {
    const gmail = await getAuthedGmail(userId);

    const list = await gmail.users.messages.list({
      userId: "me",
      q: q || "newer_than:2d",
      maxResults: Math.max(1, Math.min(Number(max || 6), 12)),
    });

    const ids = (list.data.messages || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return [];

    // Fetch metadata only (FAST)
    const out = [];
    for (const id of ids) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const headers = msg.data.payload?.headers || [];
      const getH = (name) => headers.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";

      out.push({
        id,
        threadId: msg.data.threadId || null,
        subject: getH("Subject"),
        from: getH("From"),
        date: getH("Date"),
        snippet: stripHtml(msg.data.snippet || ""),
      });
    }

    return out;
  }

  async function gmailGetBody({ userId, messageId }) {
    const gmail = await getAuthedGmail(userId);

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: String(messageId),
      format: "full",
    });

    // best-effort extract plain content
    function findText(payload) {
      if (!payload) return "";
      const mime = payload.mimeType || "";
      const data = payload.body?.data || null;
      if (data && (mime.includes("text/plain") || mime.includes("text/html"))) {
        const buff = Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        const text = buff.toString("utf8");
        return mime.includes("text/html") ? stripHtml(text) : String(text || "").trim();
      }
      const parts = payload.parts || [];
      for (const p of parts) {
        const got = findText(p);
        if (got) return got;
      }
      return "";
    }

    const headers = msg.data.payload?.headers || [];
    const getH = (name) => headers.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";

    return {
      id: msg.data.id,
      threadId: msg.data.threadId || null,
      subject: getH("Subject"),
      from: getH("From"),
      date: getH("Date"),
      body: findText(msg.data.payload) || stripHtml(msg.data.snippet || ""),
    };
  }

  async function gmailSend({ userId, to, subject, body, threadId = null }) {
    const gmail = await getAuthedGmail(userId);

    const raw = [
      `To: ${to}`,
      `Subject: ${subject || ""}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      String(body || ""),
    ].join("\r\n");

    const encodedMessage = Buffer.from(raw)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const resp = await gmail.users.messages.send({
      userId: "me",
      requestBody: threadId ? { raw: encodedMessage, threadId } : { raw: encodedMessage },
    });

    return { id: resp.data.id || null, threadId: resp.data.threadId || null };
  }

  function parseEmailCommand(userText) {
    const t = String(userText || "").trim();

    const lower = t.toLowerCase();

    // send email to X subject Y body Z
    const sendMatch =
      t.match(/send (an )?email to\s+([^\s]+@[^\s]+)\s+subject\s+(.+?)\s+body\s+([\s\S]+)/i) ||
      t.match(/email\s+([^\s]+@[^\s]+)\s+subject\s+(.+?)\s+body\s+([\s\S]+)/i);

    if (sendMatch) {
      const to = sendMatch[2] || sendMatch[1];
      const subject = (sendMatch[3] || sendMatch[2] || "").trim();
      const body = (sendMatch[4] || sendMatch[3] || "").trim();
      return { kind: "send", to, subject, body };
    }

    // reply latest email: ...
    const replyLatest = t.match(/reply to (the )?(latest|last) email[:\-]?\s*([\s\S]+)/i);
    if (replyLatest) {
      return { kind: "reply_latest", body: String(replyLatest[3] || "").trim() };
    }

    // reply to message id XXX: ...
    const replyId = t.match(/reply to (message )?id\s+([a-zA-Z0-9_\-]+)[:\-]?\s*([\s\S]+)/i);
    if (replyId) {
      return { kind: "reply_id", messageId: String(replyId[2] || "").trim(), body: String(replyId[3] || "").trim() };
    }

    // summarize inbox / emails
    if (/(summari[sz]e).*(inbox|emails|email)/i.test(t)) return { kind: "summarize" };

    // new important emails / important emails / unread
    if (/(important|urgent).*(email|emails)|new important emails|unread emails|check my inbox/i.test(lower)) {
      return { kind: "important" };
    }

    // search my email for ___
    const search = t.match(/search (my )?(email|gmail|inbox) for\s+([\s\S]+)/i);
    if (search) return { kind: "search", query: String(search[3] || "").trim() };

    return { kind: "unknown" };
  }

  function formatEmailList(items) {
    if (!items?.length) return "No emails found.";
    const lines = items.slice(0, 6).map((m, i) => {
      const subj = m.subject ? m.subject : "(no subject)";
      const from = m.from ? m.from : "(unknown sender)";
      const snip = m.snippet ? ` — ${m.snippet.slice(0, 120)}` : "";
      return `${i + 1}) ${subj}\n   From: ${from}\n   id: ${m.id}${snip}`;
    });
    return lines.join("\n");
  }

  /* ===================== WEATHER / GEO ===================== */

  async function geocodeCity(city) {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key || !city) return null;

    const url = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${key}`;

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

  function weatherToSignalsFromRaw(w) {
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

    if (typeof temp === "number" && temp >= 28) {
      signals.push({
        name: "High temperature",
        direction: "down",
        weight: 0.12,
        why: `It’s hot (${temp.toFixed(1)}°C) — hydration + lighter clothes.`,
      });
    }

    return signals;
  }

  function normalizeWeatherForLLM(w) {
    if (!w) return null;
    return {
      city: w.name || null,
      temp_c: typeof w.main?.temp === "number" ? w.main.temp : null,
      feels_like_c: typeof w.main?.feels_like === "number" ? w.main.feels_like : null,
      humidity_pct: typeof w.main?.humidity === "number" ? w.main.humidity : null,
      clouds_pct: typeof w.clouds?.all === "number" ? w.clouds.all : null,
      wind_mps: typeof w.wind?.speed === "number" ? w.wind.speed : null,
      main: w.weather?.[0]?.main || null,
      description: w.weather?.[0]?.description || null,
      at: new Date().toISOString(),
    };
  }

  function formatWeatherOneLiner(liveWeather, fallbackPlace) {
    const w = liveWeather || null;
    if (!w) return null;

    const parts = [];
    const place = w.city || fallbackPlace || null;
    if (place) parts.push(`${place}:`);

    const temp = typeof w.temp_c === "number" ? Math.round(w.temp_c) : null;
    const feels = typeof w.feels_like_c === "number" ? Math.round(w.feels_like_c) : null;
    const desc = w.description || w.main || null;

    if (temp != null && desc) parts.push(`${temp}°C and ${desc}.`);
    else if (temp !=null) parts.push(`${temp}°C right now.`);
    else if (desc) parts.push(`${desc}.`);

    if (feels != null && temp != null && feels !== temp) parts.push(`Feels like ${feels}°C.`);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function compactLiveContextForDecision(liveContext) {
    if (!liveContext) return null;
    const weather = liveContext.weather || null;
    const weather_geo = liveContext.weather_geo || null;

    const news = Array.isArray(liveContext.news)
      ? liveContext.news.slice(0, 5).map((n) => ({
          title: n?.title || "",
          region: n?.region || null,
          severity: n?.severity || null,
          action: n?.action || null,
          created_at: n?.created_at || null,
        }))
      : [];

    return {
      weather: weather
        ? {
            city: weather.city || null,
            temp_c: typeof weather.temp_c === "number" ? weather.temp_c : null,
            feels_like_c: typeof weather.feels_like_c === "number" ? weather.feels_like_c : null,
            clouds_pct: typeof weather.clouds_pct === "number" ? weather.clouds_pct : null,
            main: weather.main || null,
            description: weather.description || null,
            at: weather.at || null,
          }
        : null,
      weather_geo: weather_geo
        ? {
            name: weather_geo.name || null,
            country: weather_geo.country || null,
            lat: typeof weather_geo.lat === "number" ? weather_geo.lat : null,
            lon: typeof weather_geo.lon === "number" ? weather_geo.lon : null,
          }
        : null,
      news,
    };
  }

  async function buildLiveContext({ userId, text, lat, lon }) {
    let weatherRaw = null;
    let weatherGeo = null;

    if (typeof lat === "number" && typeof lon === "number") {
      weatherRaw = await getWeather(lat, lon);
      weatherGeo = { lat, lon };
    } else {
      if (isWeatherQuestion(text)) {
        const city = extractCityFromWeatherText(text);
        if (city) {
          const geo = await geocodeCity(city);
          if (geo?.lat != null && geo?.lon != null) {
            weatherRaw = await getWeather(geo.lat, geo.lon);
            weatherGeo = geo;
          }
        }
      }
    }

    const news = userId ? await getRecentNewsForUser(userId, 5) : [];

    return {
      weather_raw: weatherRaw,
      weather: normalizeWeatherForLLM(weatherRaw),
      weather_geo: weatherGeo,
      news: Array.isArray(news) ? news : [],
    };
  }

  /* ===================== OPENAI: DECISION ===================== */

  async function callOpenAIDecision({ text, memory, liveContextCompact, maxTokens }) {
    const model = process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const inputs = [
        {
          role: "system",
          content: `
You are LXT-1 (Loravo decision engine).
Return ONLY valid JSON that matches the schema. No extra text.

Grounding rules:
- Use ONLY: user message + memory + provided live context (if present).
- Do NOT invent breaking news or facts.
- If greeting/small talk: verdict=HOLD, signals=[], watchouts=[], actions simple.
- Prefer calm, realistic outputs. If uncertain: confidence ~0.6 and verdict=HOLD.
`.trim(),
        },
        ...(memory ? [{ role: "system", content: `Memory:\n${memory}` }] : []),
      ];

      if (liveContextCompact) {
        inputs.push({
          role: "system",
          content: `Live context (trusted):\n${JSON.stringify(liveContextCompact)}`,
        });
      }

      inputs.push({ role: "user", content: String(text || "") });

      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: inputs,
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
        const schemaNotSupported = /json_schema|text\.format|not supported|unsupported/i.test(bodyText);
        if (schemaNotSupported) {
          return await callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens });
        }
        throw new Error(bodyText);
      }

      const data = await resp.json();
      const parsed = extractOpenAIParsedObject(data);
      if (!parsed) return await callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens });
      return sanitizeToSchema(parsed);
    } catch (e) {
      if (String(e?.name || "").toLowerCase().includes("abort")) throw new Error("OpenAI request timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens }) {
    const model = process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const controller = new AbortController();
    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const prompt = `
You are LXT-1 (Loravo decision engine).
Return ONLY one JSON object matching the schema EXACTLY. JSON only.

Rules:
- Use ONLY: user message + memory + provided live context (if present).
- If greeting/small talk: verdict=HOLD, confidence ~0.6, signals=[], watchouts=[], actions simple.
- No markdown. No extra text. JSON only.
`.trim();

    try {
      const inputs = [{ role: "system", content: prompt }];
      if (memory) inputs.push({ role: "system", content: `Memory:\n${memory}` });
      if (liveContextCompact) inputs.push({ role: "system", content: `Live context:\n${JSON.stringify(liveContextCompact)}` });
      inputs.push({ role: "user", content: String(text || "") });

      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: inputs,
          max_output_tokens: maxTokens,
        }),
      });

      if (!resp.ok) throw new Error(await resp.text());

      const data = await resp.json();
      let obj = extractOpenAIParsedObject(data);

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
      if (String(e?.name || "").toLowerCase().includes("abort")) throw new Error("OpenAI request timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens, tries = 3 }) {
    let err;
    for (let i = 0; i < tries; i++) {
      try {
        return await callOpenAIDecision({ text, memory, liveContextCompact, maxTokens });
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  /* ===================== GEMINI: DECISION + REPLY + NEWS SUMMARY ===================== */

  async function callGeminiDecision({ text, memory, liveContextCompact, maxTokens }) {
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
- Use ONLY: user message + memory + provided live context (if present). Do NOT invent facts.
- If greeting/small-talk: verdict="HOLD", confidence ~0.6, signals=[], watchouts=[], actions simple.
- No markdown. JSON only.
`.trim();

    const { controller, cancel } = withTimeout(Number(process.env.GEMINI_TIMEOUT_MS || 20000));

    try {
      const messages = [{ role: "system", content: system }];
      if (memory) messages.push({ role: "system", content: `Memory:\n${memory}` });
      if (liveContextCompact) messages.push({ role: "system", content: `Live context:\n${JSON.stringify(liveContextCompact)}` });
      messages.push({ role: "user", content: String(text || "") });

      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: Math.min(Number(maxTokens || 1200), 2000),
          temperature: 0.2,
        }),
      });

      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();

      const content = j?.choices?.[0]?.message?.content || "";
      const obj = extractFirstJSONObject(content);
      if (!obj) throw new Error(`Gemini returned no JSON. Raw: ${content.slice(0, 240)}`);

      return sanitizeToSchema(obj);
    } catch (e) {
      if (String(e?.name || "").toLowerCase().includes("abort")) throw new Error("Gemini decision request timed out");
      throw e;
    } finally {
      cancel();
    }
  }

  async function callGeminiReply({ userText, lxt1, style, lastReplyHint, liveContext }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");

    const model = process.env.GEMINI_MODEL_REPLY || process.env.GEMINI_MODEL || "gemini-3-flash-preview";

    if (isPoweredByQuestion(userText)) return "Powered by LXT-1.";

    const replyTokens = pickReplyTokens(userText);

    const system = `
You are LORAVO inside a chat UI. Write like ChatGPT at its best: natural, calm, sharp.

Behavior:
- Vary length naturally. Short sometimes, longer when needed.
- Default: 2–6 short sentences unless the user clearly wants depth.
- Be direct and human.

Hard rules:
- Do NOT say: "I'm an AI", "as an AI", "I don't have access", "I can't browse".
- Do NOT hype.
- If the user asks "What are you powered by?" answer: "Powered by LXT-1."
- If weather is requested and live_context.weather exists, use it.
- If weather is requested and live_context.weather is missing, ask ONE short question (city or allow location).
Return ONLY the reply text.
`.trim();

    const payload = {
      userText: String(userText || ""),
      lxt1: lxt1 || null,
      live_context: {
        weather: liveContext?.weather || null,
        location: liveContext?.location || null,
        news: Array.isArray(liveContext?.news) ? liveContext.news : [],
      },
      last_reply_hint: lastReplyHint || "",
      style: style || "human",
    };

    const { controller, cancel } = withTimeout(Number(process.env.GEMINI_TIMEOUT_MS || 20000));

    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
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
        }),
      });

      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const reply = (j?.choices?.[0]?.message?.content || "").trim();
      return reply || "Got you. What do you want to do next?";
    } catch (e) {
      if (String(e?.name || "").toLowerCase().includes("abort")) return "One sec — try that again.";
      throw e;
    } finally {
      cancel();
    }
  }

  async function callGeminiNewsSummary({ userText, memory, newsContext }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");

    const model = process.env.GEMINI_MODEL_REPLY || process.env.GEMINI_MODEL || "gemini-3-flash-preview";

    const system = `
You are a calm, sharp assistant in a chat UI.
Summarize the user's recent news items like a human.

Rules:
- 1 to 3 short sentences max.
- No hype, no sources, no headlines list.
- If severity is high/critical, include one next step.
Return ONLY plain text.
`.trim();

    const payload = {
      userText: String(userText || ""),
      memory: memory || "",
      items: Array.isArray(newsContext) ? newsContext : [],
    };

    const { controller, cancel } = withTimeout(Number(process.env.GEMINI_TIMEOUT_MS || 20000));

    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
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
        }),
      });

      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      const out = (j?.choices?.[0]?.message?.content || "").trim();
      return out || "Nothing urgent on your radar right now.";
    } catch (e) {
      if (String(e?.name || "").toLowerCase().includes("abort")) return "Nothing urgent right now.";
      throw e;
    } finally {
      cancel();
    }
  }

  /* ===================== OPENAI: REPLY (TEXT) ===================== */

  async function callOpenAIReply({ userText, lxt1, style, lastReplyHint, liveContext }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = process.env.OPENAI_MODEL_REPLY || process.env.OPENAI_MODEL || "gpt-4o-mini";
    const maxOut = 1200;

    const t = String(userText || "").trim();
    if (isPoweredByQuestion(t)) return "Powered by LXT-1.";

    const short = t.length < 40 || /^(hi|hello|hey|yo|sup|what'?s up)\b/i.test(t);
    const deep = /(explain|analyze|plan|strategy|compare|steps|how do i)/i.test(t) || t.length > 180;

    const system = `
You are LORAVO — a calm, intelligent assistant in a chat UI.

VOICE:
- Vary length naturally:
  - Short/casual -> 1–2 sentences.
  - Normal -> 2–6 short sentences.
  - Depth request -> up to ~10 short sentences.
- Sound human, clear, modern.
- Never say: "I'm an AI", "I don't have access", model names.
- Ask ONE short clarifying question only if truly needed.

Hard rule:
- If asked "what are you powered by": reply exactly "Powered by LXT-1."
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
      data?.output
        ?.flatMap((o) => o?.content || [])
        ?.map((p) => p?.text)
        ?.filter(Boolean)
        ?.join("\n") || "";

    return outText.trim() || "Got you — what do you want to do next?";
  }

  /* ===================== TRINITY ORCHESTRATION ===================== */

  async function getDecision({ provider, text, memory, liveContextCompact, maxTokens }) {
    const tried = [];

    if (provider === "openai") {
      tried.push("openai");
      const lxt1 = await callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "openai", tried };
    }

    if (provider === "gemini") {
      tried.push("gemini");
      const lxt1 = await callGeminiDecision({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "gemini", tried };
    }

    try {
      tried.push("openai");
      const lxt1 = await callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "openai", tried };
    } catch (openaiErr) {
      try {
        tried.push("gemini");
        const lxt1 = await callGeminiDecision({ text, memory, liveContextCompact, maxTokens });
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

  async function getHumanReply({ provider, userText, lxt1, style, lastReplyHint, liveContext }) {
    if (provider === "openai") {
      const reply = await callOpenAIReply({ userText, lxt1, style, lastReplyHint, liveContext });
      return { reply, replyProvider: "openai", tried: ["openai"] };
    }

    if (provider === "gemini") {
      const reply = await callGeminiReply({ userText, lxt1, style, lastReplyHint, liveContext });
      return { reply, replyProvider: "gemini_flash", tried: ["gemini_flash"] };
    }

    try {
      const reply = await callGeminiReply({ userText, lxt1, style, lastReplyHint, liveContext });
      return { reply, replyProvider: "gemini_flash", tried: ["gemini_flash"] };
    } catch (e) {
      const reply = await callOpenAIReply({ userText, lxt1, style, lastReplyHint, liveContext });
      return {
        reply,
        replyProvider: "openai_fallback",
        tried: ["gemini_flash", "openai"],
        _reply_error: String(e?.message || e),
      };
    }
  }

  /* ===================== MAIN ENGINE: runLXT ===================== */

  async function runLXT({ req, forceDecision = false, forceIntent = null }) {
    const provider = getProvider(req);
    let mode = getMode(req);

    const { text, user_id, lat, lon, style } = req?.body || {};
    if (!text) throw new Error("Missing 'text' in body");

    const userId = String(user_id || "").trim() || null;

    const [state, memory] = await Promise.all([
      userId ? loadUserState(userId) : Promise.resolve(null),
      userId ? loadUserMemory(userId) : Promise.resolve(""),
    ]);

    let intent = classifyIntent(text);
    if (forceIntent) intent = String(forceIntent);

    if (mode === "auto") mode = pickAutoMode(text);
    const maxTokens = TOKEN_LIMITS[mode] || TOKEN_LIMITS.auto;

    const liveContext = await buildLiveContext({
      userId,
      text,
      lat: typeof lat === "number" ? lat : null,
      lon: typeof lon === "number" ? lon : null,
    });

    const liveCompact = compactLiveContextForDecision(liveContext);
    const weatherSignals = weatherToSignalsFromRaw(liveContext?.weather_raw);

    if (isPoweredByQuestion(text)) {
      if (userId) await saveUserMemory(userId, text);
      return {
        provider: "loravo_fastpath",
        mode: "instant",
        reply: "Powered by LXT-1.",
        lxt1: sanitizeToSchema({
          verdict: "HOLD",
          confidence: 0.85,
          one_liner: "Identity request.",
          signals: [],
          actions: [{ now: "Ask what they want to do", time: "today", effort: "low" }],
          watchouts: [],
        }),
        providers: {
          decision: "fastpath",
          reply: "fastpath",
          triedDecision: ["fastpath"],
          triedReply: ["fastpath"],
        },
        _errors: {},
      };
    }

    if (forceDecision) intent = "decision";

    /* ===================== EMAIL FAST PATH (GMAIL) ===================== */
    if (intent === "email" && !forceDecision) {
      if (!userId) {
        return {
          provider: "loravo_gmail",
          mode: "instant",
          reply: "To use Gmail, I need your user_id (the same one you connected Gmail with).",
          lxt1: null,
          providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
          _errors: {},
        };
      }

      const cmd = parseEmailCommand(text);

      try {
        // IMPORTANT/UNREAD
        if (cmd.kind === "important") {
          const items = await gmailList({
            userId,
            q: "newer_than:7d (is:unread OR category:primary)",
            max: 6,
          });

          const reply =
            items.length === 0
              ? "No unread/important emails in the last 7 days."
              : `Here are your top unread/important emails:\n\n${formatEmailList(items)}\n\nTell me: “summarize #1” or “reply to latest email: …”`;

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
            _errors: {},
          };
        }

        // SUMMARIZE
        if (cmd.kind === "summarize") {
          const items = await gmailList({
            userId,
            q: "newer_than:7d",
            max: 6,
          });

          if (!items.length) {
            if (userId) await saveUserMemory(userId, text);
            return {
              provider: "loravo_gmail",
              mode: "instant",
              reply: "No emails found in the last 7 days.",
              lxt1: null,
              providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
              _errors: {},
            };
          }

          const compact = items.map((m, i) => ({
            n: i + 1,
            id: m.id,
            subject: m.subject,
            from: m.from,
            snippet: m.snippet,
            date: m.date,
          }));

          // Use Gemini reply model just for a short summary (still fast)
          const summary = await callGeminiReply({
            userText: `Summarize these emails into 3–6 short bullets. Highlight anything urgent.\n\n${JSON.stringify(compact)}`,
            lxt1: { verdict: "HOLD", confidence: 0.8, one_liner: "Inbox summary.", signals: [], actions: [], watchouts: [], next_check: safeNowPlus(6 * 60 * 60 * 1000) },
            style: "human",
            lastReplyHint: "",
            liveContext: {},
          });

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply: summary,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gemini_summary", triedDecision: ["gmail_fast"], triedReply: ["gemini_summary"] },
            _errors: {},
          };
        }

        // SEARCH
        if (cmd.kind === "search") {
          const query = cmd.query || "";
          const items = await gmailList({
            userId,
            q: query ? `newer_than:180d ${query}` : "newer_than:30d",
            max: 6,
          });

          const reply =
            items.length === 0
              ? `No matches for: "${query}".`
              : `Top matches:\n\n${formatEmailList(items)}\n\nIf you want, say: “open id <id>” or “reply to id <id>: …”`;

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
            _errors: {},
          };
        }

        // SEND
        if (cmd.kind === "send") {
          if (!cmd.to || !cmd.body) {
            return {
              provider: "loravo_gmail",
              mode: "instant",
              reply: 'Send format: `send email to someone@email.com subject Your subject body Your message`',
              lxt1: null,
              providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
              _errors: {},
            };
          }

          const sent = await gmailSend({
            userId,
            to: cmd.to,
            subject: cmd.subject || "Loravo",
            body: cmd.body,
          });

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply: `Sent. ✅\nMessage id: ${sent.id}`,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
            _errors: {},
          };
        }

        // REPLY LATEST
        if (cmd.kind === "reply_latest") {
          const latest = await gmailList({ userId, q: "newer_than:30d", max: 1 });
          if (!latest.length) {
            return {
              provider: "loravo_gmail",
              mode: "instant",
              reply: "No recent email to reply to.",
              lxt1: null,
              providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
              _errors: {},
            };
          }

          const full = await gmailGetBody({ userId, messageId: latest[0].id });

          // Best effort: extract reply-to email from From header
          const from = full.from || "";
          const m = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
          const to = m ? (m[1] || m[0]) : null;

          if (!to) {
            return {
              provider: "loravo_gmail",
              mode: "instant",
              reply: `I couldn't detect the sender email. Here is the From header:\n${from}`,
              lxt1: null,
              providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
              _errors: {},
            };
          }

          const subject = full.subject?.startsWith("Re:") ? full.subject : `Re: ${full.subject || ""}`;

          const sent = await gmailSend({
            userId,
            to,
            subject,
            body: cmd.body || "",
            threadId: full.threadId || null,
          });

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply: `Replied. ✅\nTo: ${to}\nMessage id: ${sent.id}`,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
            _errors: {},
          };
        }

        // REPLY ID
        if (cmd.kind === "reply_id") {
          const full = await gmailGetBody({ userId, messageId: cmd.messageId });

          const from = full.from || "";
          const m = from.match(/<([^>]+)>/) || from.match(/([^\s]+@[^\s]+)/);
          const to = m ? (m[1] || m[0]) : null;

          if (!to) {
            return {
              provider: "loravo_gmail",
              mode: "instant",
              reply: `I couldn't detect the sender email. From:\n${from}`,
              lxt1: null,
              providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
              _errors: {},
            };
          }

          const subject = full.subject?.startsWith("Re:") ? full.subject : `Re: ${full.subject || ""}`;

          const sent = await gmailSend({
            userId,
            to,
            subject,
            body: cmd.body || "",
            threadId: full.threadId || null,
          });

          if (userId) await saveUserMemory(userId, text);

          return {
            provider: "loravo_gmail",
            mode: "instant",
            reply: `Replied. ✅\nTo: ${to}\nMessage id: ${sent.id}`,
            lxt1: null,
            providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
            _errors: {},
          };
        }

        // unknown email command
        const hint =
          "Tell me what you want:\n" +
          "- “new important emails”\n" +
          "- “summarize my inbox”\n" +
          "- “search my email for paypal”\n" +
          "- “send email to a@b.com subject Hi body Hello…”\n" +
          "- “reply to latest email: …”";

        if (userId) await saveUserMemory(userId, text);

        return {
          provider: "loravo_gmail",
          mode: "instant",
          reply: hint,
          lxt1: null,
          providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
          _errors: {},
        };
      } catch (e) {
        const msg = String(e?.message || e);
        if (userId) await saveUserMemory(userId, text);
        return {
          provider: "loravo_gmail",
          mode: "instant",
          reply: msg.includes("not connected")
            ? "Gmail isn’t connected for this user_id yet. Connect Gmail first, then try again."
            : `Email error: ${msg}`,
          lxt1: null,
          providers: { decision: "gmail_fast", reply: "gmail_fast", triedDecision: ["gmail_fast"], triedReply: ["gmail_fast"] },
          _errors: { gmail: msg },
        };
      }
    }

    /* ===================== NEWS FAST PATH ===================== */
    if (intent === "news" && !forceDecision) {
      const newsItems = userId ? await getRecentNewsForUser(userId, 5) : [];
      const reply = await callGeminiNewsSummary({
        userText: text,
        memory,
        newsContext: newsItems,
      });

      if (userId) await saveUserMemory(userId, text);

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

    /* ===================== GREETING FAST PATH ===================== */
    if (intent === "greeting" && !forceDecision) {
      if (userId) await saveUserMemory(userId, text);
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

    /* ===================== WEATHER FAST PATH (REAL WEATHER) ===================== */
    if (intent === "weather" && !forceDecision) {
      if (liveContext?.weather) {
        const one = formatWeatherOneLiner(liveContext.weather, liveContext?.weather_geo?.name || null);
        const reply = one || "I have your weather context. Do you want current conditions or the next 24 hours?";

        if (userId) await saveUserMemory(userId, text);

        return {
          provider: "loravo_weather",
          mode: "instant",
          reply,
          lxt1: null,
          providers: {
            decision: "weather_fast",
            reply: "weather_fast",
            triedDecision: ["weather_fast"],
            triedReply: ["weather_fast"],
          },
          _errors: {},
        };
      }

      const city = extractCityFromWeatherText(text);
      const ask = city
        ? `I can pull it — do you want current conditions in ${city}, or the next 24 hours?`
        : "Which city are you in (or allow location), and do you want current conditions or the next 24 hours?";

      if (userId) await saveUserMemory(userId, text);

      return {
        provider: "loravo_weather",
        mode: "instant",
        reply: ask,
        lxt1: null,
        providers: {
          decision: "weather_fast",
          reply: "weather_fast",
          triedDecision: ["weather_fast"],
          triedReply: ["weather_fast"],
        },
        _errors: {},
      };
    }

    /* ===================== CHAT FAST PATH (NO HEAVY DECISION) ===================== */
    if (intent === "chat" && !forceDecision) {
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
          news: liveContext?.news || [],
        },
      });

      if (userId) await saveUserMemory(userId, text);

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

    /* ===================== DECISION PATH (ALWAYS RETURNS lxt1) ===================== */
    const decision = await getDecision({
      provider,
      text,
      memory,
      liveContextCompact: liveCompact,
      maxTokens,
    });

    let lxt1 = decision.lxt1 || safeFallbackResult("Temporary issue—retry.");
    const mergedSignals = Array.isArray(lxt1.signals) ? lxt1.signals : [];
    lxt1.signals = [...weatherSignals, ...mergedSignals].slice(0, 12);

    const askedWeather = isWeatherQuestion(text);
    const weatherOne = askedWeather ? formatWeatherOneLiner(liveContext?.weather, liveContext?.weather_geo?.name || null) : null;

    if (askedWeather && weatherOne) {
      lxt1.one_liner = weatherOne;
      lxt1.verdict = "HOLD";
      lxt1.confidence = Math.max(typeof lxt1.confidence === "number" ? lxt1.confidence : 0.6, 0.75);
    }

    if (userId) await saveUserMemory(userId, text);

    const lastReplyHint = state?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

    if (forceDecision) {
      return {
        provider,
        mode,
        lxt1: sanitizeToSchema(lxt1),
        reply: null,
        providers: {
          decision: decision.decisionProvider,
          reply: "skipped",
          triedDecision: decision.tried,
          triedReply: [],
        },
        _errors: {
          openai: decision._openai_error,
          gemini: decision._gemini_error,
        },
      };
    }

    const voice = await getHumanReply({
      provider,
      userText: text,
      lxt1,
      style: style || "human",
      lastReplyHint,
      liveContext: {
        weather: liveContext?.weather || null,
        location: {
          lat: typeof lat === "number" ? lat : null,
          lon: typeof lon === "number" ? lon : null,
          city: state?.last_city || null,
          country: state?.last_country || null,
          timezone: state?.last_timezone || null,
        },
        news: liveContext?.news || [],
      },
    });

    return {
      provider,
      mode,
      lxt1: sanitizeToSchema(lxt1),
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
      },
    };
  }

  /* ===================== PUBLIC API ===================== */

  return {
    runLXT,
    _internals: {
      classifyIntent,
      pickAutoMode,
      extractCityFromWeatherText,
      buildLiveContext,
      sha1,
    },
  };
}

module.exports = { createLXT };