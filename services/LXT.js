/*************************************************
 * LXT.js — Loravo LXT Engine (MASTER) — MAXED (L2 + L3)
 * ✅ No Express routes here.
 * ✅ index.js wires HTTP endpoints + DB + push + routes.
 *
 * LEVEL 2 (Behavior Intelligence):
 * - behavior_profile (EMA): depth_pref, bullet_pref, directness, anti_robotic, friction
 * - “MORE MODE”: if user says "more", expands last_topic instead of restarting
 * - last_topic stored in user_state for continuity
 *
 * LEVEL 3 (Pro Power):
 * - plan_tier gating: core / plus / pro
 * - daily_brief (Plus), inbox_summarize (Plus), signal_scan (Pro), proactive alerts (Pro)
 * - generateProactiveInsights(): worker/cron can call this to create push-ready insight objects
 *
 * DB NOTE (recommended columns on user_state):
 * - plan_tier TEXT default 'core'
 * - behavior_profile JSONB default '{}'::jsonb
 * - last_topic JSONB default '{}'::jsonb
 * - voice_profile_updated_at TIMESTAMPTZ
 * - behavior_updated_at TIMESTAMPTZ
 *************************************************/

const fetch = require("node-fetch"); // node-fetch@2
const crypto = require("crypto");

/* Optional deps (only if you use them) */
let google;
try {
  google = require("googleapis").google;
} catch (_) {
  google = null;
}

/* ===================== FACTORY ===================== */

