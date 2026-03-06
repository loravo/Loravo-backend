// Emails/gmail.js
// =====================================================
// LORAVO — Gmail (single-file router + LXT service)
//
// ✅ OAuth2 connect (auth-url + callback)
// ✅ Stores tokens in Postgres if DATABASE_URL exists (Render) else in-memory fallback
// ✅ Status, list, read, send, reply
// ✅ Disconnect (GET + POST)
// ✅ iOS auto-close: mode=app -> redirects to loravo://connected
// ✅ Browser success page (for desktop/manual testing)
// ✅ Friendly GET routes for quick testing
// ✅ Exports BOTH router + service interface for LXT.js
// ✅ Better LXT normalization
// ✅ Better latest-email ordering
// ✅ Better sender parsing
// ✅ Better unread / recent inbox behavior
//
// Required env:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI
//
// Optional env:
//   DATABASE_URL
//   GMAIL_STATE_SECRET
//   GMAIL_SUCCESS_WEB_URL
// =====================================================

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { google } = require("googleapis");
const { Pool } = require("pg");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

/* ===================== CONFIG ===================== */

const CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || "").trim();

const STATE_SECRET = String(process.env.GMAIL_STATE_SECRET || "loravo_state_secret_change_me").trim();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DB_ENABLED = Boolean(DATABASE_URL);

const SUCCESS_WEB_BASE =
  String(process.env.GMAIL_SUCCESS_WEB_URL || "").trim() ||
  "https://loravo-backend.onrender.com";

/* ===================== DB ===================== */

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

const pool = DB_ENABLED
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocalDbUrl(DATABASE_URL) ? false : { rejectUnauthorized: false },
    })
  : null;

let dbReady = false;

// In-memory fallback (ONLY when DB is off)
const memTokens = new Map(); // user_id -> { tokens, email, updated_at }

async function initDbIfPossible() {
  if (!pool) {
    dbReady = false;
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gmail_tokens (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        tokens JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    dbReady = true;
  } catch (e) {
    dbReady = false;
    console.error("⚠️ Gmail DB init failed (fallback to in-memory):", e?.message || e);
  }
}
initDbIfPossible().catch(() => {});

async function dbQuery(sql, params) {
  if (!pool || !dbReady) return { rows: [] };
  return pool.query(sql, params);
}

/* ===================== HELPERS ===================== */

function requireEnv() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    const missing = [
      !CLIENT_ID ? "GOOGLE_CLIENT_ID" : null,
      !CLIENT_SECRET ? "GOOGLE_CLIENT_SECRET" : null,
      !REDIRECT_URI ? "GOOGLE_REDIRECT_URI" : null,
    ].filter(Boolean);
    const err = new Error(`Missing env vars: ${missing.join(", ")} (set them in .env / Render)`);
    err.status = 400;
    throw err;
  }
}

function makeOAuthClient() {
  requireEnv();
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signState(payloadObj) {
  const json = JSON.stringify(payloadObj);
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(json).digest("hex");
  return `${base64url(json)}.${sig}`;
}

function verifyState(state) {
  if (!state || typeof state !== "string") return null;
  const [b64, sig] = state.split(".");
  if (!b64 || !sig) return null;

  const json = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }

  const expected = crypto.createHmac("sha256", STATE_SECRET).update(JSON.stringify(obj)).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  if (obj?.exp && Date.now() > Number(obj.exp)) return null;
  return obj;
}

