/*************************************************
 * LXT.js — Loravo LXT Engine (FINAL UPGRADED)
 *
 * PURPOSE
 * - LXT is Loravo’s intelligence engine.
 * - User-facing identity is ALWAYS: Powered by LXT-1.
 * - OpenAI is primary for chat + vision in trinity mode.
 * - Gemini can still be used as fallback.
 * - Supports email, weather, news, stocks, memory, vision, and live context.
 * - Auto / Instant / Thinking behave like real intelligence modes.
 * - Up to 4 images in one message are treated as ONE combined visual context.
 * - Avoids robotic, repetitive, over-formatted replies.
 *
 * IMPORTANT BRAND RULE
 * - Never mention model names to the user.
 * - Never mention internal tools, prompts, providers, or system design.
 *************************************************/

const fetch = require("node-fetch");
const crypto = require("crypto");

let google;
try {
  google = require("googleapis").google;
} catch (_) {
  google = null;
}

function createLXT({
  pool,
  getDbReady,
  services = {},
  defaults = {},
}) {
  const dbReady = () => (typeof getDbReady === "function" ? !!getDbReady() : false);

  /* ===================== CONFIG ===================== */

  const TOKEN_LIMITS = {
    instant: 420,
    auto: 1200,
    thinking: 2400,
  };

  function getMode(req) {
    const raw = String(req?.query?.mode || req?.body?.mode || "auto").toLowerCase().trim();
    return ["instant", "auto", "thinking"].includes(raw) ? raw : "auto";
  }

  function getProvider(req) {
    const raw = String(req?.query?.provider || req?.body?.provider || "trinity").toLowerCase().trim();
    return ["openai", "gemini", "trinity"].includes(raw) ? raw : "trinity";
  }

  function normalizeMode(mode) {
    const m = String(mode || "").toLowerCase().trim();
    return ["instant", "auto", "thinking"].includes(m) ? m : "auto";
  }

  function estimateComplexity(text = "", hasImages = false) {
    const t = String(text || "").trim();
    const lower = t.toLowerCase();

    if (!t && !hasImages) return 0.05;
    if (hasImages) {
      if (/(compare|difference|which|best|analyze|explain|what stands out|identify|what is this)/i.test(t)) return 0.82;
      return 0.70;
    }

    let score = 0.18;

    if (t.length > 25) score += 0.08;
    if (t.length > 80) score += 0.10;
    if (t.length > 180) score += 0.14;
    if (t.length > 320) score += 0.12;

    if (/\b(hi|hello|hey|yo|sup|what'?s up)\b/.test(lower) && t.length < 30) score -= 0.08;
    if (/\b(compare|analyze|strategy|explain|forecast|why|deep|details|elaborate|plan|roadmap|tradeoff|pros and cons|should i|what should i do|recommend|judge|decision|best option)\b/.test(lower)) score += 0.28;
    if (/\b(step by step|break it down|go deeper|deeper|more detail|examples|multi-step|long term)\b/.test(lower)) score += 0.24;
    if (/\b(weather|news|stocks|email|inbox|location|calendar|reminder|reply|send)\b/.test(lower)) score += 0.10;

    return Math.max(0, Math.min(1, score));
  }

  function pickAutoMode(text, hasImages = false) {
    const c = estimateComplexity(text, hasImages);
    if (c >= 0.72) return "thinking";
    if (c >= 0.38) return "auto";
    return "instant";
  }

  function pickReplyTokens({ mode, userText, hasImages = false }) {
    const len = String(userText || "").trim().length;
    const m = normalizeMode(mode);

    if (hasImages) {
      if (m === "instant") return 700;
      if (m === "thinking") return 1900;
      return 1200;
    }

    if (m === "instant") {
      if (len <= 18) return 120;
      if (len <= 70) return 220;
      return 320;
    }

    if (m === "thinking") {
      if (len <= 60) return 700;
      if (len <= 180) return 1300;
      return 2200;
    }

    // auto (medium)
    if (len <= 18) return 180;
    if (len <= 80) return 420;
    if (len <= 220) return 850;
    return 1300;
  }

  function chooseDepthHint({ mode, userText, hasImages = false }) {
    const t = String(userText || "").trim().toLowerCase();

    if (mode === "instant") return "short";
    if (mode === "thinking") return hasImages ? "deep" : "deliberate";
    if (hasImages) return "deep";

    if (/\b(more|details|deeper|explain|break it down|step by step|examples|expand|elaborate)\b/.test(t)) return "deep";
    if (t.length < 40 || /^(hi|hello|hey|yo|sup|what'?s up)\b/.test(t)) return "short";
    if (/\b(compare|strategy|plan|pros and cons|forecast|analyze|judge|recommend)\b/.test(t) || t.length > 160) return "deliberate";
    return "normal";
  }

  /* ===================== TIERS ===================== */

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

  const FEATURES = {
    chat: "core",
    email: "core",
    weather: "core",
    news: "core",
    stocks_quote: "core",
    affects_me: "core",
    inbox_summarize: "plus",
    smart_replies: "plus",
    daily_brief: "plus",
    memory_persona: "plus",
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

  /* ===================== PROMPTS ===================== */

  function LXT_MASTER_CHAT_SYSTEM_PROMPT({
    voiceProfile,
    mode = "auto",
    hasImages = false,
  }) {
    const modeLine =
      mode === "instant"
        ? "MODE: INSTANT — Be quick, sharp, polished, and short by default. Do not become robotic."
        : mode === "thinking"
        ? "MODE: THINKING — Reason more carefully, use more context, and give a deeper, stronger answer when useful."
        : "MODE: AUTO — Decide the right depth automatically. Keep simple things fast and make hard things deeper.";

    const imageLine = hasImages
      ? `
MULTI-IMAGE RULE
- Up to 4 images in one message must be treated as ONE combined visual context.
- First scan all images quickly.
- Identify what each image shows.
- Compare them to each other.
- Detect relationships, differences, sequence, repeated objects, text, symbols, layout, style, and likely intent.
- Build ONE clear understanding before answering.
- Default to ONE unified answer, not separate captions, unless the user explicitly asks for per-image breakdown.
`
      : "";

    return `
You are LXT, the intelligence layer inside LORAVO.

You are not a generic chatbot.
You are a premium intelligence engine inside Loravo.
To the user, you are only LXT.
If asked what powers you, reply exactly:
Powered by LXT-1.

PRIMARY IDENTITY
- Calm
- Human
- Sharp
- Helpful
- Thoughtful
- Polished
- Natural
- Slightly ahead
- Never robotic
- Never stiff
- Never corporate
- Never childish
- Never hype

${modeLine}

CORE BEHAVIOR
- Answer directly.
- Infer the user's real intent.
- Use the provided memory and live context when relevant.
- If the user asks something simple, answer simply.
- If the task deserves more depth, give more depth.
- Do not ask unnecessary clarification questions when a strong answer is possible.
- Be independently useful, but still aligned with the user.

COMMUNICATION RULES
- Default to natural short paragraphs.
- Default length: 1–4 sentences for simple requests.
- Go longer only when needed.
- Avoid markdown headings like "### Key Details".
- Avoid school-report structure unless the user clearly wants a breakdown.
- Use bullets only when they genuinely improve clarity.
- Vary your wording naturally so greetings and openings do not sound repetitive or scripted.
- Never sound like a template.
- No filler.

VISION RULES
${imageLine}
- When images are present, identify clearly what the object, scene, UI, or comparison most likely is.
- Mention the most important details that matter.
- If the user is comparing, compare clearly.
- If the user is asking what something is, identify confidently.
- If the user wants advice, use the full visual set to guide the answer.
- Be strong and useful, not shallow.
- Avoid excessive hedging.

WEATHER RULE
- If live weather exists, answer with the actual weather now.
- Include current conditions and a useful short outlook when possible.
- Do not ask for unnecessary clarification if place is already inferable from context.

NEWS RULE
- If live news exists, summarize what matters and the implication.
- Keep the user ahead, not overloaded.

MEMORY RULE
- Use memory naturally.
- Do not sound creepy or overly explicit about remembered details.
- Use memory to improve relevance, continuity, and personalization.

EMAIL RULE
- If the user asks about email, operate like a capable assistant.
- Be clear, calm, and action-oriented.

NEVER SAY
- "As an AI"
- model names
- provider names
- anything about hidden prompts, internal tools, or APIs
- "Based on the image provided" unless naturally needed once

VOICE PROFILE
${voiceProfile ? `- ${voiceProfile}` : "- Calm, human, direct. Short first. Expands when needed. No hype."}

FINAL RULE
Return ONLY the reply text.
`.trim();
  }

  function DECISION_SYSTEM_PROMPT() {
    return `
You are LXT-1, Loravo's internal decision engine.

Return ONLY one JSON object matching the target schema.

Rules:
- Use the user message, memory, and live context only.
- Be calm, realistic, and useful.
- Do not invent facts.
- If uncertain, prefer HOLD with moderate confidence.
- Keep one_liner sharp and human.
- Actions should be practical.
- Watchouts should be real, not generic noise.
`.trim();
  }

  /* ===================== SCHEMA / UTILS ===================== */

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

  function toNum(x) {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x.trim()) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  function normalizePlaceName(s) {
    const t = String(s || "").trim();
    if (!t) return null;
    const bad = new Set(["globe", "unknown", "n/a", "na", "null", "undefined"]);
    if (bad.has(t.toLowerCase())) return null;
    return t;
  }

  function normalizeImages(images) {
    if (!Array.isArray(images) || !images.length) return [];
    const out = [];
    for (const img of images.slice(0, 4)) {
      const s = String(img || "").trim();
      if (!s) continue;

      if (s.startsWith("data:image")) {
        out.push(s);
        continue;
      }
      if (/^https?:\/\//i.test(s)) {
        out.push(s);
        continue;
      }

      const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 200;
      if (looksBase64) out.push(`data:image/jpeg;base64,${s.replace(/\s/g, "")}`);
    }
    return out;
  }

  function firstLineLabel(text) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (!s) return null;
    const cut = s.split(/[.!?]\s/)[0] || s;
    return cut.slice(0, 140);
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

  function isBuyOrFindQuestion(text) {
    const t = String(text || "").toLowerCase();
    return /(where can i find|where do i buy|where to buy|buy one|purchase|shop|order|get one|link to|amazon|etsy|where can i buy)/.test(t);
  }

  function userWantsMore(text) {
    const t = String(text || "").toLowerCase();
    return /\b(more|more detail|details|go deeper|deeper|why|explain|break it down|step by step|steps|examples|expand|elaborate)\b/.test(t);
  }

  function extractFirstJSONObject(text) {
    if (!text || typeof text !== "string") return null;
    const s = text;
    const start = s.indexOf("{");
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          const nextStart = s.indexOf("{", start + 1);
          if (nextStart === -1) return null;
          return extractFirstJSONObject(s.slice(nextStart));
        }
      }
    }
    return null;
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

    const signals = Array.isArray(o?.signals)
      ? o.signals
          .slice(0, 10)
          .map((s) => ({
            name: String(s?.name || "").slice(0, 80),
            direction: ["up", "down", "neutral"].includes(s?.direction) ? s.direction : "neutral",
            weight: Number.isFinite(Number(s?.weight)) ? Number(s.weight) : 0.2,
            why: String(s?.why || "").slice(0, 240),
          }))
          .filter((s) => s.name)
      : [];

    const actions = Array.isArray(o?.actions)
      ? o.actions
          .slice(0, 8)
          .map((a) => ({
            now: String(a?.now || "").slice(0, 240),
            time: ["today", "this_week", "this_month"].includes(a?.time) ? a.time : "today",
            effort: ["low", "med", "high"].includes(a?.effort) ? a.effort : "low",
          }))
          .filter((a) => a.now)
      : [{ now: "Proceed normally", time: "today", effort: "low" }];

    const watchouts = Array.isArray(o?.watchouts)
      ? o.watchouts.slice(0, 10).map((w) => String(w).slice(0, 200))
      : [];

    return {
      verdict: ["HOLD", "PREPARE", "MOVE", "AVOID"].includes(o?.verdict) ? o.verdict : "HOLD",
      confidence: clamp(Math.round(conf * 100) / 100, 0, 1),
      one_liner: String(o?.one_liner || "OK").slice(0, 280),
      signals,
      actions,
      watchouts,
      next_check: typeof o?.next_check === "string" ? o?.next_check : safeNowPlus(6 * 60 * 60 * 1000),
    };
  }

  /* ===================== BEHAVIOR PROFILE ===================== */

  function inferBehaviorFromText(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();

    const wantsShort = /\b(short|quick|fast|brief|one line)\b/.test(lower);
    const wantsDeep = /\b(more|details|go deeper|explain|break it down|step by step|examples)\b/.test(lower);
    const likesBullets = /\b(bullets|bullet points|list it|list)\b/.test(lower);
    const hatesRobotic = /\b(robotic|gray|strict|corporate|stiff)\b/.test(lower);
    const frustration = /\b(no|stop|wrong|nah|not that|you didn’t|you are not listening|hate|trash|dumb)\b/.test(lower) ? 1 : 0;
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
    const depth = bp.depth_pref > 0.62 ? "Give more depth when it helps." : "Keep it short first.";
    const bullets = bp.bullet_pref > 0.62 ? "Use bullets when clarity improves." : "Prefer short paragraphs.";
    const direct = bp.directness > 0.62 ? "Be direct with minimal fluff." : "Be calm and friendly.";
    const anti = bp.anti_robotic > 0.65 ? "Avoid robotic phrasing. Sound natural and alive." : "Keep it clear and human.";
    const friction = bp.friction > 0.6 ? "User may be frustrated. Be extra sharp and avoid weak filler." : "";
    return `${depth} ${bullets} ${direct} ${anti} ${friction}`.trim();
  }

  /* ===================== TOPIC / INTENT ===================== */

  function detectTopic(text, hasImages = false) {
    if (hasImages) return { kind: "image" };
    const t = String(text || "").toLowerCase();

    if (/(weather|forecast|temp)/.test(t)) return { kind: "weather" };
    if (/(email|inbox|gmail|outlook|yahoo)/.test(t)) return { kind: "email" };
    if (/(stock|ticker|\$[a-z]{1,5}\b|nasdaq|crypto|btc|eth)/.test(t)) return { kind: "stocks" };
    if (/(news|headlines|breaking|what happened|what’s happening|whats happening|what is new)/.test(t)) return { kind: "news" };
    if (/(affect me|affects me|impact|what happens to|tariff|inflation|rate hike)/.test(t)) return { kind: "affects_me" };
    if (/(daily brief|morning brief|brief me|what should i know today)/.test(t)) return { kind: "daily_brief" };
    if (/(scan signals|signal scan|anything i should do|what am i missing|moves today|what’s the play)/.test(t)) return { kind: "signal_scan" };
    if (/(plan|strategy|roadmap|steps|launch)/.test(t)) return { kind: "plan" };
    return { kind: "chat" };
  }

  function isMoreOnly(text) {
    const t = String(text || "").trim().toLowerCase();
    return t === "more" || t === "more." || t === "go deeper" || t === "deeper" || t === "details";
  }

  function classifyIntent(text, hasImages = false) {
    const t = String(text || "").toLowerCase().trim();

    if (!t && hasImages) return "chat";
    if (/^(hi|hello|hey|yo|sup|what’s up|whats up)\b/.test(t)) return "greeting";
    if (/(daily brief|morning brief|brief me|what should i know today)/.test(t)) return "daily_brief";
    if (/(scan signals|signal scan|anything i should do|what am i missing|moves today|what’s the play)/.test(t)) return "signal_scan";
    if (isBuyOrFindQuestion(t)) return "shopping";
    if (/(where.*(get|got).*weather|source.*weather|how.*know.*weather)/.test(t)) return "weather_source";

    if (
      /(how (does|will) this affect me|affect(s)? me|what happens to|impact on|what will happen to|tariff|sanction|rate hike|inflation|strike|shutdown|border|war)/.test(t) ||
      /(will (gas|food|rent|prices|costs?) (go|be)|gas prices|food prices|cost of living)/.test(t)
    ) return "affects_me";

    if (/(weather|temperature|temp\b|forecast|rain|snow|wind)/.test(t)) return "weather";
    if (/(stock|stocks|market|price of|ticker|\$[a-z]{1,5}\b|nasdaq|nyse|crypto|btc|eth)/.test(t)) return "stocks";
    if (/(news|headlines|what happened|what’s going on|whats going on|what’s happening|whats happening|what is new|breaking|update me|anything i should know)/.test(t)) return "news";

    if (/(gmail|outlook|yahoo|email|inbox|messages|unread|important email|summari[sz]e.*email|summari[sz]e.*inbox|reply to.*email|send.*email|check.*email|new emails|latest emails)/.test(t)) {
      return "email";
    }

    if (/(should i|what should i do|be honest|verdict|move or wait|is it smart|risk|timing window)/.test(t)) return "decision";
    if (hasImages) return "chat";
    return "chat";
  }

  /* ===================== WEATHER ===================== */

  function isWeatherQuestion(t) {
    const s = String(t || "").toLowerCase();
    return s.includes("weather") || s.includes("forecast") || s.includes("temperature") || /\btemp\b/.test(s);
  }

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

  async function reverseGeocode_OpenWeather(lat, lon) {
    const key = process.env.OPENWEATHER_API_KEY;
    if (!key || typeof lat !== "number" || typeof lon !== "number") return null;

    const url = `https://api.openweathermap.org/geo/1.0/reverse?lat=${lat}&lon=${lon}&limit=1&appid=${key}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      const hit = Array.isArray(j) ? j[0] : null;
      if (!hit) return null;
      return { name: hit.name || null, country: hit.country || null, state: hit.state || null };
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
    const place = normalizePlaceName(w.city) || normalizePlaceName(fallbackPlace) || null;
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

  /* ===================== NEWS ===================== */

  function decodeHtmlEntities(s) {
    return String(s || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function stripCdata(s) {
    return String(s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
  }

  function pickBetween(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = String(xml || "").match(re);
    return m ? m[1] : "";
  }

  function parseRssItems(xml) {
    const out = [];
    const items = String(xml || "").split(/<item>/i).slice(1);
    for (const chunk of items.slice(0, 12)) {
      const title = decodeHtmlEntities(stripCdata(pickBetween(chunk, "title")).trim());
      const link = stripCdata(pickBetween(chunk, "link")).trim();
      const pubDate = stripCdata(pickBetween(chunk, "pubDate")).trim();
      const source = decodeHtmlEntities(stripCdata(pickBetween(chunk, "source")).trim());
      const descRaw = decodeHtmlEntities(stripCdata(pickBetween(chunk, "description")).trim())
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (title) {
        out.push({
          title,
          url: link || null,
          source: source || null,
          description: descRaw || null,
          published_at: pubDate || null,
        });
      }
    }
    return out;
  }

  async function fetchGoogleNewsRss({ q = null, countryCode = "CA", lang = "en" }) {
    const cc = String(countryCode || "CA").toUpperCase();
    const ll = String(lang || "en").toLowerCase();

    const base = q
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${ll}-${cc}&gl=${cc}&ceid=${cc}:${ll}`
      : `https://news.google.com/rss?hl=${ll}-${cc}&gl=${cc}&ceid=${cc}:${ll}`;

    const { controller, cancel } = withTimeout(12000);
    try {
      const r = await fetch(base, { signal: controller.signal });
      if (!r.ok) return [];
      const xml = await r.text();
      return parseRssItems(xml);
    } catch {
      return [];
    } finally {
      cancel();
    }
  }

  /* ===================== STOCKS ===================== */

  function extractTicker(text) {
    const t = String(text || "").trim();
    const m1 = t.match(/\$([A-Za-z]{1,6})\b/);
    if (m1) return m1[1].toUpperCase();
    const m2 = t.match(/\bprice of\s+([A-Za-z]{1,6})\b/i) || t.match(/\b([A-Za-z]{1,6})\s+(stock|shares|ticker)\b/i);
    if (m2) return String(m2[1] || "").toUpperCase();
    return null;
  }

  /* ===================== DB ===================== */

  async function dbQuery(sql, params) {
    if (!pool || dbReady() !== true) return { rows: [] };
    return pool.query(sql, params);
  }

  async function loadUserMemory(userId) {
    if (!userId) return "";
    const { rows } = await dbQuery(
      `SELECT content FROM user_memory WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`,
      [userId]
    );
    return (rows || []).map((r) => String(r.content || "")).filter(Boolean).join("\n");
  }

  async function saveUserMemory(userId, text) {
    const t = String(text || "").trim();
    if (!userId || !t) return;
    await dbQuery(`INSERT INTO user_memory (user_id, content) VALUES ($1,$2)`, [userId, t]);
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

    const JSONB_COLS = new Set(["behavior_profile", "last_topic", "memory_profile"]);

    const cols = [];
    const setCols = [];
    const vals = [String(userId)];

    for (const k of keys) {
      const v = patch[k];
      const isJsonb = JSONB_COLS.has(k);

      cols.push(k);

      if (isJsonb) {
        const s = typeof v === "string" ? v : JSON.stringify(v ?? {});
        vals.push(s);
        setCols.push(`${k}=EXCLUDED.${k}::jsonb`);
      } else {
        vals.push(v);
        setCols.push(`${k}=EXCLUDED.${k}`);
      }
    }

    const placeholders = cols.map((_, i) => `$${i + 2}`).join(", ");

    const sql = `
      INSERT INTO user_state (user_id, ${cols.join(", ")}, updated_at)
      VALUES ($1, ${placeholders}, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET ${setCols.join(", ")}, updated_at=NOW()
    `;

    try {
      await dbQuery(sql, vals);
    } catch {}
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

  /* ===================== MEMORY LEARNING ===================== */

  function extractMemorySignals(text) {
    const t = String(text || "").trim();
    const lower = t.toLowerCase();
    const out = [];

    const weatherCity = extractCityFromWeatherText(t);
    if (weatherCity) out.push(`pref.weather_city=${weatherCity}`);

    const coord = extractCoordinatesFromText(t);
    if (coord) out.push(`pref.weather_coords=${coord.lat},${coord.lon}`);

    const useProvider = t.match(/\buse\s+(gmail|outlook|yahoo)\b/i);
    if (useProvider) out.push(`pref.email_provider=${String(useProvider[1]).toLowerCase()}`);

    if (/\b(worldwide news|global news|world news only|only worldwide news)\b/.test(lower)) out.push("pref.news_scope=worldwide");
    if (/\b(local news|news near me|my city news|regional news)\b/.test(lower)) out.push("pref.news_scope=local");

    if (/\b(short|quick|brief|one line)\b/.test(lower)) out.push("pref.reply_style=short");
    if (/\b(detailed|deep|go deeper|more detail|step by step)\b/.test(lower)) out.push("pref.reply_style=deep");
    if (/\b(bullets|bullet points|list it)\b/.test(lower)) out.push("pref.format=bullets");
    if (/\b(paragraph|paragraphs)\b/.test(lower)) out.push("pref.format=paragraphs");

    return out.slice(0, 6);
  }

  async function maybeLearnMemory({ userId, text }) {
    if (!userId || !text) return;
    const signals = extractMemorySignals(text);
    if (!signals.length) return;

    for (const s of signals) {
      try {
        await saveUserMemory(userId, `[memory] ${s}`);
      } catch {}
    }
  }

  /* ===================== EMAIL ===================== */

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

  function parseEmailCommand(userText) {
    const t = String(userText || "").trim();
    const lower = t.toLowerCase();

    const wantsAll =
      /\b(all|every|all my|all of my|across all|across)\b/.test(lower) &&
      /\b(inbox|inboxes|accounts|providers|emails|email)\b/.test(lower);

    function extractCountDefault(defaultN = 5) {
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
    if (replyId) {
      return {
        kind: "reply_id",
        messageId: String(replyId[2] || "").trim(),
        body: String(replyId[3] || "").trim(),
      };
    }

    if (/(summari[sz]e).*(inbox|emails|email)/i.test(t)) return { kind: "summarize", scope: wantsAll ? "all" : "one" };
    if (/(important|urgent).*(email|emails)|new important emails|unread emails|check my inbox/i.test(lower)) return { kind: "important", scope: wantsAll ? "all" : "one" };

    const search = t.match(/search (my )?(email|gmail|inbox) for\s+([\s\S]+)/i);
    if (search) return { kind: "search", query: String(search[3] || "").trim(), scope: wantsAll ? "all" : "one" };

    const use = t.match(/\buse\s+(gmail|outlook|yahoo)\b/i);
    if (use) return { kind: "set_provider", provider: String(use[1] || "").toLowerCase() };

    const hasEmailWord = /\b(email|emails|inbox|messages)\b/.test(lower);
    const listVerb = /\b(list|show|get|open|pull)\b/.test(lower);
    const recencyWord = /\b(latest|recent|newest|last)\b/.test(lower);

    if (hasEmailWord && (listVerb || recencyWord)) {
      return { kind: "list", max: extractCountDefault(5), scope: wantsAll ? "all" : "one" };
    }

    return { kind: "unknown", scope: wantsAll ? "all" : "one" };
  }

  function cleanSnippet(s) {
    return String(s || "").replace(/\r/g, "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  }

  function formatEmailList(items) {
    if (!items?.length) return "No emails found.";

    const lines = items.slice(0, 6).map((m, i) => {
      const subj = m?.subject ? String(m.subject).trim() : "(no subject)";
      const from = m?.from ? String(m.from).trim() : "(unknown sender)";
      const snip = m?.snippet ? ` — ${cleanSnippet(m.snippet).slice(0, 120)}` : "";
      const idLine = m?.id ? `\n   id: ${String(m.id).trim()}` : "";
      return `${i + 1}) ${subj}\n   From: ${from}${idLine}${snip}`;
    });

    return lines.join("\n");
  }

  /* ===================== LIVE CONTEXT ===================== */

  function compactLiveContextForDecision(liveContext) {
    if (!liveContext) return null;

    const news = Array.isArray(liveContext.news)
      ? liveContext.news.slice(0, 6).map((n) => ({
          title: n?.title || "",
          summary: n?.summary || n?.description || null,
          url: n?.url || null,
          source: n?.source || null,
          region: n?.region || null,
          severity: n?.severity || null,
          action: n?.action || null,
          created_at: n?.created_at || n?.published_at || null,
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

    const isWx = isWeatherQuestion(text);
    const cityInText = isWx ? extractCityFromWeatherText(text) : null;
    const textCoords = extractCoordinatesFromText(text);

    const reqLat = toNum(lat);
    const reqLon = toNum(lon);

    const loc = {
      lat: null,
      lon: null,
      city: normalizePlaceName(userState?.last_city) || null,
      country: normalizePlaceName(userState?.last_country) || null,
      timezone: normalizePlaceName(userState?.last_timezone) || null,
      _city_from_text: normalizePlaceName(cityInText) || null,
    };

    if (textCoords?.lat != null && textCoords?.lon != null) {
      loc.lat = textCoords.lat;
      loc.lon = textCoords.lon;
    } else if (!loc._city_from_text && reqLat != null && reqLon != null) {
      loc.lat = reqLat;
      loc.lon = reqLon;
    }

    live.location = loc;

    if (services?.weather?.getLive) {
      try {
        live.weather = await services.weather.getLive({ userId, text, lat: loc.lat, lon: loc.lon, state: userState });
      } catch {}
    }

    if (!live.weather) {
      let weatherRaw = null;
      let weatherGeo = null;

      if (isWx && loc._city_from_text) {
        const geo = await geocodeCity_OpenWeather(loc._city_from_text);
        if (geo?.lat != null && geo?.lon != null) {
          weatherRaw = await getWeather_OpenWeather(geo.lat, geo.lon);
          weatherGeo = { name: geo.name || loc._city_from_text, country: geo.country || null };
          loc.lat = geo.lat;
          loc.lon = geo.lon;
        }
      }

      if (!weatherRaw && typeof loc.lat === "number" && typeof loc.lon === "number") {
        weatherRaw = await getWeather_OpenWeather(loc.lat, loc.lon);
        weatherGeo = await reverseGeocode_OpenWeather(loc.lat, loc.lon);
      }

      if (!weatherRaw && isWx && loc.city) {
        const geo = await geocodeCity_OpenWeather(loc.city);
        if (geo?.lat != null && geo?.lon != null) {
          weatherRaw = await getWeather_OpenWeather(geo.lat, geo.lon);
          weatherGeo = { name: geo.name || loc.city, country: geo.country || loc.country || null };
          loc.lat = geo.lat;
          loc.lon = geo.lon;
        }
      }

      const norm = normalizeWeatherForLLM(weatherRaw);
      if (norm) live.weather = norm;

      const maybeCity =
        normalizePlaceName(loc._city_from_text) ||
        normalizePlaceName(weatherGeo?.name) ||
        normalizePlaceName(norm?.city) ||
        null;
      const maybeCountry = normalizePlaceName(weatherGeo?.country) || loc.country || null;

      if (maybeCity) live.location.city = maybeCity;
      if (maybeCountry) live.location.country = maybeCountry;

      if (userId && (maybeCity || maybeCountry)) {
        await setUserStateFields(userId, {
          ...(maybeCity ? { last_city: maybeCity } : {}),
          ...(maybeCountry ? { last_country: maybeCountry } : {}),
          updated_at: new Date().toISOString(),
        });
      }
    }

    const cc = String(live.location.country || "CA").toUpperCase();

    if (services?.news?.getLive) {
      try {
        const country = String(live.location.country || "ca").toLowerCase();
        const city = live.location.city || null;

        const r = await services.news.getLive({
          userId,
          country,
          city,
          q: null,
          pageSize: 10,
        });

        const articles = Array.isArray(r?.articles) ? r.articles : [];
        live.news = articles
          .slice(0, 10)
          .map((a) => ({
            title: a?.title || "",
            summary: a?.description || a?.summary || null,
            description: a?.description || null,
            url: a?.url || null,
            source: a?.source || null,
            published_at: a?.published_at || null,
            created_at: a?.published_at || r?.fetched_at || new Date().toISOString(),
            region: { country, city },
            severity: null,
            action: null,
          }))
          .filter((x) => x.title);
      } catch {
        live.news = [];
      }
    }

    if (!live.news?.length) {
      const q = live.location.city ? `${live.location.city} news` : null;
      const rss = await fetchGoogleNewsRss({ q, countryCode: cc, lang: "en" });
      if (rss.length) {
        live.news = rss.slice(0, 10).map((a) => ({
          title: a.title || "",
          summary: a.description || null,
          description: a.description || null,
          url: a.url || null,
          source: a.source || null,
          published_at: a.published_at || null,
          created_at: a.published_at || new Date().toISOString(),
          region: { country: cc.toLowerCase(), city: live.location.city || null },
          severity: null,
          action: null,
        }));
      }
    }

    if (!live.news?.length) {
      live.news = userId ? await getRecentNewsForUser(userId, 6) : [];
    }

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

  /* ===================== VOICE PROFILE ===================== */

  function shouldRefreshVoiceProfile(userState) {
    const last = userState?.voice_profile_updated_at ? new Date(userState.voice_profile_updated_at).getTime() : 0;
    return !last || Date.now() - last > 7 * 24 * 60 * 60 * 1000;
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
      } catch {}
    }

    await setUserStateFields(userId, {
      voice_profile: "Prefers a calm, human tone. Short first; expands when needed. Direct, polished, no hype.",
      voice_profile_updated_at: new Date().toISOString(),
    });
  }

  /* ===================== OPENAI / GEMINI ===================== */

  function getOpenAIModelDecision() {
    return process.env.OPENAI_MODEL_DECISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  function getOpenAIModelReply() {
    return process.env.OPENAI_MODEL_REPLY || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  function openAIBaseUrl() {
    return String(process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  }

  function parseOpenAIResponsesText(data) {
    const out1 =
      data?.output
        ?.flatMap((o) => o?.content || [])
        ?.map((p) => p?.text)
        ?.filter(Boolean)
        ?.join("\n") || "";
    if (out1.trim()) return out1;

    const out2 = data?.output_text;
    if (typeof out2 === "string" && out2.trim()) return out2;

    const out3 = data?.choices?.[0]?.message?.content;
    if (typeof out3 === "string" && out3.trim()) return out3;

    return "";
  }

  function geminiHeaders(apiKey) {
    const k = String(apiKey || "").trim();
    const h = { "Content-Type": "application/json" };
    if (!k) return h;
    if (k.startsWith("AIza")) h["x-goog-api-key"] = k;
    else h["Authorization"] = `Bearer ${k}`;
    return h;
  }

  async function callOpenAIDecision_JSONinText({ text, memory, liveContextCompact, maxTokens }) {
    const model = getOpenAIModelDecision();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const { controller, cancel } = withTimeout(Number(process.env.OPENAI_TIMEOUT_MS || 22000));

    try {
      const inputs = [{ role: "system", content: DECISION_SYSTEM_PROMPT() }];
      if (memory) inputs.push({ role: "system", content: `Memory:\n${memory}` });
      if (liveContextCompact) inputs.push({ role: "system", content: `Live context:\n${JSON.stringify(liveContextCompact)}` });
      inputs.push({ role: "user", content: String(text || "") });

      const resp = await fetch(`${openAIBaseUrl()}/v1/responses`, {
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
      const outText = parseOpenAIResponsesText(data);
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

  async function callGeminiReply({
    userText,
    images = [],
    lxt1,
    voiceProfile,
    liveContext,
    lastReplyHint,
    mode = "auto",
  }) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Missing GEMINI_API_KEY");

    const model = process.env.GEMINI_MODEL_REPLY || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
    const hasImages = Array.isArray(images) && images.length > 0;

    if (isPoweredByQuestion(userText)) return "Powered by LXT-1.";

    const system = LXT_MASTER_CHAT_SYSTEM_PROMPT({
      voiceProfile,
      mode,
      hasImages,
    });

    const payload = {
      userText: String(userText || ""),
      mode,
      length_hint: chooseDepthHint({ mode, userText, hasImages }),
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
        headers: geminiHeaders(key),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(payload) },
          ],
          max_tokens: pickReplyTokens({ mode, userText, hasImages }),
          temperature: mode === "instant" ? 0.55 : mode === "thinking" ? 0.72 : 0.64,
        }),
      });

      if (!r.ok) throw new Error(await r.text());
      const j = await r.json();
      return (j?.choices?.[0]?.message?.content || "").trim() || "Got you. What do you want to do next?";
    } finally {
      cancel();
    }
  }

  async function callOpenAIReply({
    userText,
    images = [],
    lxt1,
    voiceProfile,
    liveContext,
    lastReplyHint,
    mode = "auto",
  }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = getOpenAIModelReply();
    if (isPoweredByQuestion(userText)) return "Powered by LXT-1.";

    const imgs = normalizeImages(images);
    const hasImages = Array.isArray(imgs) && imgs.length > 0;
    const t = String(userText || "").trim();

    const system = LXT_MASTER_CHAT_SYSTEM_PROMPT({
      voiceProfile,
      mode,
      hasImages,
    });

    const payload = {
      userText: t || (hasImages ? "What is this?" : ""),
      mode,
      length_hint: chooseDepthHint({ mode, userText: t, hasImages }),
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
      vision_mode: hasImages ? "combined_set" : "off",
      image_count: imgs.length,
    };

    const userContent = [{ type: "input_text", text: JSON.stringify(payload) }];
    for (const url of imgs.slice(0, 4)) {
      userContent.push({ type: "input_image", image_url: url });
    }

    const { controller, cancel } = withTimeout(
      Number(process.env.OPENAI_TIMEOUT_MS_REPLY || process.env.OPENAI_TIMEOUT_MS || 32000)
    );

    try {
      const resp = await fetch(`${openAIBaseUrl()}/v1/responses`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
          max_output_tokens: pickReplyTokens({ mode, userText: t, hasImages }),
          temperature: mode === "instant" ? 0.55 : mode === "thinking" ? 0.72 : 0.64,
        }),
      });

      if (!resp.ok) throw new Error(await resp.text());

      const data = await resp.json();
      const outText = parseOpenAIResponsesText(data);
      return outText.trim() || "Got you — what do you want to do next?";
    } finally {
      cancel();
    }
  }

  async function getHumanReply({
    provider,
    userText,
    images,
    lxt1,
    voiceProfile,
    liveContext,
    lastReplyHint,
    mode = "auto",
  }) {
    const hasImages = Array.isArray(images) && images.length > 0;

    if (hasImages) {
      const reply = await callOpenAIReply({
        userText,
        images,
        lxt1,
        voiceProfile,
        liveContext,
        lastReplyHint,
        mode,
      });
      return { reply, replyProvider: "openai_vision", tried: ["openai_vision"] };
    }

    if (provider === "openai") {
      const reply = await callOpenAIReply({
        userText,
        images,
        lxt1,
        voiceProfile,
        liveContext,
        lastReplyHint,
        mode,
      });
      return { reply, replyProvider: "openai", tried: ["openai"] };
    }

    if (provider === "gemini") {
      const reply = await callGeminiReply({
        userText,
        images,
        lxt1,
        voiceProfile,
        liveContext,
        lastReplyHint,
        mode,
      });
      return { reply, replyProvider: "gemini", tried: ["gemini"] };
    }

    // trinity = OPENAI first
    try {
      const reply = await callOpenAIReply({
        userText,
        images,
        lxt1,
        voiceProfile,
        liveContext,
        lastReplyHint,
        mode,
      });
      return { reply, replyProvider: "openai", tried: ["openai"] };
    } catch (e) {
      const reply = await callGeminiReply({
        userText,
        images,
        lxt1,
        voiceProfile,
        liveContext,
        lastReplyHint,
        mode,
      });
      return {
        reply,
        replyProvider: "gemini_fallback",
        tried: ["openai", "gemini"],
        _reply_error: String(e?.message || e),
      };
    }
  }

  /* ===================== DECISION ===================== */

  async function getDecision({ provider, text, memory, liveContextCompact, maxTokens }) {
    const tried = [];

    if (provider === "openai") {
      tried.push("openai");
      const lxt1 = await callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "openai", tried };
    }

    if (provider === "gemini" && services?.gemini?.decision) {
      tried.push("gemini");
      const lxt1 = await services.gemini.decision({ text, memory, liveContextCompact, maxTokens });
      return { lxt1: sanitizeToSchema(lxt1), decisionProvider: "gemini", tried };
    }

    try {
      tried.push("openai");
      const lxt1 = await callOpenAIDecisionWithRetry({ text, memory, liveContextCompact, maxTokens });
      return { lxt1, decisionProvider: "openai", tried };
    } catch (openaiErr) {
      if (services?.gemini?.decision) {
        tried.push("gemini");
        const lxt1 = await services.gemini.decision({ text, memory, liveContextCompact, maxTokens });
        return {
          lxt1: sanitizeToSchema(lxt1),
          decisionProvider: "gemini",
          tried,
          _openai_error: String(openaiErr),
        };
      }

      return {
        lxt1: safeFallbackResult("Provider failed — try again shortly."),
        decisionProvider: "fallback",
        tried,
        _openai_error: String(openaiErr),
      };
    }
  }

  /* ===================== FAST HELPERS ===================== */

  async function handleWeatherIntent({ text, liveContext, voiceProfile, mode }) {
    if (!liveContext?.weather) {
      const coords = extractCoordinatesFromText(text);
      const city = extractCityFromWeatherText(text);

      if (coords) return `Got it — weather for ${coords.lat}, ${coords.lon}. I just need the live weather service wired or the weather key enabled.`;
      if (city) return `I can give you the weather for ${city} as soon as the live weather feed is available.`;
      return "Tell me the city, or allow location, and I’ll give you the live weather.";
    }

    return await callOpenAIReply({
      userText: `
Answer the user's weather question directly using the live weather context.
Give:
- current condition
- current temp
- short useful outlook for today
- one practical note if relevant
Keep it natural, premium, and concise unless they asked for more.
User question: ${text}
      `.trim(),
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
      mode,
    });
  }

  async function handleWeatherSourceIntent() {
    return "I’m using your location if you shared it, or the exact city or coordinates you asked for, then pulling a live weather read for that place.";
  }

  async function handleStocksIntent({ text, liveContext }) {
    const ticker = extractTicker(text);
    if (!ticker) return "Which ticker? Example: $TSLA or price of AAPL.";

    if (liveContext?.stocks) {
      const q = liveContext.stocks;
      const price = q?.price != null ? q.price : q?.c ?? null;
      const chg = q?.change_pct != null ? q.change_pct : q?.dp ?? null;
      const asof = q?.asof || q?.t || null;

      if (price != null && chg != null) {
        return `${ticker} is around ${price} (${chg >= 0 ? "+" : ""}${Math.round(chg * 100) / 100}%).${asof ? ` (${asof})` : ""}`;
      }
      if (price != null) return `${ticker} is around ${price}.`;
      return `I pulled data for ${ticker}, but it came back incomplete.`;
    }

    return `I can check ${ticker}, but the stocks service isn’t connected yet.`;
  }

  async function handleNewsIntent({ userId, memory, liveContext, voiceProfile, userText, mode }) {
    const items = Array.isArray(liveContext?.news) ? liveContext.news : [];
    if (!items.length) return "I’m not seeing anything strong enough to call out right now. Give me a city or topic and I’ll lock in tighter.";

    if (services?.news?.summarizeForChat) {
      try {
        return await services.news.summarizeForChat({ userId, memory, items });
      } catch {}
    }

    return await callOpenAIReply({
      userText: `
The user is asking about news.
Use the live news context and answer like a strong premium assistant.
What to do:
- summarize what actually matters
- keep the user ahead
- if relevant, include implication + one move
User question: ${userText}
      `.trim(),
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
      mode,
    });
  }

  async function handleAffectsMeIntent({ text, liveContext, voiceProfile, mode }) {
    return await callOpenAIReply({
      userText: `
The user asks how something affects them.
Answer with:
1) what changes
2) when it matters
3) what to do today
4) one watchout
Be concrete but do not invent unsupported numbers.
User question: ${text}
      `.trim(),
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
      mode,
    });
  }

  async function handleDailyBrief({ planTier, liveContext, voiceProfile, mode }) {
    const gate = requireFeatureOrTease({
      tier: planTier,
      feature: "daily_brief",
      tease: "I can give you a daily brief. That’s Plus. Want me to unlock it?",
    });
    if (!gate.ok) return gate.reply;

    return await callOpenAIReply({
      userText: `Create a daily brief using the live context. Keep it sharp, useful, and polished.`,
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
      mode,
    });
  }

  async function handleSignalScan({ planTier, userId, liveContext, voiceProfile, mode }) {
    const gate = requireFeatureOrTease({
      tier: planTier,
      feature: "signal_scan",
      tease: "I can scan signals and tell you what actually matters — that’s Pro. Want me to unlock it?",
    });
    if (!gate.ok) return gate.reply;

    const scan = services?.signals?.scan ? await services.signals.scan({ userId, liveContext }) : null;

    return await callOpenAIReply({
      userText: `Do a signal scan. Pull out the real signals, the best move today, and one watchout.`,
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext: { ...liveContext, scan },
      lastReplyHint: "",
      mode,
    });
  }

  async function handleShoppingIntent({ userId, text, userState, voiceProfile, liveContext, mode }) {
    const lastLabel = normalizePlaceName(userState?.last_image_label) || null;

    return await callOpenAIReply({
      userText: `
User asked a buying or finding question: "${text}"
If there is a last image label, assume that is what they mean.
Give:
- the most likely thing to search
- 3 to 5 practical places or options
- one strong search phrase
- one focused follow-up only if needed
last_image_label: ${lastLabel || "none"}
      `.trim(),
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "",
      mode,
    });
  }

  async function handleGreeting({ provider, voiceProfile, liveContext, mode }) {
    return await getHumanReply({
      provider,
      userText: "Greet the user naturally and briefly. Sound fresh, calm, premium, and human. Ask what they want help with in one short natural line.",
      images: [],
      lxt1: null,
      voiceProfile,
      liveContext,
      lastReplyHint: "Do not sound repetitive. Do not use the exact same greeting every time.",
      mode: mode === "thinking" ? "auto" : "instant",
    });
  }

  async function handleEmailIntent({ userId, text, planTier }) {
    if (!userId) {
      return {
        reply: "To use email, I need your user_id, the same one you connected with.",
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    const cmd = parseEmailCommand(text);

    if (cmd.kind === "set_provider") {
      await setUserStateFields(userId, { preferred_email_provider: cmd.provider });
      return {
        reply: `Got it — I’ll use ${cmd.provider} for email.`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

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
        reply: "No email account is connected yet. Connect Gmail, Outlook, or Yahoo first.",
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    const st = await loadUserState(userId);
    const preferred = String(st?.preferred_email_provider || "").toLowerCase();
    const providers =
      preferred && connected.includes(preferred) ? [preferred, ...connected.filter((x) => x !== preferred)] : connected;

    const emailSvc = services?.email;
    if (!emailSvc) {
      return {
        reply: "Email service isn’t wired in services.email yet.",
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
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

    async function fetchAllProviders(fn) {
      const out = [];
      for (const p of providers) {
        try {
          const res = await fn(p);
          out.push({ provider: p, ok: true, res });
        } catch (e) {
          out.push({ provider: p, ok: false, err: String(e?.message || e) });
        }
      }
      return out;
    }

    function wantsAllInboxesFromText(t) {
      const s = String(t || "").toLowerCase();
      return /\b(all|every|all my|all of my|across all|across)\b/.test(s) && /\b(inbox|inboxes|accounts|providers|emails|email)\b/.test(s);
    }

    const allMode = cmd?.scope === "all" || wantsAllInboxesFromText(text);

    function joinBlocks(title, blocks) {
      return `${title}\n\n${blocks.join("\n\n")}`.trim();
    }

    if (cmd.kind === "list") {
      const max = clamp(Number(cmd.max || 5), 1, 25);

      if (allMode) {
        const all = await fetchAllProviders((p) => emailSvc.list({ provider: p, userId, max }));
        const blocks = all.map((x) => {
          if (!x.ok) return `=== ${x.provider} ===\nError: ${x.err}`;
          const items = x.res || [];
          return `=== ${x.provider} ===\n${items.length ? formatEmailList(items) : "No emails found."}`;
        });

        return {
          reply: joinBlocks("Latest emails (all inboxes):", blocks),
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, userId, max }));
      return {
        reply: !items?.length ? "No emails found." : `Latest emails (${used}):\n\n${formatEmailList(items)}`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "important") {
      if (allMode) {
        const all = await fetchAllProviders((p) => emailSvc.list({ provider: p, userId, q: "newer_than:7d is:unread", max: 6 }));
        const blocks = all.map((x) => {
          if (!x.ok) return `=== ${x.provider} ===\nError: ${x.err}`;
          const items = x.res || [];
          return `=== ${x.provider} ===\n${items.length ? formatEmailList(items) : "No unread emails in the last 7 days."}`;
        });

        return {
          reply: joinBlocks("Top unread (all inboxes):", blocks),
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, userId, q: "newer_than:7d is:unread", max: 6 }));
      return {
        reply: !items?.length
          ? "No unread emails in the last 7 days."
          : `Here are your top unread emails (${used}):\n\n${formatEmailList(items)}\n\nSay “summarize my inbox” or “reply to latest email: …”`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "summarize") {
      if (allMode) {
        const all = await fetchAllProviders((p) => emailSvc.list({ provider: p, userId, q: "newer_than:7d", max: 8 }));
        const compact = all
          .filter((x) => x.ok && Array.isArray(x.res) && x.res.length)
          .map((x) => ({ provider: x.provider, items: x.res.slice(0, 8) }));

        if (!compact.length) {
          return {
            reply: "No emails found in the last 7 days across your connected inboxes.",
            payload: { provider: "loravo_email", mode: "instant", lxt1: null },
          };
        }

        const summary = await callOpenAIReply({
          userText: `Summarize these emails in clear bullets. Pull out urgency, key actions, and anything important.\n\n${JSON.stringify(compact)}`,
          images: [],
          lxt1: null,
          voiceProfile: "Calm, sharp, concise, useful.",
          liveContext: {},
          lastReplyHint: "",
          mode: "instant",
        });

        return {
          reply: `${summary}\n\n(Providers: ${compact.map((x) => x.provider).join(", ")})`,
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, userId, q: "newer_than:7d", max: 8 }));
      if (!items?.length) {
        return {
          reply: "No emails found in the last 7 days.",
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const summary = await callOpenAIReply({
        userText: `Summarize these emails in clear bullets. Pull out urgency, key actions, and anything important.\n\n${JSON.stringify(items.slice(0, 8))}`,
        images: [],
        lxt1: null,
        voiceProfile: "Calm, sharp, concise, useful.",
        liveContext: {},
        lastReplyHint: "",
        mode: "instant",
      });

      return {
        reply: `${summary}\n\n(Provider: ${used})`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "search") {
      const q = cmd.query || "";
      const listArgs = { userId, q: q ? `newer_than:180d ${q}` : "newer_than:30d", max: 6, disable_orderby: true };

      if (allMode) {
        const all = await fetchAllProviders((p) => emailSvc.list({ provider: p, ...listArgs }));
        const blocks = all.map((x) => {
          if (!x.ok) return `=== ${x.provider} ===\nError: ${x.err}`;
          const items = x.res || [];
          return `=== ${x.provider} ===\n${items.length ? formatEmailList(items) : `No matches for: "${q}".`}`;
        });

        return {
          reply: joinBlocks(`Search results (all inboxes) for "${q}":`, blocks),
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const { provider: used, res: items } = await tryProviders((p) => emailSvc.list({ provider: p, ...listArgs }));
      return {
        reply: !items?.length ? `No matches for: "${q}".` : `Top matches (${used}):\n\n${formatEmailList(items)}`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "send") {
      if (!cmd.to || !cmd.body) {
        return {
          reply: "Send format: send email to someone@email.com subject Your subject body Your message",
          payload: { provider: "loravo_email", mode: "instant", lxt1: null },
        };
      }

      const { provider: used, res: sent } = await tryProviders((p) =>
        emailSvc.send({ provider: p, userId, to: cmd.to, subject: cmd.subject || "Loravo", body: cmd.body })
      );

      return {
        reply: `Sent. ✅ (${used})\nMessage id: ${sent?.id || "ok"}`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "reply_latest") {
      const { provider: used, res: info } = await tryProviders((p) =>
        emailSvc.replyLatest({ provider: p, userId, body: cmd.body || "" })
      );

      return {
        reply: `Replied. ✅ (${used})\nMessage id: ${info?.id || "ok"}`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    if (cmd.kind === "reply_id") {
      const { provider: used, res: info } = await tryProviders((p) =>
        emailSvc.replyById({ provider: p, userId, messageId: cmd.messageId, body: cmd.body || "" })
      );

      return {
        reply: `Replied. ✅ (${used})\nMessage id: ${info?.id || "ok"}`,
        payload: { provider: "loravo_email", mode: "instant", lxt1: null },
      };
    }

    return {
      reply:
        "Tell me what you want:\n" +
        "- new important emails\n" +
        "- summarize my inbox\n" +
        "- search my email for paypal\n" +
        "- send email to a@b.com subject Hi body Hello\n" +
        "- reply to latest email: ...\n" +
        "- use outlook / use gmail / use yahoo\n" +
        "- list my latest 5 emails",
      payload: { provider: "loravo_email", mode: "instant", lxt1: null },
    };
  }

  /* ===================== MAIN ===================== */

  async function runLXT({ req, forceDecision = false, forceIntent = null }) {
    const provider = getProvider(req);
    let mode = getMode(req);

    let { text, user_id, lat, lon, images } = req?.body || {};

    images = normalizeImages(images);
    const hasImages = Array.isArray(images) && images.length > 0;

    const rawText = String(text || "");
    const trimmedText = rawText.trim();

    if (!trimmedText && !hasImages) {
      const userId = String(user_id || "").trim() || null;
      const state = userId ? await loadUserState(userId) : null;
      const liveContext = { weather: null, location: null, news: [], stocks: null };

      const voice = await handleGreeting({
        provider,
        voiceProfile: state?.voice_profile || defaults.voice_profile || null,
        liveContext,
        mode: "instant",
      });

      const base = {
        provider,
        mode: "instant",
        reply: voice.reply,
        lxt1: null,
        _errors: { reply: voice._reply_error },
      };

      if (defaults?.include_provider_meta === false) return base;
      return {
        ...base,
        providers: {
          decision: "greeting_dynamic",
          reply: voice.replyProvider,
          triedDecision: ["greeting_dynamic"],
          triedReply: voice.tried,
        },
      };
    }

    if (!trimmedText && hasImages) text = "What is this?";
    else text = trimmedText;

    const userId = String(user_id || "").trim() || null;

    const [state, memory] = await Promise.all([
      userId ? loadUserState(userId) : Promise.resolve(null),
      userId ? loadUserMemory(userId) : Promise.resolve(""),
    ]);

    const planTier = normalizeTier(state?.plan_tier || defaults.plan_tier || "core");

    if (userId) await maybeUpdateVoiceProfile({ userId, userState: state, memory });

    if (userId && text) {
      const sig = inferBehaviorFromText(text);
      const oldBP = state?.behavior_profile || {};
      const nextBP = mergeBehavior(oldBP, sig);
      await setUserStateFields(userId, {
        behavior_profile: nextBP,
        behavior_updated_at: new Date().toISOString(),
      });
      await maybeLearnMemory({ userId, text });
    }

    const state2 = userId ? await loadUserState(userId) : state;
    const behaviorLine = behaviorToVoiceLine(state2?.behavior_profile || null);
    const baseVoice = state2?.voice_profile || defaults.voice_profile || null;
    const finalVoiceProfile = [baseVoice, behaviorLine].filter(Boolean).join(" ").trim() || null;

    let intent = classifyIntent(text, hasImages);
    if (forceIntent) intent = String(forceIntent);
    if (forceDecision) intent = "decision";

    if (mode === "auto") mode = pickAutoMode(text, hasImages);
    const maxTokens = TOKEN_LIMITS[mode] || TOKEN_LIMITS.auto;

    const liveContext = await buildLiveContext({
      userId,
      text,
      lat: toNum(lat),
      lon: toNum(lon),
      userState: state2,
    });

    const liveCompact = compactLiveContextForDecision(liveContext);

    let topic = detectTopic(text, hasImages);
    if (isMoreOnly(text) && state2?.last_topic) topic = state2.last_topic;
    if (userId) await setUserStateFields(userId, { last_topic: topic });

    if (isPoweredByQuestion(text)) {
      const base = {
        provider: "loravo_fastpath",
        mode: "instant",
        reply: "Powered by LXT-1.",
        lxt1: sanitizeToSchema({
          verdict: "HOLD",
          confidence: 0.9,
          one_liner: "Identity request.",
          signals: [],
          actions: [{ now: "Ask what they want to do next", time: "today", effort: "low" }],
          watchouts: [],
          next_check: safeNowPlus(6 * 60 * 60 * 1000),
        }),
        _errors: {},
      };

      if (defaults?.include_provider_meta === false) return base;
      return {
        ...base,
        providers: { decision: "fastpath", reply: "fastpath", triedDecision: ["fastpath"], triedReply: ["fastpath"] },
      };
    }

    if (!forceDecision) {
      if (intent === "greeting") {
        const voice = await handleGreeting({
          provider,
          voiceProfile: finalVoiceProfile,
          liveContext,
          mode,
        });

        const base = {
          provider,
          mode: "instant",
          reply: voice.reply,
          lxt1: null,
          _errors: { reply: voice._reply_error },
        };

        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: {
            decision: "greeting_dynamic",
            reply: voice.replyProvider,
            triedDecision: ["greeting_dynamic"],
            triedReply: voice.tried,
          },
        };
      }

      if (intent === "shopping") {
        const reply = await handleShoppingIntent({
          userId,
          text,
          userState: state2 || {},
          voiceProfile: finalVoiceProfile,
          liveContext,
          mode,
        });

        const base = { provider: "loravo_shop", mode, reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "shop_fast", reply: "openai", triedDecision: ["shop_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "daily_brief") {
        const reply = await handleDailyBrief({
          planTier,
          liveContext,
          voiceProfile: finalVoiceProfile,
          mode: mode === "instant" ? "auto" : mode,
        });
        const base = { provider: "loravo_brief", mode, reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "brief_fast", reply: "openai", triedDecision: ["brief_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "signal_scan") {
        const reply = await handleSignalScan({
          planTier,
          userId,
          liveContext,
          voiceProfile: finalVoiceProfile,
          mode: "thinking",
        });
        const base = { provider: "loravo_signals", mode: "thinking", reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "signal_fast", reply: "openai", triedDecision: ["signal_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "email") {
        try {
          const out = await handleEmailIntent({ userId, text, planTier });
          const base = { provider: "loravo_email", mode: "instant", reply: out.reply, lxt1: null, _errors: {} };
          if (defaults?.include_provider_meta === false) return base;
          return {
            ...base,
            providers: {
              decision: "email_fast",
              reply: "email_fast",
              triedDecision: ["email_fast"],
              triedReply: ["email_fast"],
            },
          };
        } catch (e) {
          const base = {
            provider: "loravo_email",
            mode: "instant",
            reply: `Email error: ${String(e?.message || e)}`,
            lxt1: null,
            _errors: { email: String(e?.message || e) },
          };
          if (defaults?.include_provider_meta === false) return base;
          return {
            ...base,
            providers: {
              decision: "email_fast",
              reply: "email_fast",
              triedDecision: ["email_fast"],
              triedReply: ["email_fast"],
            },
          };
        }
      }

      if (intent === "weather_source") {
        const reply = await handleWeatherSourceIntent();
        const base = { provider: "loravo_weather", mode: "instant", reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: {
            decision: "weather_meta_fast",
            reply: "weather_meta_fast",
            triedDecision: ["weather_meta_fast"],
            triedReply: ["weather_meta_fast"],
          },
        };
      }

      if (intent === "weather") {
        const reply = await handleWeatherIntent({
          text,
          liveContext,
          voiceProfile: finalVoiceProfile,
          mode: mode === "thinking" ? "thinking" : "auto",
        });
        const base = { provider: "loravo_weather", mode, reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "weather_fast", reply: "openai", triedDecision: ["weather_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "stocks") {
        const reply = await handleStocksIntent({ text, liveContext });
        const base = { provider: "loravo_stocks", mode: "instant", reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "stocks_fast", reply: "stocks_fast", triedDecision: ["stocks_fast"], triedReply: ["stocks_fast"] },
        };
      }

      if (intent === "news") {
        const reply = await handleNewsIntent({
          userId,
          memory,
          liveContext,
          voiceProfile: finalVoiceProfile,
          userText: text,
          mode: mode === "thinking" ? "thinking" : "auto",
        });

        const base = { provider: "loravo_news", mode, reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "news_fast", reply: "openai", triedDecision: ["news_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "affects_me") {
        const gate = requireFeatureOrTease({ tier: planTier, feature: "affects_me" });
        if (!gate.ok) {
          const base = { provider: "loravo_impact", mode, reply: gate.reply, lxt1: null, _errors: {} };
          if (defaults?.include_provider_meta === false) return base;
          return {
            ...base,
            providers: { decision: "impact_fast", reply: "fastpath", triedDecision: ["impact_fast"], triedReply: ["fastpath"] },
          };
        }

        const reply = await handleAffectsMeIntent({
          text,
          liveContext,
          voiceProfile: finalVoiceProfile,
          mode: mode === "thinking" ? "thinking" : "auto",
        });
        const base = { provider: "loravo_impact", mode, reply, lxt1: null, _errors: {} };
        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: { decision: "impact_fast", reply: "openai", triedDecision: ["impact_fast"], triedReply: ["openai"] },
        };
      }

      if (intent === "chat") {
        const lxt1ForChat = sanitizeToSchema({
          verdict: hasImages ? "MOVE" : "HOLD",
          confidence: hasImages ? 0.88 : 0.82,
          one_liner: hasImages ? "Visual analysis request." : "General chat.",
          signals: [],
          actions: [],
          watchouts: [],
          next_check: safeNowPlus(6 * 60 * 60 * 1000),
        });

        const imageHint =
          isBuyOrFindQuestion(text) && normalizePlaceName(state2?.last_image_label)
            ? `The user previously shared an image labeled: "${state2.last_image_label}". If they say "one" or "this", assume they mean that item.`
            : "";

        const lastReplyHint = [
          state2?.last_alert_hash ? "Rephrase; avoid repeating the same wording." : "",
          imageHint,
        ]
          .filter(Boolean)
          .join(" ");

        const expandedUserText =
          isMoreOnly(text) && topic?.kind
            ? `The user said "more". Continue deeper on the previous topic: ${topic.kind}.`
            : text;

        const voice = await getHumanReply({
          provider,
          userText: expandedUserText,
          images,
          lxt1: lxt1ForChat,
          voiceProfile: finalVoiceProfile,
          liveContext,
          lastReplyHint,
          mode,
        });

        if (userId && hasImages && voice?.reply) {
          const label = firstLineLabel(voice.reply);
          if (label) {
            await setUserStateFields(userId, {
              last_image_label: label,
              last_image_at: new Date().toISOString(),
            });
          }
        }

        const base = {
          provider,
          mode,
          reply: voice.reply,
          lxt1: null,
          _errors: { reply: voice._reply_error },
        };

        if (defaults?.include_provider_meta === false) return base;
        return {
          ...base,
          providers: {
            decision: "chat_fast",
            reply: voice.replyProvider,
            triedDecision: ["chat_fast"],
            triedReply: voice.tried,
          },
        };
      }
    }

    const decision = await getDecision({
      provider,
      text,
      memory,
      liveContextCompact: liveCompact,
      maxTokens,
    });

    let lxt1 = sanitizeToSchema(decision.lxt1 || safeFallbackResult("Temporary issue — try again."));

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
      const base = {
        provider,
        mode,
        lxt1,
        reply: null,
        _errors: { openai: decision._openai_error },
      };
      if (defaults?.include_provider_meta === false) return base;
      return {
        ...base,
        providers: {
          decision: decision.decisionProvider,
          reply: "skipped",
          triedDecision: decision.tried,
          triedReply: [],
        },
      };
    }

    const voice = await getHumanReply({
      provider,
      userText: text,
      images,
      lxt1,
      voiceProfile: finalVoiceProfile,
      liveContext,
      lastReplyHint,
      mode,
    });

    if (userId && hasImages && voice?.reply) {
      const label = firstLineLabel(voice.reply);
      if (label) {
        await setUserStateFields(userId, {
          last_image_label: label,
          last_image_at: new Date().toISOString(),
        });
      }
    }

    const base = {
      provider,
      mode,
      lxt1,
      reply: voice.reply,
      _errors: {
        openai: decision._openai_error,
        reply: voice._reply_error,
      },
    };

    if (defaults?.include_provider_meta === false) return base;

    return {
      ...base,
      providers: {
        decision: decision.decisionProvider,
        reply: voice.replyProvider,
        triedDecision: decision.tried,
        triedReply: voice.tried,
      },
    };
  }

  /* ===================== PROACTIVE ===================== */

  async function generateProactiveInsights({ userId, lat = null, lon = null }) {
    const state = await loadUserState(userId);
    const planTier = normalizeTier(state?.plan_tier || "core");

    const gate = requireFeatureOrTease({ tier: planTier, feature: "proactive_alerts" });
    if (!gate.ok) return [];

    const liveContext = await buildLiveContext({
      userId,
      text: "proactive_scan",
      lat: toNum(lat),
      lon: toNum(lon),
      userState: state,
    });

    if (services?.signals?.proactive) {
      try {
        return await services.signals.proactive({ userId, liveContext, state });
      } catch {}
    }

    const out = await callOpenAIReply({
      userText: `
Generate up to 2 proactive insights for the user.
Only if truly useful.
Each insight should include: title, why, action.
If nothing matters, return NONE.
      `.trim(),
      images: [],
      lxt1: null,
      voiceProfile: `${state?.voice_profile || ""} Proactive. Only notify when it matters.`,
      liveContext,
      lastReplyHint: "",
      mode: "thinking",
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

  return {
    runLXT,
    generateProactiveInsights,
    _internals: {
      classifyIntent,
      pickAutoMode,
      buildLiveContext,
      compactLiveContextForDecision,
      extractTicker,
      extractCityFromWeatherText,
      extractCoordinatesFromText,
      sha1,
      normalizeTier,
      tierAtLeast,
      requireFeatureOrTease,
      detectTopic,
      isMoreOnly,
      estimateComplexity,
      chooseDepthHint,
    },
  };
}

module.exports = { createLXT };