function createLXT({
  pool,
  getDbReady,

  // Optional: plug your own service modules here (recommended)
  services = {},

  // Optional: allow index.js to pass app-level config defaults
  defaults = {},
}) {
  const dbReady = () => (typeof getDbReady === "function" ? !!getDbReady() : false);

  /* ===================== CONFIG ===================== */

  const TOKEN_LIMITS = { instant: 420, auto: 1100, thinking: 1900 };

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
    if (/^(what|when|where|who|is|are|do|does|can|should)\b/.test(t) && t.length < 130) return "instant";
    if (/(analyze|plan|compare|strategy|explain|forecast|should i|pros and cons|step by step|break it down)/.test(t) || t.length > 220)
      return "thinking";
    return "instant";
  }

  function pickReplyTokens(userText) {
    const t = String(userText || "").trim();
    const len = t.length;
    if (len <= 18) return 170;
    if (len <= 80) return 320;
    if (len <= 200) return 650;
    return 1100;
  }

  /* ===================== TIERS + GATING (CORE / PLUS / PRO) ===================== */

  const TIERS = ["core", "plus", "pro"];

  function normalizeTier(t) {
    const x = String(t || "").toLowerCase().trim();
    return TIERS.includes(x) ? x : "core";
  }

  function tierAtLeast(tier, required) {
    const a = TIERS.indexOf(normalizeTier(tier));
    const b = TIERS.indexOf(normalizeTier(required));
    return a >= b;
  }

  // Feature matrix (edit anytime)
  const FEATURES = {
    // core features:
    chat: "core",
    email: "core",
    weather: "core",
    news: "core",
    stocks_quote: "core",

    // plus features:
    inbox_summarize: "plus",
    smart_replies: "plus",
    daily_brief: "plus",
    memory_persona: "plus",

    // pro features:
    signal_scan: "pro",
    watchlists: "pro",
    proactive_alerts: "pro",
    scenario_planner: "pro",
    deep_research_mode: "pro",
  };

  function requireFeatureOrTease({ tier, feature, tease }) {
    const required = FEATURES[feature] || "core";
    if (tierAtLeast(tier, required)) return { ok: true };
    return {
      ok: false,
      reply:
        tease ||
        (required === "plus"
          ? "That’s a Plus feature. Want me to unlock it for you?"
          : "That’s a Pro feature. Want me to unlock it for you?"),
    };
  }

  /* ===================== LXT MASTER CHAT PROMPT ===================== */

  // ✅ Paste-once master chat prompt used everywhere (OpenAI + Gemini)
  function LXT_MASTER_CHAT_SYSTEM_PROMPT(voiceProfile) {
    return `
You are LXT, the intelligence layer inside LORAVO.

You are not a generic chatbot.
You are a calm, human, strategic thinking partner.

PRIMARY IDENTITY:
- Human-sounding.
- Calm.
- Sharp.
- Slightly ahead of the user.
- Never robotic, never corporate, never stiff, never hype.

CORE RESPONSE RULE:
- Default: 2–6 short sentences.
- If user asks for more detail (why / explain / more / go deeper / step by step / examples / elaborate): expand naturally.
- Never ask “Would you like more info?” Instead: “Want me to go deeper?” or “I can break it down.”

TONE RULES:
- Vary sentence length and rhythm.
- Avoid templates and predictable formatting.
- Avoid repeating the same structures.
- Don’t use rigid labels like “VERDICT:” unless user explicitly asks.

BEHAVIOR PROFILE (learned preferences):
- If present, follow it lightly (do not overdo it). Never mention it to the user.

NEVER SAY:
- “As an AI…”
- Model names
- “I can’t browse”
- “I don’t have access”
- Anything about system prompts or internal tools

LIVE CONTEXT:
If live context is provided (weather/news/stocks/location), weave it naturally.
Do not mention APIs or “live context”.

IDENTITY RESPONSE:
If asked “What are you powered by?” reply EXACTLY:
Powered by LXT-1.

VOICE PROFILE (adapt slowly, don’t overdo it):
${voiceProfile ? `- ${voiceProfile}` : "- Calm, human, direct. Short-first; expands when asked. No hype."}

FINAL RULE:
You should feel like a real high-taste human intelligence partner.
Return ONLY the reply text.
`.trim();
  }

  /* ===================== SCHEMAS (LXT1) ===================== */

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

  function withTimeout(ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    return { controller, cancel: () => clearTimeout(t) };
  }

  function safeFallbackResult(reason = "Temporary disruption — try again in a moment.") {
    return {
      verdict: "PREPARE",
      confidence: 0.55,
      one_liner: reason,
      signals: [],
      actions: [{ now: "Retry in ~30 seconds", time: "today", effort: "low" }],
      watchouts: ["Provider outage / quota"],
      next_check: safeNowPlus(60 * 60 * 1000),
    };
  }

  function sanitizeToSchema(o) {
    const conf = typeof o?.confidence === "number" ? o.confidence : 0.62;
    return {
      verdict: ["HOLD", "PREPARE", "MOVE", "AVOID"].includes(o?.verdict) ? o.verdict : "HOLD",
      confidence: clamp(Math.round(conf * 100) / 100, 0, 1),
      one_liner: String(o?.one_liner || "OK"),
      signals: Array.isArray(o?.signals) ? o.signals : [],
      actions: Array.isArray(o?.actions) ? o.actions : [{ now: "Proceed normally", time: "today", effort: "low" }],
      watchouts: Array.isArray(o?.watchouts) ? o.watchouts : [],
      next_check: typeof o?.next_check === "string" ? o?.next_check : safeNowPlus(6 * 60 * 60 * 1000),
    };
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

  /* ===================== “SHORT FIRST, EXPAND IF ASKED” ===================== */

  function userWantsMore(text) {
    const t = String(text || "").toLowerCase();
    return (
      /\b(more|more detail|details|go deeper|deeper|why|explain|break it down|step by step|steps|examples|expand|elaborate)\b/.test(t) ||
      /\bhow exactly\b/.test(t)
    );
  }

  function lengthHintForReply(userText) {
    const t = String(userText || "").trim();
    const short = t.length < 40 || /^(hi|hello|hey|yo|sup|what'?s up)\b/i.test(t);
    if (short) return "short";
    if (userWantsMore(t)) return "deep";
    if (/(analyze|strategy|plan|compare|pros and cons|forecast|timeline)/i.test(t) || t.length > 200) return "deep";
    return "normal";
  }

  /* ===================== BEHAVIOR PROFILE (LEVEL 2) ===================== */

  function inferBehaviorFromText(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();

    const wantsShort = /\b(short|quick|fast|brief|one line)\b/.test(lower);
    const wantsDeep = /\b(more|details|go deeper|explain|break it down|step by step|examples)\b/.test(lower);

    const likesBullets = /\b(bullets|bullet points|list it|list)\b/.test(lower);
    const hatesRobotic = /\b(robotic|gray|strict|corporate|stiff)\b/.test(lower);

    const frustration =
      /\b(no|stop|wrong|nah|not that|you didn’t|you are not listening|hate|trash)\b/.test(lower) ? 1 : 0;

    const directness = /\b(do this|make it|fix it|send|give me|now|copy paste)\b/.test(lower) ? 0.65 : 0.5;

    return {
      wantsShort: wantsShort ? 1 : 0,
      wantsDeep: wantsDeep ? 1 : 0,
      likesBullets: likesBullets ? 1 : 0,
      hatesRobotic: hatesRobotic ? 1 : 0,
      frustration,
      directness,
      at: new Date().toISOString(),
    };
  }

  function mergeBehavior(oldProfile, newSig) {
    const o = oldProfile && typeof oldProfile === "object" ? oldProfile : {};
    const alpha = 0.15;

    function ema(key, fallback = 0) {
      const prev = typeof o[key] === "number" ? o[key] : fallback;
      const next = typeof newSig[key] === "number" ? newSig[key] : fallback;
      return prev * (1 - alpha) + next * alpha;
    }

    const merged = {
      depth_pref: ema("depth_pref", 0.35) + (newSig.wantsDeep ? 0.08 : newSig.wantsShort ? -0.06 : 0),
      bullet_pref: ema("bullet_pref", 0.35) + (newSig.likesBullets ? 0.08 : 0),
      directness: ema("directness", 0.55) + (newSig.directness ? 0.03 : 0),
      anti_robotic: ema("anti_robotic", 0.6) + (newSig.hatesRobotic ? 0.06 : 0),
      friction: ema("friction", 0.2) + (newSig.frustration ? 0.10 : -0.02),
      updated_at: new Date().toISOString(),
    };

    for (const k of ["depth_pref", "bullet_pref", "directness", "anti_robotic", "friction"]) {
      merged[k] = Math.max(0, Math.min(1, merged[k]));
    }
    return merged;
  }

  function behaviorToVoiceLine(bp) {
    if (!bp) return "";
    const depth =
      bp.depth_pref > 0.6 ? "Give depth when asked; otherwise keep it tight." : "Keep it short-first, expand only on request.";
    const bullets = bp.bullet_pref > 0.6 ? "When explaining, use bullets naturally." : "Prefer short paragraphs unless asked for lists.";
    const direct = bp.directness > 0.6 ? "Be direct. Minimal fluff." : "Be friendly and calm.";
    const anti = bp.anti_robotic > 0.65 ? "Avoid robotic phrasing; keep it human." : "Keep it calm and clear.";
    const friction = bp.friction > 0.6 ? "User seems frustrated: be extra clear and avoid repeating." : "";
    return `${depth} ${bullets} ${direct} ${anti} ${friction}`.trim();
  }

  /* ===================== LAST TOPIC MEMORY (“MORE MODE”) ===================== */

  function detectTopic(text) {
    const t = String(text || "").toLowerCase();
    if (/(weather|forecast|temp)/.test(t)) return { kind: "weather" };
    if (/(email|inbox|gmail|outlook|yahoo)/.test(t)) return { kind: "email" };
    if (/(stock|ticker|\$[a-z]{1,5}\b|nasdaq|crypto|btc|eth)/.test(t)) return { kind: "stocks" };
    if (/(news|headlines|breaking|what happened)/.test(t)) return { kind: "news" };
    if (/(daily brief|morning brief|brief me|what should i know today)/.test(t)) return { kind: "daily_brief" };
    if (/(scan signals|signal scan|anything i should do|what am i missing|moves today|what’s the play)/.test(t)) return { kind: "signal_scan" };
    if (/(plan|strategy|roadmap|steps|launch)/.test(t)) return { kind: "plan" };
    return { kind: "chat" };
  }

  function isMoreOnly(text) {
    const t = String(text || "").trim().toLowerCase();
    return t === "more" || t === "more." || t === "go deeper" || t === "deeper" || t === "details";
  }

  /* ===================== INTENT ===================== */

  function classifyIntent(text) {
    const t = String(text || "").toLowerCase().trim();

    if (/^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)) return "greeting";

    if (/(daily brief|morning brief|brief me|what should i know today)/.test(t)) return "daily_brief";
    if (/(scan signals|signal scan|anything i should do|what am i missing|moves today|what’s the play)/.test(t)) return "signal_scan";

    if (/(weather|temperature|temp\b|forecast|rain|snow|wind)/.test(t)) return "weather";
    if (/(stock|stocks|market|price of|ticker|\$[a-z]{1,5}\b|nasdaq|nyse|crypto|btc|eth)/.test(t)) return "stocks";
    if (/(news|headlines|what happened|what’s going on|whats going on|breaking|update me|anything i should know)/.test(t)) return "news";

    if (/(gmail|outlook|yahoo|email|inbox|unread|important email|summari[sz]e.*email|summari[sz]e.*inbox|reply to.*email|send.*email|check.*email|new emails)/.test(t))
      return "email";

    if (/(should i|what should i do|be honest|verdict|move or wait|is it smart|risk|timing window)/.test(t)) return "decision";

    return "chat";
  }

  /* ===================== WEATHER HELPERS (fallback OpenWeather) ===================== */

  function isWeatherQuestion(t) {
    const s = String(t || "").toLowerCase();
    return s.includes("weather") || s.includes("forecast") || s.includes("temperature") || /\btemp\b/.test(s);
  }

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

  async function geocodeCity_OpenWeather(city) {
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

  async function getWeather_OpenWeather(lat, lon) {
    if (typeof lat !== "number" || typeof lon !== "number" || !process.env.OPENWEATHER_API_KEY) return null;
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&appid=${process.env.OPENWEATHER_API_KEY}`;
    try {
      const r = await fetch(url);
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
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
    else if (temp != null) parts.push(`${temp}°C right now.`);
    else if (desc) parts.push(`${desc}.`);

    if (feels != null && temp != null && feels !== temp) parts.push(`Feels like ${feels}°C.`);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  /* ===================== STOCKS (plug-in friendly) ===================== */

  function extractTicker(text) {
    const t = String(text || "").trim();
    const m1 = t.match(/\$([A-Za-z]{1,6})\b/);
    if (m1) return m1[1].toUpperCase();
    const m2 = t.match(/\bprice of\s+([A-Za-z]{1,6})\b/i) || t.match(/\b([A-Za-z]{1,6})\s+(stock|shares|ticker)\b/i);
    if (m2) return String(m2[1] || "").toUpperCase();
    return null;
  }

  /* ===================== DB WRAPPERS ===================== */

  async function dbQuery(sql, params) {
    if (!pool || dbReady() !== true) return { rows: [] };
    return pool.query(sql, params);
  }

  async function loadUserMemory(userId) {
    if (!userId) return "";
    const { rows } = await dbQuery(`SELECT content FROM user_memory WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [userId]);
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

  async function setUserStateFields(userId, patch = {}) {
    if (!userId) return;
    const keys = Object.keys(patch || {});
    if (!keys.length) return;

    // JSONB columns in user_state that we want to cast safely
    const JSONB_COLS = new Set(["behavior_profile", "last_topic"]);

    const cols = [];
    const vals = [String(userId)];
    let idx = 2;

    for (const k of keys) {
      const v = patch[k];
      const isJsonb = JSONB_COLS.has(k);

      if (isJsonb) {
        const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
        cols.push(`${k}=$${idx++}::jsonb`);
        vals.push(s);
      } else {
        cols.push(`${k}=$${idx++}`);
        vals.push(v);
      }
    }

    const sql = `UPDATE user_state SET ${cols.join(", ")}, updated_at=NOW() WHERE user_id=$1`;
    try {
      await dbQuery(sql, vals);
    } catch {
      // ignore if schema doesn’t match
    }
  }

  async function getRecentNewsForUser(userId, limit = 6) {
    if (services?.news?.getRecentForUser) {
      try {
        return await services.news.getRecentForUser({ userId, limit });
      } catch {}
    }

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

  /* ===================== EMAIL (plug-in friendly) ===================== */

  async function getConnectedEmailProviders(userId) {
    if (services?.email?.getConnectedProviders) {
      try {
        return await services.email.getConnectedProviders({ userId });
      } catch {
        return [];
      }
    }
    return ["gmail"];
  }

  // ✅ Updated: now recognizes "list my latest 5 emails", "show inbox", "latest emails", etc.
  function parseEmailCommand(userText) {
    const t = String(userText || "").trim();
    const lower = t.toLowerCase();

    function extractCountDefault(defaultN = 5) {
      // "latest 5 emails", "show 10 emails", "top 3 messages"
      const m = lower.match(/\b(\d{1,2})\b/);
      if (!m) return defaultN;
      const n = Number(m[1]);
      if (!Number.isFinite(n)) return defaultN;
      return clamp(n, 1, 25);
    }

    const sendMatch =
      t.match(/send (an )?email to\s+([^\s]+@[^\s]+)\s+subject\s+(.+?)\s+body\s+([\s\S]+)/i) ||
      t.match(/email\s+([^\s]+@[^\s]+)\s+subject\s+(.+?)\s+body\s+([\s\S]+)/i);

    if (sendMatch) {
      const to = sendMatch[2] || sendMatch[1];
      const subject = (sendMatch[3] || sendMatch[2] || "").trim();
      const body = (sendMatch[4] || sendMatch[3] || "").trim();
      return { kind: "send", to, subject, body };
    }

    const replyLatest = t.match(/reply to (the )?(latest|last) email[:\-]?\s*([\s\S]+)/i);
    if (replyLatest) return { kind: "reply_latest", body: String(replyLatest[3] || "").trim() };

    const replyId = t.match(/reply to (message )?id\s+([a-zA-Z0-9_\-]+)[:\-]?\s*([\s\S]+)/i);
    if (replyId) return { kind: "reply_id", messageId: String(replyId[2] || "").trim(), body: String(replyId[3] || "").trim() };

    if (/(summari[sz]e).*(inbox|emails|email)/i.test(t)) return { kind: "summarize" };
    if (/(important|urgent).*(email|emails)|new important emails|unread emails|check my inbox/i.test(lower)) return { kind: "important" };

    const search = t.match(/search (my )?(email|gmail|inbox) for\s+([\s\S]+)/i);
    if (search) return { kind: "search", query: String(search[3] || "").trim() };

    const use = t.match(/\buse\s+(gmail|outlook|yahoo)\b/i);
    if (use) return { kind: "set_provider", provider: String(use[1] || "").toLowerCase() };

    // ✅ NEW: LIST / LATEST
    // Examples:
    // - "list my latest 5 emails"
    // - "show inbox"
    // - "latest emails"
    // - "show my emails"
    // - "get my newest 10 messages"
    const hasEmailWord = /\b(email|emails|inbox|messages)\b/.test(lower);
    const listVerb = /\b(list|show|get|open|pull)\b/.test(lower);
    const recencyWord = /\b(latest|recent|newest|last)\b/.test(lower);

    if (hasEmailWord && (listVerb || recencyWord)) {
      return { kind: "list", max: extractCountDefault(5) };
    }

    return { kind: "unknown" };
  }

  function formatEmailList(items) {
    if (!items?.length) return "No emails found.";
    const lines = items.slice(0, 6).map((m, i) => {
      const subj = m.subject ? m.subject : "(no subject)";
      const from = m.from ? m.from : "(unknown sender)";
      const snip = m.snippet ? ` — ${String(m.snippet).slice(0, 120)}` : "";
      return `${i + 1}) ${subj}\n   From: ${from}\n   id: ${m.id}${snip}`;
    });
    return lines.join("\n");
  }

  /* ===================== LIVE CONTEXT (news + weather + stocks) ===================== */

  function compactLiveContextForDecision(liveContext) {
    if (!liveContext) return null;

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
      weather: liveContext.weather || null,
      location: liveContext.location || null,
      stocks: liveContext.stocks || null,
      news,
    };
  }

  async function buildLiveContext({ userId, text, lat, lon, userState }) {
    const live = { weather: null, location: null, news: [], stocks: null };

    const loc = {
      lat: typeof lat === "number" ? lat : null,
      lon: typeof lon === "number" ? lon : null,
      city: userState?.last_city || null,
      country: userState?.last_country || null,
      timezone: userState?.last_timezone || null,
    };
    live.location = loc;

    // Weather (prefer services.weather)
    if (services?.weather?.getLive) {
      try {
        live.weather = await services.weather.getLive({ userId, text, lat: loc.lat, lon: loc.lon, state: userState });
      } catch {}
    }

    // Fallback weather (OpenWeather)
    if (!live.weather) {
      let weatherRaw = null;
      let weatherGeo = null;

      if (typeof loc.lat === "number" && typeof loc.lon === "number") {
        weatherRaw = await getWeather_OpenWeather(loc.lat, loc.lon);
        weatherGeo = { lat: loc.lat, lon: loc.lon, name: loc.city || null, country: loc.country || null };
      } else if (isWeatherQuestion(text)) {
        const city = extractCityFromWeatherText(text);
        if (city) {
          const geo = await geocodeCity_OpenWeather(city);
          if (geo?.lat != null && geo?.lon != null) {
            weatherRaw = await getWeather_OpenWeather(geo.lat, geo.lon);
            weatherGeo = geo;
          }
        }
      }

      const norm = normalizeWeatherForLLM(weatherRaw);
      if (norm) live.weather = norm;
      if (weatherGeo?.name && !loc.city) live.location.city = weatherGeo.name;
      if (weatherGeo?.country && !loc.country) live.location.country = weatherGeo.country;
    }

    // News (prefer services.news)
    live.news = userId ? await getRecentNewsForUser(userId, 5) : [];

    // Stocks (prefer services.stocks)
    const ticker = extractTicker(text);
    if (ticker && services?.stocks?.quote) {
      try {
        live.stocks = await services.stocks.quote({ userId, ticker });
      } catch {
        live.stocks = null;
      }
    } else if (ticker && process.env.STOCKS_QUOTE_URL) {
      try {
        const url = `${process.env.STOCKS_QUOTE_URL}?ticker=${encodeURIComponent(ticker)}`;
        const r = await fetch(url);
        live.stocks = r.ok ? await r.json() : null;
      } catch {
        live.stocks = null;
      }
    }

    return live;
  }

  /* ===================== PERSONALITY (SLOW ADAPTATION) ===================== */

  function shouldRefreshVoiceProfile(userState) {
    const last = userState?.voice_profile_updated_at ? new Date(userState.voice_profile_updated_at).getTime() : 0;
    const now = Date.now();
    return !last || now - last > 7 * 24 * 60 * 60 * 1000;
  }

  async function maybeUpdateVoiceProfile({ userId, userState, memory }) {
    if (!userId) return;
    if (!shouldRefreshVoiceProfile(userState)) return;
    if (!memory || memory.length < 120) return;

    if (services?.persona?.summarizeVoiceProfile) {
      try {
        const profile = await services.persona.summarizeVoiceProfile({ userId, memory });
        if (profile) {
          await setUserStateFields(userId, {
            voice_profile: String(profile),
            voice_profile_updated_at: new Date().toISOString(),
          });
        }
        return;
      } catch {
        return;
      }
    }

    const profile = "Prefers a calm, human tone. Short first; expands when asked. Direct, no hype.";
    await setUserStateFields(userId, {
      voice_profile: profile,
      voice_profile_updated_at: new Date().toISOString(),
    });
  }

  /* ===================== PROVIDERS: DECISION + REPLY ===================== */

  function getOpenAIModelDecision() {
    return process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  async function callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens }) {
    const model = getOpenAIModelDecision();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
    const { controller, cancel } = withTimeout(timeoutMs);

    const prompt = `
You are LXT-1 (Loravo decision engine).
Return ONLY one JSON object matching the schema EXACTLY. JSON only.

Rules:
- Use ONLY: user message + memory + provided live context.
- Do NOT invent breaking news or facts.
- Be calm and realistic. If uncertain: verdict="HOLD", confidence around 0.6.
- Keep one_liner human, not robotic.
`.trim();

    try {
      const inputs = [{ role: "system", content: prompt }];
      if (memory) inputs.push({ role: "system", content: `Memory:\n${memory}` });
      if (liveContextCompact) inputs.push({ role: "system", content: `Live context:\n${JSON.stringify(liveContextCompact)}` });
      inputs.push({ role: "user", content: String(text || "") });

      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: inputs,
          max_output_tokens: maxTokens,
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

      const obj = extractFirstJSONObject(outText);
      if (!obj) throw new Error("OpenAI returned no JSON");
      return sanitizeToSchema(obj);
    } finally {
      cancel();
    }
  }

  async function callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens, tries = 2 }) {
    let err;
    for (let i = 0; i < tries; i++) {
      try {
        return await callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens });
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }

  // ✅ Gemini reply using MASTER CHAT PROMPT
  async function callGeminiReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");

    const model = process.env.GEMINI_MODEL_REPLY || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
    const replyTokens = pickReplyTokens(userText);

    if (isPoweredByQuestion(userText)) return "Powered by LXT-1.";

    const system = LXT_MASTER_CHAT_SYSTEM_PROMPT(voiceProfile);

    const payload = {
      userText: String(userText || ""),
      length_hint: lengthHintForReply(userText),
      lxt_brief: lxt1
        ? {
            verdict: lxt1?.verdict || null,
            one_liner: lxt1?.one_liner || null,
            top_actions: Array.isArray(lxt1?.actions) ? lxt1.actions.slice(0, 3) : [],
            top_watchouts: Array.isArray(lxt1?.watchouts) ? lxt1.watchouts.slice(0, 3) : [],
          }
        : null,
      live_context: liveContext || {},
      last_reply_hint: lastReplyHint || "",
    };

    const { controller, cancel } = withTimeout(Number(process.env.GEMINI_TIMEOUT_MS || 20000));
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
      return (j?.choices?.[0]?.message?.content || "").trim() || "Got you. What do you want to do next?";
    } catch (e) {
      if (String(e?.name || "").toLowerCase().includes("abort")) return "One sec — try that again.";
      throw e;
    } finally {
      cancel();
    }
  }

  // ✅ OpenAI reply using MASTER CHAT PROMPT
  async function callOpenAIReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = process.env.OPENAI_MODEL_REPLY || process.env.OPENAI_MODEL || "gpt-4o-mini";
    if (isPoweredByQuestion(userText)) return "Powered by LXT-1.";

    const system = LXT_MASTER_CHAT_SYSTEM_PROMPT(voiceProfile);

    const payload = {
      userText: String(userText || ""),
      length_hint: lengthHintForReply(userText),
      lxt_brief: lxt1
        ? {
            verdict: lxt1?.verdict || null,
            one_liner: lxt1?.one_liner || null,
            top_actions: Array.isArray(lxt1?.actions) ? lxt1.actions.slice(0, 3) : [],
            top_watchouts: Array.isArray(lxt1?.watchouts) ? lxt1.watchouts.slice(0, 3) : [],
          }
        : null,
      live_context: liveContext || {},
      last_reply_hint: lastReplyHint || "",
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) },
        ],
        max_output_tokens: 1200,
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
      if (services?.gemini?.decision) {
        tried.push("gemini");
        const lxt1 = await services.gemini.decision({ text, memory, liveContextCompact, maxTokens, schema: LXT1_SCHEMA });
        return { lxt1: sanitizeToSchema(lxt1), decisionProvider: "gemini", tried };
      }
    }

    try {
      tried.push("openai");
      const lxt1 = await callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "openai", tried };
    } catch (openaiErr) {
      if (services?.gemini?.decision) {
        tried.push("gemini");
        const lxt1 = await services.gemini.decision({ text, memory, liveContextCompact, maxTokens, schema: LXT1_SCHEMA });
        return { lxt1: sanitizeToSchema(lxt1), decisionProvider: "gemini", tried, _openai_error: String(openaiErr) };
      }
      return {
        lxt1: safeFallbackResult("Provider failed — try again shortly."),
        decisionProvider: "fallback",
        tried,
        _openai_error: String(openaiErr),
      };
    }
  }

  async function getHumanReply({ provider, userText, lxt1, voiceProfile, liveContext, lastReplyHint }) {
    if (provider === "openai") {
      const reply = await callOpenAIReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint });
      return { reply, replyProvider: "openai", tried: ["openai"] };
    }

    if (provider === "gemini") {
      const reply = await callGeminiReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint });
      return { reply, replyProvider: "gemini", tried: ["gemini"] };
    }

    try {
      const reply = await callGeminiReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint });
      return { reply, replyProvider: "gemini", tried: ["gemini"] };
    } catch (e) {
      const reply = await callOpenAIReply({ userText, lxt1, voiceProfile, liveContext, lastReplyHint });
      return { reply, replyProvider: "openai_fallback", tried: ["gemini", "openai"], _reply_error: String(e?.message || e) };
    }
  }

  /* ===================== FAST PATHS (EMAIL / NEWS / WEATHER / STOCKS / CHAT) ===================== */

  async function handleEmailIntent({ userId, text, planTier }) {
    if (!userId) {
      return {
        reply: "To use email, I need your user_id (the same one you connected with).",
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    const cmd = parseEmailCommand(text);

    if (cmd.kind === "set_provider") {
      await setUserStateFields(userId, { preferred_email_provider: cmd.provider });
      return { reply: `Got it — I’ll use ${cmd.provider} for email.`, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    // Plus gate: inbox summarize
    if (cmd.kind === "summarize") {
      const gate = requireFeatureOrTease({
        tier: planTier,
        feature: "inbox_summarize",
        tease: "I can summarize your inbox and pull out what matters — that’s Plus. Want me to unlock it?",
      });
      if (!gate.ok) return { reply: gate.reply, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    const connected = await getConnectedEmailProviders(userId);
    if (!connected.length) {
      return {
        reply: "No email account is connected yet. Connect Gmail/Outlook/Yahoo first, then try again.",
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    const st = await loadUserState(userId);
    const preferred = String(st?.preferred_email_provider || "").toLowerCase();
    const providers = preferred && connected.includes(preferred) ? [preferred, ...connected.filter((x) => x !== preferred)] : connected;

    const emailSvc = services?.email;
    if (!emailSvc) {
      return { reply: "Email service isn’t wired in services.email yet.", payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    async function tryProviders(fn) {
      let lastErr = null;
      for (const p of providers) {
        try {
          const res = await fn(p);
          return { provider: p, res };
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error("Email provider failed.");
    }

    // ✅ NEW: list / latest
    if (cmd.kind === "list") {
      const max = clamp(Number(cmd.max || 5), 1, 25);
      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, userId, q: "INBOX", max }));
      const reply = !items?.length ? "No emails found." : `Latest emails (${used}):\n\n${formatEmailList(items)}`;
      return { reply, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "important") {
      const { provider: used, res: items } = await tryProviders((p) =>
        emailSvc.list({ provider: p, userId, q: "newer_than:7d is:unread", max: 6 })
      );
      const reply =
        !items?.length
          ? "No unread emails in the last 7 days."
          : `Here are your top unread emails (${used}):\n\n${formatEmailList(items)}\n\nSay: “summarize my inbox” or “reply to latest email: …”`;
      return { reply, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "summarize") {
      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, userId, q: "newer_than:7d", max: 8 }));
      if (!items?.length) return { reply: "No emails found in the last 7 days.", payload: { provider: "loravo_email", mode: "instant", lxt1: null } };

      // Human summary via chat model (tight)
      const summary = await callGeminiReply({
        userText: `Summarize these emails in 4–7 tight bullets. Pull out anything urgent and the next action.\n\n${JSON.stringify(items.slice(0, 8))}`,
        lxt1: null,
        voiceProfile: "Calm, human, direct. Bullet-friendly. No robotic phrasing.",
        liveContext: {},
        lastReplyHint: "",
      });

      return { reply: `${summary}\n\n(Provider: ${used})`, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "search") {
      const q = cmd.query || "";
      const { provider: used, res: items } = await tryProviders((p) =>
        emailSvc.list({ provider: p, userId, q: q ? `newer_than:180d ${q}` : "newer_than:30d", max: 6 })
      );
      const reply = !items?.length ? `No matches for: "${q}".` : `Top matches (${used}):\n\n${formatEmailList(items)}`;
      return { reply, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "send") {
      if (!cmd.to || !cmd.body) {
        return {
          reply: 'Send format: `send email to someone@email.com subject Your subject body Your message`',
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }
      const { provider: used, res: sent } = await tryProviders((p) => emailSvc.send({ provider: p, userId, to: cmd.to, subject: cmd.subject || "Loravo", body: cmd.body }));
      return { reply: `Sent. ✅ (${used})\nMessage id: ${sent?.id || "ok"}`, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "reply_latest") {
      const { provider: used, res: info } = await tryProviders((p) => emailSvc.replyLatest({ provider: p, userId, body: cmd.body || "" }));
      return { reply: `Replied. ✅ (${used})\nMessage id: ${info?.id || "ok"}`, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    if (cmd.kind === "reply_id") {
      const { provider: used, res: info } = await tryProviders((p) => emailSvc.replyById({ provider: p, userId, messageId: cmd.messageId, body: cmd.body || "" }));
      return { reply: `Replied. ✅ (${used})\nMessage id: ${info?.id || "ok"}`, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
    }

    const hint =
      "Tell me what you want:\n" +
      "- “new important emails”\n" +
      "- “summarize my inbox” (Plus)\n" +
      "- “search my email for paypal”\n" +
      "- “send email to a@b.com subject Hi body Hello…”\n" +
      "- “reply to latest email: …”\n" +
      "- “use outlook” / “use gmail” / “use yahoo”\n" +
      "- “list my latest 5 emails”";

    return { reply: hint, payload: { provider: "loravo_email", mode: "instant", lxt1: null } };
  }

  async function handleWeatherIntent({ text, liveContext }) {
    if (liveContext?.weather) {
      const one = formatWeatherOneLiner(liveContext.weather, liveContext?.location?.city || null);
      return one || "I can pull your weather — do you want current conditions or the next 24 hours?";
    }
    const city = extractCityFromWeatherText(text);
    return city ? `I can pull it — current conditions in ${city}, or the next 24 hours?` : "Which city are you in (or allow location), and do you want current conditions or the next 24 hours?";
  }

  async function handleStocksIntent({ text, liveContext }) {
    const ticker = extractTicker(text);
    if (!ticker) return "Which ticker? (Example: “$TSLA” or “price of AAPL”)";

    if (liveContext?.stocks) {
      const q = liveContext.stocks;
      const price = q?.price != null ? q.price : q?.c ?? null;
      const chg = q?.change_pct != null ? q.change_pct : q?.dp ?? null;
      const asof = q?.asof || q?.t || null;

      if (price != null && chg != null) return `${ticker} is around ${price} (${chg >= 0 ? "+" : ""}${Math.round(chg * 100) / 100}%).${asof ? ` (${asof})` : ""}`;
      if (price != null) return `${ticker} is around ${price}.`;
      return `I pulled data for ${ticker}, but it’s incomplete.`;
    }

    return `I can check ${ticker}, but stocks service isn’t connected yet.`;
  }

  async function handleNewsIntent({ userId, memory, liveContext, voiceProfile }) {
    const items = Array.isArray(liveContext?.news) ? liveContext.news : [];
    if (services?.news?.summarizeForChat) {
      try {
        return await services.news.summarizeForChat({ userId, memory, items });
      } catch {}
    }
    if (!items.length) return "Nothing urgent on your radar right now.";

    return await callGeminiReply({
      userText: `Summarize these news items in 1–3 short sentences. If anything is severe, include one next step.\n\n${JSON.stringify(items.slice(0, 5))}`,
      lxt1: null,
      voiceProfile,
      liveContext: {},
      lastReplyHint: "",
    });
  }

  /* ===================== LEVEL 3: DAILY BRIEF + SIGNAL SCAN ===================== */

  async function handleDailyBrief({ planTier, liveContext, voiceProfile }) {
    const gate = requireFeatureOrTease({
      tier: planTier,
      feature: "daily_brief",
      tease: "I can give you a daily brief (news + weather + what to do today). That’s Plus. Want me to unlock it?",
    });
    if (!gate.ok) return gate.reply;

    const brief = await callGeminiReply({
      userText: `Create a daily brief. Keep it human and tight.\nInclude:\n1) What's important (max 3 bullets)\n2) What to do today (max 3 bullets)\n3) One watchout (1 line)\n\nContext:\n${JSON.stringify(liveContext)}`,
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
    });

    return brief;
  }

  async function handleSignalScan({ planTier, userId, liveContext, voiceProfile }) {
    const gate = requireFeatureOrTease({
      tier: planTier,
      feature: "signal_scan",
      tease: "I can scan signals (news + stocks + local conditions) and tell you what matters — that’s Pro. Want me to unlock it?",
    });
    if (!gate.ok) return gate.reply;

    const scan = services?.signals?.scan ? await services.signals.scan({ userId, liveContext }) : null;

    const reply = await callGeminiReply({
      userText: `Do a signal scan.\nOutput:\n- 2–4 key signals\n- 1–2 moves today\n- 1 watchout\nKeep it calm and human.\n\n${JSON.stringify({ liveContext, scan })}`,
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
    });

    return reply;
  }

  /* ===================== MAIN ENGINE: runLXT ===================== */

  async function runLXT({ req, forceDecision = false, forceIntent = null }) {
    const provider = getProvider(req);
    let mode = getMode(req);

    const { text, user_id, lat, lon } = req?.body || {};
    if (!text) throw new Error("Missing 'text' in body");

    const userId = String(user_id || "").trim() || null;

    // Load state + memory
    const [state, memory] = await Promise.all([
      userId ? loadUserState(userId) : Promise.resolve(null),
      userId ? loadUserMemory(userId) : Promise.resolve(""),
    ]);

    // Plan tier (Level 3)
    const planTier = normalizeTier(state?.plan_tier || defaults.plan_tier || "core");

    // Slow voice profile refresh (Level 1 base)
    if (userId) await maybeUpdateVoiceProfile({ userId, userState: state, memory });

    // Update behavior profile slowly (Level 2)
    if (userId) {
      const sig = inferBehaviorFromText(text);
      const oldBP = state?.behavior_profile || {};
      const nextBP = mergeBehavior(oldBP, sig);
      await setUserStateFields(userId, {
        behavior_profile: nextBP,
        behavior_updated_at: new Date().toISOString(),
      });
    }

    // Reload state for freshest behavior/voice
    const state2 = userId ? await loadUserState(userId) : state;

    const behaviorLine = behaviorToVoiceLine(state2?.behavior_profile || null);
    const baseVoice = state2?.voice_profile || defaults.voice_profile || null;
    const finalVoiceProfile = [baseVoice, behaviorLine].filter(Boolean).join(" ").trim() || null;

    // Intent
    let intent = classifyIntent(text);
    if (forceIntent) intent = String(forceIntent);
    if (forceDecision) intent = "decision";

    // Mode
    if (mode === "auto") mode = pickAutoMode(text);
    const maxTokens = TOKEN_LIMITS[mode] || TOKEN_LIMITS.auto;

    // Live context
    const liveContext = await buildLiveContext({
      userId,
      text,
      lat: typeof lat === "number" ? lat : null,
      lon: typeof lon === "number" ? lon : null,
      userState: state2,
    });

    const liveCompact = compactLiveContextForDecision(liveContext);

    // MORE MODE topic memory (Level 2)
    let topic = detectTopic(text);
    if (isMoreOnly(text) && state2?.last_topic) {
      topic = state2.last_topic;
      // If they say "more", we should encourage deeper mode
      if (!forceDecision && intent === "chat") intent = "chat";
    }
    if (userId) await setUserStateFields(userId, { last_topic: topic });

    // Identity fast answer
    if (isPoweredByQuestion(text)) {
      if (userId) await saveUserMemory(userId, text);
      return {
        provider: "loravo_fastpath",
        mode: "instant",
        reply: "Powered by LXT-1.",
        lxt1: sanitizeToSchema({
          verdict: "HOLD",
          confidence: 0.9,
          one_liner: "Identity request.",
          signals: [],
          actions: [{ now: "Ask what they want to do", time: "today", effort: "low" }],
          watchouts: [],
          next_check: safeNowPlus(6 * 60 * 60 * 1000),
        }),
        providers: { decision: "fastpath", reply: "fastpath", triedDecision: ["fastpath"], triedReply: ["fastpath"] },
        _errors: {},
      };
    }

    // Save memory (simple)
    if (userId) await saveUserMemory(userId, text);

    /* -------- FAST PATHS -------- */

    if (!forceDecision) {
      if (intent === "greeting") {
        return {
          provider: "loravo_fastpath",
          mode: "instant",
          reply: "Hey — what’s on your mind?",
          lxt1: null,
          providers: { decision: "fastpath", reply: "fastpath", triedDecision: ["fastpath"], triedReply: ["fastpath"] },
          _errors: {},
        };
      }

      if (intent === "daily_brief") {
        const reply = await handleDailyBrief({ planTier, liveContext, voiceProfile: finalVoiceProfile });
        return {
          provider: "loravo_brief",
          mode: "instant",
          reply,
          lxt1: null,
          providers: { decision: "brief_fast", reply: "gemini", triedDecision: ["brief_fast"], triedReply: ["gemini"] },
          _errors: {},
        };
      }

      if (intent === "signal_scan") {
        const reply = await handleSignalScan({ planTier, userId, liveContext, voiceProfile: finalVoiceProfile });
        return {
          provider: "loravo_signals",
          mode: "instant",
          reply,
          lxt1: null,
          providers: { decision: "signal_fast", reply: "gemini", triedDecision: ["signal_fast"], triedReply: ["gemini"] },
          _errors: {},
        };
      }

      if (intent === "email") {
        try {
          const out = await handleEmailIntent({ userId, text, planTier });
          return {
            provider: "loravo_email",
            mode: "instant",
            reply: out.reply,
            lxt1: null,
            providers: { decision: "email_fast", reply: "email_fast", triedDecision: ["email_fast"], triedReply: ["email_fast"] },
            _errors: {},
          };
        } catch (e) {
          return {
            provider: "loravo_email",
            mode: "instant",
            reply: `Email error: ${String(e?.message || e)}`,
            lxt1: null,
            providers: { decision: "email_fast", reply: "email_fast", triedDecision: ["email_fast"], triedReply: ["email_fast"] },
            _errors: { email: String(e?.message || e) },
          };
        }
      }

      if (intent === "weather") {
        const reply = await handleWeatherIntent({ text, liveContext });
        return {
          provider: "loravo_weather",
          mode: "instant",
          reply,
          lxt1: null,
          providers: { decision: "weather_fast", reply: "weather_fast", triedDecision: ["weather_fast"], triedReply: ["weather_fast"] },
          _errors: {},
        };
      }

      if (intent === "stocks") {
        const reply = await handleStocksIntent({ text, liveContext });
        return {
          provider: "loravo_stocks",
          mode: "instant",
          reply,
          lxt1: null,
          providers: { decision: "stocks_fast", reply: "stocks_fast", triedDecision: ["stocks_fast"], triedReply: ["stocks_fast"] },
          _errors: {},
        };
      }

      if (intent === "news") {
        const reply = await handleNewsIntent({ userId, memory, liveContext, voiceProfile: finalVoiceProfile });
        return {
          provider: "loravo_news",
          mode,
          reply,
          lxt1: null,
          providers: { decision: "news_fast", reply: "news_fast", triedDecision: ["news_fast"], triedReply: ["news_fast"] },
          _errors: {},
        };
      }

      if (intent === "chat") {
        const lxt1ForChat = sanitizeToSchema({
          verdict: "HOLD",
          confidence: 0.82,
          one_liner: "General chat.",
          signals: [],
          actions: [],
          watchouts: [],
          next_check: safeNowPlus(6 * 60 * 60 * 1000),
        });

        const lastReplyHint = state2?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

        // If user said "more", give model a stronger nudge to expand the last topic
        const expandedUserText =
          isMoreOnly(text) && topic?.kind
            ? `User said "more". Continue deeper on the last topic: ${topic.kind}. Expand naturally with details and examples if relevant.`
            : text;

        const voice = await getHumanReply({
          provider,
          userText: expandedUserText,
          lxt1: lxt1ForChat,
          voiceProfile: finalVoiceProfile,
          liveContext,
          lastReplyHint,
        });

        return {
          provider,
          mode,
          reply: voice.reply,
          lxt1: null,
          providers: { decision: "chat_fast", reply: voice.replyProvider, triedDecision: ["chat_fast"], triedReply: voice.tried },
          _errors: { reply: voice._reply_error },
        };
      }
    }

    /* -------- DECISION PATH (returns lxt1 + human reply) -------- */

    const decision = await getDecision({
      provider,
      text,
      memory,
      liveContextCompact: liveCompact,
      maxTokens,
    });

    let lxt1 = sanitizeToSchema(decision.lxt1 || safeFallbackResult("Temporary issue — try again."));

    // If user asked weather, gently merge it into one_liner
    if (isWeatherQuestion(text) && liveContext?.weather) {
      const w = formatWeatherOneLiner(liveContext.weather, liveContext?.location?.city || null);
      if (w) {
        lxt1.one_liner = w;
        lxt1.verdict = "HOLD";
        lxt1.confidence = Math.max(lxt1.confidence || 0.6, 0.75);
      }
    }

    const lastReplyHint = state2?.last_alert_hash ? "Rephrase; avoid repeating last wording." : "";

    if (forceDecision) {
      return {
        provider,
        mode,
        lxt1,
        reply: null,
        providers: { decision: decision.decisionProvider, reply: "skipped", triedDecision: decision.tried, triedReply: [] },
        _errors: { openai: decision._openai_error },
      };
    }

    const voice = await getHumanReply({
      provider,
      userText: text,
      lxt1,
      voiceProfile: finalVoiceProfile,
      liveContext,
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
        reply: voice._reply_error,
      },
    };
  }

  /* ===================== PROACTIVE INSIGHTS (WORKER-READY, LEVEL 3) ===================== */
  /**
   * This does NOT run by itself. Your worker/cron calls it every X minutes.
   * It returns insight objects you can enqueue into alert_queue for push.
   */
  async function generateProactiveInsights({ userId, lat = null, lon = null }) {
    const state = await loadUserState(userId);
    const planTier = normalizeTier(state?.plan_tier || "core");

    const gate = requireFeatureOrTease({ tier: planTier, feature: "proactive_alerts" });
    if (!gate.ok) return []; // only Pro

    const liveContext = await buildLiveContext({
      userId,
      text: "proactive_scan",
      lat,
      lon,
      userState: state,
    });

    // If you have a real proactive engine, prefer it
    if (services?.signals?.proactive) {
      try {
        return await services.signals.proactive({ userId, liveContext, state });
      } catch {
        // fall through to model fallback
      }
    }

    const out = await callGeminiReply({
      userText: `Generate up to 2 proactive insights for the user.
Rules:
- Only if truly useful.
- Each insight must include: title, why, action.
- If nothing urgent: return "NONE".

Context:
${JSON.stringify(liveContext)}`,
      lxt1: null,
      voiceProfile: (state?.voice_profile || "") + " Proactive. Only notify when it matters.",
      liveContext,
      lastReplyHint: "",
    });

    if (!out || out.trim().toUpperCase().includes("NONE")) return [];

    return [
      {
        kind: "proactive",
        title: "LXT Insight",
        body: out.trim(),
        severity: "normal",
        created_at: new Date().toISOString(),
      },
    ];
  }

  /* ===================== PUBLIC API ===================== */

  return {
    runLXT,
    generateProactiveInsights,

    // Expose helpers so index.js / worker can reuse them
    _internals: {
      classifyIntent,
      pickAutoMode,
      buildLiveContext,
      compactLiveContextForDecision,
      extractTicker,
      extractCityFromWeatherText,
      sha1,
      normalizeTier,
      tierAtLeast,
      requireFeatureOrTease,
      detectTopic,
      isMoreOnly,
    },
  };
}

module.exports = { createLXT };