function safeStr(x, max = 500) {
  const s = String(x ?? "").replace(/\r/g, "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function pickHeader(headers, name) {
  const key = String(name || "").toLowerCase();
  const h = (headers || []).find((x) => String(x?.name || "").toLowerCase() === key);
  return h?.value || null;
}

function decodeBody(dataB64Url) {
  if (!dataB64Url) return "";
  const b64 = String(dataB64Url).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function extractTextPlain(payload) {
  if (!payload) return "";
  const mimeType = payload.mimeType || "";

  if (mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  const parts = payload.parts || [];
  for (const p of parts) {
    if (p?.mimeType === "text/plain" && p?.body?.data) {
      return decodeBody(p.body.data);
    }
  }

  for (const p of parts) {
    const nested = extractTextPlain(p);
    if (nested) return nested;
  }

  return "";
}

function extractTextHtml(payload) {
  if (!payload) return "";
  const mimeType = payload.mimeType || "";

  if (mimeType === "text/html" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  const parts = payload.parts || [];
  for (const p of parts) {
    if (p?.mimeType === "text/html" && p?.body?.data) {
      return decodeBody(p.body.data);
    }
  }

  for (const p of parts) {
    const nested = extractTextHtml(p);
    if (nested) return nested;
  }

  return "";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmailAddress(raw) {
  const s = safeStr(raw, 500);
  if (!s) return null;
  const m = s.match(/<([^>]+@[^>]+)>/);
  if (m?.[1]) return m[1].trim();
  const m2 = s.match(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i);
  return m2?.[1] ? m2[1].trim() : null;
}

function extractDisplayName(raw) {
  const s = safeStr(raw, 500);
  if (!s) return null;
  const m = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (m?.[1]) return m[1].trim();
  if (s.includes("@")) return null;
  return s.trim();
}

function normalizeFrom(rawFrom) {
  const email = extractEmailAddress(rawFrom);
  const name = extractDisplayName(rawFrom);
  return {
    raw: safeStr(rawFrom, 500) || null,
    email: email || null,
    name: name || null,
    display: name ? `${name}${email ? ` <${email}>` : ""}` : email || safeStr(rawFrom, 500) || "(unknown sender)",
  };
}

function buildRawEmail({ to, subject, text, from, inReplyTo, references }) {
  const headers = [];
  headers.push(`To: ${to}`);
  if (from) headers.push(`From: ${from}`);
  headers.push(`Subject: ${subject || ""}`);
  headers.push(`MIME-Version: 1.0`);
  headers.push(`Content-Type: text/plain; charset="UTF-8"`);
  headers.push(`Content-Transfer-Encoding: 7bit`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const msg = `${headers.join("\r\n")}\r\n\r\n${text || ""}`;
  return base64url(msg);
}

/* ===================== TOKEN STORE ===================== */

async function saveTokens(userId, tokens, email) {
  if (!userId || !tokens) return;

  if (dbReady) {
    await dbQuery(
      `
      INSERT INTO gmail_tokens (user_id, email, tokens)
      VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET
        email=EXCLUDED.email,
        tokens=EXCLUDED.tokens,
        updated_at=NOW()
      `,
      [String(userId), email || null, JSON.stringify(tokens)]
    );
    return;
  }

  memTokens.set(String(userId), {
    tokens,
    email: email || null,
    updated_at: new Date().toISOString(),
  });
}

async function loadTokens(userId) {
  if (!userId) return null;

  if (dbReady) {
    const { rows } = await dbQuery(
      `SELECT user_id, email, tokens, updated_at FROM gmail_tokens WHERE user_id=$1 LIMIT 1`,
      [String(userId)]
    );
    return rows?.[0] || null;
  }

  const hit = memTokens.get(String(userId));
  if (!hit) return null;

  return {
    user_id: String(userId),
    email: hit.email,
    tokens: hit.tokens,
    updated_at: hit.updated_at,
  };
}

async function clearTokens(userId) {
  if (!userId) return;
  if (dbReady) {
    await dbQuery(`DELETE FROM gmail_tokens WHERE user_id=$1`, [String(userId)]);
  } else {
    memTokens.delete(String(userId));
  }
}

async function getAuthedGmailClient(userId) {
  const record = await loadTokens(userId);
  if (!record?.tokens) {
    const err = new Error("Gmail not connected for this user_id. Call /gmail/auth first.");
    err.status = 401;
    throw err;
  }

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials(record.tokens);

  oauth2.on("tokens", async (newTokens) => {
    try {
      if (!newTokens) return;
      const latest = await loadTokens(userId);
      const merged = { ...(latest?.tokens || record.tokens || {}), ...(newTokens || {}) };
      await saveTokens(userId, merged, latest?.email || record.email || null);
    } catch (e) {
      console.error("⚠️ token refresh save failed:", e?.message || e);
    }
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  return { gmail, oauth2, record };
}

/* ===================== CORE OPS ===================== */

async function opList({
  userId,
  q = "newer_than:2d",
  maxResults = 10,
  labelIds = ["INBOX"],
  includeBody = false,
}) {
  const { gmail } = await getAuthedGmailClient(userId);

  const list = await gmail.users.messages.list({
    userId: "me",
    q,
    labelIds,
    maxResults: Math.min(Number(maxResults || 10), 25),
  });

  const messages = list?.data?.messages || [];
  if (!messages.length) return [];

  const details = await Promise.all(
    messages.map((m) =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: includeBody ? "full" : "metadata",
        metadataHeaders: [
          "From",
          "Reply-To",
          "To",
          "Subject",
          "Date",
          "Message-Id",
          "References",
          "In-Reply-To",
        ],
      })
    )
  );

  return details
    .map((d) => {
      const msg = d?.data || {};
      const headers = msg.payload?.headers || [];

      const fromRaw = pickHeader(headers, "From");
      const fromNorm = normalizeFrom(fromRaw);

      let bodyText = "";
      if (includeBody) {
        bodyText = extractTextPlain(msg.payload);
        if (!bodyText) {
          const html = extractTextHtml(msg.payload);
          bodyText = stripHtml(html);
        }
      }

      return {
        id: safeStr(msg.id, 200),
        threadId: safeStr(msg.threadId, 200),
        from: fromNorm.display,
        from_name: fromNorm.name,
        from_email: fromNorm.email,
        from_raw: fromNorm.raw,
        subject: safeStr(pickHeader(headers, "Subject"), 300) || "(no subject)",
        snippet: safeStr(msg.snippet || "", 500),
        date: safeStr(pickHeader(headers, "Date"), 120) || null,
        to: safeStr(pickHeader(headers, "To"), 300) || null,
        replyTo: safeStr(pickHeader(headers, "Reply-To"), 300) || null,
        messageId: safeStr(pickHeader(headers, "Message-Id"), 300) || null,
        references: safeStr(pickHeader(headers, "References"), 1000) || null,
        inReplyTo: safeStr(pickHeader(headers, "In-Reply-To"), 300) || null,
        internalDate: msg.internalDate ? Number(msg.internalDate) : null,
        body_text: includeBody ? safeStr(bodyText, 200000) : null,
      };
    })
    .sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
}

async function opRead({ userId, id }) {
  const { gmail } = await getAuthedGmailClient(userId);

  const r = await gmail.users.messages.get({ userId: "me", id, format: "full" });

  const msg = r?.data || {};
  const headers = msg.payload?.headers || [];
  const fromRaw = pickHeader(headers, "From");
  const fromNorm = normalizeFrom(fromRaw);

  let textPlain = extractTextPlain(msg.payload);
  if (!textPlain) {
    const html = extractTextHtml(msg.payload);
    textPlain = stripHtml(html);
  }

  return {
    id: safeStr(msg.id, 200),
    threadId: safeStr(msg.threadId, 200),
    from: fromNorm.display,
    from_name: fromNorm.name,
    from_email: fromNorm.email,
    from_raw: fromNorm.raw,
    replyTo: safeStr(pickHeader(headers, "Reply-To"), 300) || null,
    to: safeStr(pickHeader(headers, "To"), 300) || null,
    subject: safeStr(pickHeader(headers, "Subject"), 300) || "(no subject)",
    date: safeStr(pickHeader(headers, "Date"), 120) || null,
    messageId: safeStr(pickHeader(headers, "Message-Id"), 300) || null,
    references: safeStr(pickHeader(headers, "References"), 1000) || null,
    inReplyTo: safeStr(pickHeader(headers, "In-Reply-To"), 300) || null,
    snippet: safeStr(msg.snippet || "", 500),
    body_text: safeStr(textPlain || "", 200000),
    internalDate: msg.internalDate ? Number(msg.internalDate) : null,
  };
}

async function opSend({ userId, to, subject, body, threadId = null }) {
  const { gmail } = await getAuthedGmailClient(userId);

  const raw = buildRawEmail({
    to: safeStr(to, 320),
    subject: safeStr(subject, 400),
    text: safeStr(body, 200000),
  });

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });

  return {
    id: sent?.data?.id || null,
    threadId: sent?.data?.threadId || threadId || null,
  };
}

async function opReply({ userId, id, body }) {
  const { gmail } = await getAuthedGmailClient(userId);

  const original = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: ["From", "Reply-To", "Subject", "Message-Id", "References", "In-Reply-To"],
  });

  const msg = original?.data || {};
  const headers = msg.payload?.headers || [];

  const replyTo = pickHeader(headers, "Reply-To");
  const from = pickHeader(headers, "From");
  const to = safeStr(replyTo || from || "", 320);

  const subject0 = safeStr(pickHeader(headers, "Subject") || "", 400);
  const subject = /^re:/i.test(subject0) ? subject0 : `Re: ${subject0}`;

  const messageId = safeStr(pickHeader(headers, "Message-Id") || "", 300) || null;
  const references0 = safeStr(pickHeader(headers, "References") || "", 1000) || null;

  const references = references0
    ? `${references0} ${messageId || ""}`.trim()
    : messageId || null;

  const raw = buildRawEmail({
    to,
    subject,
    text: safeStr(body, 200000),
    inReplyTo: messageId,
    references,
  });

  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: msg.threadId },
  });

  return {
    id: sent?.data?.id || null,
    threadId: sent?.data?.threadId || msg.threadId || null,
  };
}

/* ===================== ROUTES ===================== */

router.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "loravo-gmail-router",
    dbReady,
    endpoints: [
      "/auth",
      "/auth-url",
      "/oauth2callback",
      "/connected",
      "/status",
      "/disconnect",
      "/list",
      "/read",
      "/send",
      "/reply",
    ],
  });
});

router.get("/auth", (req, res) => {
  const userId = String(req.query.user_id || "").trim();
  const mode = String(req.query.mode || "").trim();
  if (!userId) return res.status(400).send("Missing user_id");
  const extra = mode ? `&mode=${encodeURIComponent(mode)}` : "";
  return res.redirect(`/gmail/auth-url?user_id=${encodeURIComponent(userId)}${extra}`);
});

router.get("/status", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const record = await loadTokens(userId);
    res.json({
      ok: true,
      connected: Boolean(record?.tokens),
      dbReady,
      email: record?.email || null,
      updated_at: record?.updated_at || null,
    });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/auth-url", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const mode = String(req.query.mode || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const oauth2 = makeOAuthClient();

    const state = signState({
      user_id: userId,
      mode: mode || "",
      nonce: crypto.randomBytes(12).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000,
    });

    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      state,
    });

    res.json({ ok: true, url });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/connected", (req, res) => {
  const email = String(req.query.email || "");
  const userId = String(req.query.user_id || "");
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <html>
      <head>
        <title>Loravo Gmail Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: -apple-system, system-ui; padding: 28px; line-height: 1.4;">
        <h1 style="margin:0 0 12px 0;">✅ Gmail Connected</h1>
        <p style="margin:0 0 18px 0;">${email ? `Connected as <b>${email}</b>.` : "Connection saved."}</p>
        <p style="margin:0 0 10px 0; opacity:.75;">
          If you’re on iPhone, go back to Loravo. If Loravo didn’t open automatically, tap the button below.
        </p>
        <a href="loravo://connected?provider=gmail&user_id=${encodeURIComponent(userId)}&email=${encodeURIComponent(email)}"
           style="display:inline-block; padding:12px 16px; border-radius:12px; background:#111; color:#fff; text-decoration:none;">
          Open Loravo
        </a>
      </body>
    </html>
  `);
});

router.get("/oauth2callback", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    const stateStr = String(req.query.state || "").trim();
    if (!code) return res.status(400).send("Missing code");

    const state = verifyState(stateStr);
    if (!state?.user_id) return res.status(400).send("Invalid state (expired or tampered)");

    const userId = String(state.user_id);
    const mode = String(state.mode || "").trim();

    const oauth2 = makeOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens) return res.status(500).send("No tokens returned");

    oauth2.setCredentials(tokens);

    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile?.data?.emailAddress || null;

    await saveTokens(userId, tokens, email);

    if (mode === "app") {
      const deeplink = `loravo://connected?provider=gmail&user_id=${encodeURIComponent(
        userId
      )}&email=${encodeURIComponent(email || "")}`;
      return res.redirect(deeplink);
    }

    const successPage = `${SUCCESS_WEB_BASE}/gmail/connected?user_id=${encodeURIComponent(
      userId
    )}&email=${encodeURIComponent(email || "")}`;
    return res.redirect(successPage);
  } catch (e) {
    res.status(e?.status || 500).send(`OAuth error: ${String(e?.message || e)}`);
  }
});

/* ===================== DISCONNECT ===================== */

router.post("/disconnect", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    await clearTokens(userId);
    res.json({ ok: true, disconnected: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/disconnect", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    await clearTokens(userId);
    res.json({ ok: true, disconnected: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

/* ===================== API (POST) ===================== */

router.post("/list", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const q = req.body?.q ? String(req.body.q) : "newer_than:2d";
    const maxResults = Math.min(Number(req.body?.maxResults || 10), 25);

    const emails = await opList({ userId, q, maxResults });
    res.json({ ok: true, q, emails });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.post("/read", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const id = String(req.body?.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const email = await opRead({ userId, id });
    res.json({ ok: true, email });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.post("/send", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const to = safeStr(req.body?.to || "", 320);
    const subject = safeStr(req.body?.subject || "", 400);
    const body = safeStr(req.body?.body || "", 200000);
    const threadId = req.body?.threadId ? safeStr(req.body.threadId, 200) : null;

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!to) return res.status(400).json({ error: "Missing to" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opSend({ userId, to, subject, body, threadId });
    res.json({ ok: true, id: out.id, threadId: out.threadId });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.post("/reply", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const id = String(req.body?.id || "").trim();
    const body = safeStr(req.body?.body || "", 200000);

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opReply({ userId, id, body });
    res.json({ ok: true, id: out.id, threadId: out.threadId });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

/* ===================== EASY TEST ROUTES (GET) ===================== */

router.get("/list", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const q = req.query.q ? String(req.query.q) : "newer_than:2d";
    const maxResults = req.query.maxResults ? Number(req.query.maxResults) : 10;

    const emails = await opList({ userId, q, maxResults });
    res.json({ ok: true, q, emails });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/read", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const email = await opRead({ userId, id });
    res.json({ ok: true, email });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/send", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const to = safeStr(req.query.to || "", 320);
    const subject = safeStr(req.query.subject || "", 400);
    const body = safeStr(req.query.body || "", 200000);

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!to) return res.status(400).json({ error: "Missing to" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opSend({ userId, to, subject, body, threadId: null });
    res.json({ ok: true, id: out.id, threadId: out.threadId });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

/* ===================== SERVICE API (for LXT / index.js) ===================== */

async function svcGetConnectedProviders({ userId }) {
  const rec = await loadTokens(userId);
  return rec?.tokens ? ["gmail"] : [];
}

async function svcList({ userId, q = "newer_than:7d", max = 10, disable_orderby = false }) {
  return await opList({
    userId,
    q: String(q || "newer_than:7d"),
    maxResults: Math.min(Number(max || 10), 25),
    labelIds: ["INBOX"],
    includeBody: false,
  });
}

async function svcGetBody({ userId, messageId }) {
  const r = await opRead({ userId, id: messageId });
  return {
    id: r.id,
    threadId: r.threadId,
    from: r.from,
    from_name: r.from_name,
    from_email: r.from_email,
    to: r.to,
    subject: r.subject,
    date: r.date,
    messageId: r.messageId,
    references: r.references,
    inReplyTo: r.inReplyTo,
    snippet: r.snippet,
    body: r.body_text,
  };
}

async function svcSend({ userId, to, subject, body, threadId = null }) {
  return await opSend({ userId, to, subject, body, threadId });
}

async function svcReplyById({ userId, messageId, body }) {
  return await opReply({ userId, id: messageId, body });
}

async function svcReplyLatest({ userId, body }) {
  const items = await opList({
    userId,
    q: "newer_than:30d",
    maxResults: 10,
    labelIds: ["INBOX"],
    includeBody: false,
  });

  if (!items.length) throw new Error("No recent emails to reply to.");

  const latest = items.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0))[0];
  return await svcReplyById({ userId, messageId: latest.id, body });
}

module.exports = {
  router,
  service: {
    getConnectedProviders: svcGetConnectedProviders,
    list: svcList,
    getBody: svcGetBody,
    send: svcSend,
    replyLatest: svcReplyLatest,
    replyById: svcReplyById,
  },
};