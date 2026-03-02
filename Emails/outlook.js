// Emails/outlook.js
// =====================================================
// LORAVO — Outlook / Microsoft (single-file router + LXT service)
//
// ✅ OAuth2 connect (auth-url + callback) via Microsoft Identity Platform
// ✅ Uses Microsoft Graph for mail (list/read/send/reply)
// ✅ Stores tokens in Postgres if DATABASE_URL exists (Render) else in-memory fallback
// ✅ Status + Disconnect (GET + POST)
// ✅ iOS auto-close: mode=app -> redirects to loravo://connected
// ✅ Browser success page (desktop/manual testing)
// ✅ Friendly GET routes for quick testing
// ✅ Exports BOTH router + service interface for LXT.js
//
// Mount in index.js:
//   const outlookPkg = require("./Emails/outlook");
//   app.use("/outlook", outlookPkg.router);
//
// Required env:
//   OUTLOOK_CLIENT_ID
//   OUTLOOK_CLIENT_SECRET
//   OUTLOOK_REDIRECT_URI     (must match Azure Redirect URI exactly)
//
// Optional env:
//   DATABASE_URL
//   OUTLOOK_STATE_SECRET
//   OUTLOOK_SUCCESS_WEB_URL  (default https://loravo-backend.onrender.com)
//
// Azure API permissions (Delegated):
//   openid, profile, email, offline_access, User.Read, Mail.ReadWrite, Mail.Send
// =====================================================

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // node-fetch@2
const { Pool } = require("pg");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

/* ===================== CONFIG ===================== */

const CLIENT_ID = String(process.env.OUTLOOK_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.OUTLOOK_CLIENT_SECRET || "").trim();
const REDIRECT_URI = String(process.env.OUTLOOK_REDIRECT_URI || "").trim();

const STATE_SECRET = String(process.env.OUTLOOK_STATE_SECRET || "loravo_outlook_state_secret_change_me").trim();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DB_ENABLED = Boolean(DATABASE_URL);

const SUCCESS_WEB_BASE =
  String(process.env.OUTLOOK_SUCCESS_WEB_URL || "").trim() ||
  "https://loravo-backend.onrender.com";

const AUTH_BASE = "https://login.microsoftonline.com";
const TENANT = "common"; // supports personal + work/school
const AUTHORIZE_URL = `${AUTH_BASE}/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `${AUTH_BASE}/${TENANT}/oauth2/v2.0/token`;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const OUTLOOK_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
].join(" ");

/* ===================== DB SETUP ===================== */

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
const memTokens = new Map(); // user_id -> { tokens, email, updated_at }

/* ===================== DB INIT ===================== */

async function initDbIfPossible() {
  if (!pool) {
    dbReady = false;
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outlook_tokens (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        tokens JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    dbReady = true;
  } catch (e) {
    dbReady = false;
    console.error("⚠️ Outlook DB init failed (fallback to in-memory):", e?.message || e);
  }
}
initDbIfPossible().catch(() => {});

/* ===================== HELPERS ===================== */

function requireEnv() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    const missing = [
      !CLIENT_ID ? "OUTLOOK_CLIENT_ID" : null,
      !CLIENT_SECRET ? "OUTLOOK_CLIENT_SECRET" : null,
      !REDIRECT_URI ? "OUTLOOK_REDIRECT_URI" : null,
    ].filter(Boolean);
    const err = new Error(`Missing env vars: ${missing.join(", ")} (set them in .env / Render)`);
    err.status = 400;
    throw err;
  }
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

async function dbQuery(sql, params) {
  if (!pool || !dbReady) return { rows: [] };
  return pool.query(sql, params);
}

function nowIso() {
  return new Date().toISOString();
}

async function saveTokens(userId, tokens, email) {
  if (!userId || !tokens) return;

  if (dbReady) {
    await dbQuery(
      `
      INSERT INTO outlook_tokens (user_id, email, tokens)
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

  memTokens.set(String(userId), { tokens, email: email || null, updated_at: nowIso() });
}

async function loadTokens(userId) {
  if (!userId) return null;

  if (dbReady) {
    const { rows } = await dbQuery(
      `SELECT user_id, email, tokens, updated_at FROM outlook_tokens WHERE user_id=$1 LIMIT 1`,
      [String(userId)]
    );
    return rows?.[0] || null;
  }

  const hit = memTokens.get(String(userId));
  if (!hit) return null;
  return { user_id: String(userId), email: hit.email, tokens: hit.tokens, updated_at: hit.updated_at };
}

async function clearTokens(userId) {
  if (!userId) return;
  if (dbReady) await dbQuery(`DELETE FROM outlook_tokens WHERE user_id=$1`, [String(userId)]);
  else memTokens.delete(String(userId));
}

/**
 * Ensures we have a valid access token (refresh if needed).
 */
async function ensureFreshAccessToken(userId) {
  requireEnv();

  const record = await loadTokens(userId);
  if (!record?.tokens) {
    const err = new Error("Outlook not connected for this user_id. Call /outlook/auth first.");
    err.status = 401;
    throw err;
  }

  const tokens = record.tokens || {};
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  const expMs =
    (tokens.expires_at ? Number(tokens.expires_at) : null) ||
    (tokens.expires_on ? Number(tokens.expires_on) * 1000 : null) ||
    null;

  const needsRefresh = !accessToken || (expMs && Date.now() > expMs - 60_000);

  if (!needsRefresh) return { ...record, tokens };

  if (!refreshToken) {
    const err = new Error("Outlook access token expired and no refresh_token is available. Reconnect required.");
    err.status = 401;
    throw err;
  }

  const body = new URLSearchParams();
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("scope", OUTLOOK_SCOPES);

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Token refresh failed: ${json?.error_description || json?.error || r.status}`);
    err.status = 401;
    err._graph = json;
    throw err;
  }

  const refreshed = { ...tokens, ...json };

  if (json?.expires_in != null && (typeof json.expires_in === "number" || /^\d+$/.test(String(json.expires_in)))) {
    const sec = Number(json.expires_in);
    refreshed.expires_at = Date.now() + sec * 1000;
  }

  // ✅ Microsoft sometimes omits refresh_token on refresh. Preserve the old one.
  if (!refreshed.refresh_token && refreshToken) refreshed.refresh_token = refreshToken;

  await saveTokens(userId, refreshed, record.email || null);
  return { ...record, tokens: refreshed, updated_at: nowIso() };
}

async function graphRequest(userId, method, path, { query, body, headers } = {}) {
  const rec = await ensureFreshAccessToken(userId);
  const accessToken = rec.tokens?.access_token;

  const url = new URL(`${GRAPH_BASE}${path}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const r = await fetch(url.toString(), {
    method: method || "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!r.ok) {
    const msg = json?.error?.message || json?.error_description || text || `Graph error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err._graph = json || text;
    throw err;
  }

  return json;
}

function pickSender(item) {
  const from = item?.from?.emailAddress?.address || null;
  const fromName = item?.from?.emailAddress?.name || null;
  const sender = item?.sender?.emailAddress?.address || null;
  const senderName = item?.sender?.emailAddress?.name || null;
  return {
    from: fromName && from ? `${fromName} <${from}>` : from || null,
    sender: senderName && sender ? `${senderName} <${sender}>` : sender || null,
  };
}

// Simple HTML → text fallback for LXT (not perfect but good)
function stripHtml(html) {
  if (!html) return "";
  const s = String(html);
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* ===================== CORE OPS (shared) ===================== */

async function opList({ userId, top = 10, folder = "inbox", search = null }) {
  const take = Math.min(Number(top || 10), 25);
  const folderId = String(folder || "inbox").toLowerCase();

  const path = `/me/mailFolders/${encodeURIComponent(folderId)}/messages`;
  const query = {
    $top: take,
    $orderby: "receivedDateTime desc",
    $select: "id,subject,bodyPreview,from,receivedDateTime,isRead,conversationId,internetMessageId",
  };

  const headers = {};
  if (search) {
    query.$search = `"${String(search).replace(/"/g, '\\"')}"`;
    headers.ConsistencyLevel = "eventual";
  }

  const data = await graphRequest(userId, "GET", path, { query, headers });

  return (data?.value || []).map((m) => {
    const who = pickSender(m);
    return {
      id: m.id,
      threadId: m.conversationId || null,
      messageId: m.internetMessageId || null,
      subject: m.subject || "",
      from: who.from || who.sender || null,
      date: m.receivedDateTime || null,
      isRead: Boolean(m.isRead),
      snippet: m.bodyPreview || "",
    };
  });
}

async function opRead({ userId, id }) {
  const msg = await graphRequest(userId, "GET", `/me/messages/${encodeURIComponent(id)}`, {
    query: {
      $select:
        "id,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,conversationId,internetMessageId,inReplyTo",
    },
  });

  const who = pickSender(msg);

  const to = (msg?.toRecipients || [])
    .map((r) => r?.emailAddress?.address || null)
    .filter(Boolean);

  const contentType = String(msg?.body?.contentType || "").toLowerCase();
  const content = msg?.body?.content || "";

  const bodyText = contentType === "text" ? content : stripHtml(content);
  const bodyHtml = contentType === "html" ? content : null;

  return {
    id: msg?.id || id,
    threadId: msg?.conversationId || null,
    messageId: msg?.internetMessageId || null,
    from: who.from || who.sender || null,
    to,
    subject: msg?.subject || "",
    date: msg?.receivedDateTime || null,
    snippet: msg?.bodyPreview || "",
    body_text: bodyText || "",
    body_html: bodyHtml,
  };
}

async function opSend({ userId, to, subject, body, saveToSentItems = true }) {
  const payload = {
    message: {
      subject: subject || "",
      body: { contentType: "Text", content: body || "" },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: Boolean(saveToSentItems),
  };

  await graphRequest(userId, "POST", "/me/sendMail", { body: payload });
  return { id: null, threadId: null };
}

async function opReply({ userId, id, body }) {
  // Graph: POST /me/messages/{id}/reply
  // We can pass a comment (simple) OR createReply + send.
  const payload = { comment: body || "" };
  await graphRequest(userId, "POST", `/me/messages/${encodeURIComponent(id)}/reply`, { body: payload });
  return { id: null, threadId: null };
}

/* ===================== ROUTES ===================== */

router.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "loravo-outlook-router",
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

// GET /outlook/auth?user_id=...&mode=app?
router.get("/auth", (req, res) => {
  const userId = String(req.query.user_id || "").trim();
  const mode = String(req.query.mode || "").trim();
  if (!userId) return res.status(400).send("Missing user_id");
  const extra = mode ? `&mode=${encodeURIComponent(mode)}` : "";
  return res.redirect(`/outlook/auth-url?user_id=${encodeURIComponent(userId)}${extra}`);
});

// GET /outlook/status?user_id=...
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

// GET /outlook/auth-url?user_id=...&mode=app?
router.get("/auth-url", async (req, res) => {
  try {
    requireEnv();

    const userId = String(req.query.user_id || "").trim();
    const mode = String(req.query.mode || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const state = signState({
      user_id: userId,
      mode: mode || "",
      nonce: crypto.randomBytes(12).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000,
    });

    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", REDIRECT_URI);
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("scope", OUTLOOK_SCOPES);
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "consent");

    res.json({ ok: true, url: u.toString() });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// Browser success page: GET /outlook/connected?user_id=...&email=...
router.get("/connected", (req, res) => {
  const email = String(req.query.email || "");
  const userId = String(req.query.user_id || "");
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <html>
      <head>
        <title>Loravo Outlook Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: -apple-system, system-ui; padding: 28px; line-height: 1.4;">
        <h1 style="margin:0 0 12px 0;">✅ Outlook Connected</h1>
        <p style="margin:0 0 18px 0;">${email ? `Connected as <b>${email}</b>.` : "Connection saved."}</p>
        <p style="margin:0 0 10px 0; opacity:.75;">
          If you’re on iPhone, go back to Loravo. If Loravo didn’t open automatically, tap below.
        </p>
        <a href="loravo://connected?provider=outlook&user_id=${encodeURIComponent(userId)}&email=${encodeURIComponent(email)}"
           style="display:inline-block; padding:12px 16px; border-radius:12px; background:#111; color:#fff; text-decoration:none;">
          Open Loravo
        </a>
      </body>
    </html>
  `);
});

// OAuth callback: GET /outlook/oauth2callback?code=...&state=...
router.get("/oauth2callback", async (req, res) => {
  try {
    requireEnv();

    const code = String(req.query.code || "").trim();
    const stateStr = String(req.query.state || "").trim();
    if (!code) return res.status(400).send("Missing code");

    const state = verifyState(stateStr);
    if (!state?.user_id) return res.status(400).send("Invalid state (expired or tampered)");

    const userId = String(state.user_id);
    const mode = String(state.mode || "").trim();

    const body = new URLSearchParams();
    body.set("client_id", CLIENT_ID);
    body.set("client_secret", CLIENT_SECRET);
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", REDIRECT_URI);
    body.set("scope", OUTLOOK_SCOPES);

    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(500).send(`OAuth token exchange failed: ${json?.error_description || json?.error || r.status}`);
    }

    const tokens = { ...json };
    if (tokens?.expires_in != null && (typeof tokens.expires_in === "number" || /^\d+$/.test(String(tokens.expires_in)))) {
      tokens.expires_at = Date.now() + Number(tokens.expires_in) * 1000;
    }

    let email = null;
    try {
      const me = await graphRequest(userId, "GET", `/me`, {
        // temporarily use this new token directly:
        // easiest: call graph with fetch here
      });
      // NOTE: graphRequest uses ensureFreshAccessToken which uses DB tokens,
      // so we do a direct fetch instead:
    } catch {}

    // ✅ Direct fetch to /me using new access token:
    try {
      const rr = await fetch(`${GRAPH_BASE}/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const t = await rr.text();
      const me = t ? JSON.parse(t) : null;
      email = me?.mail || me?.userPrincipalName || null;
    } catch {
      email = null;
    }

    await saveTokens(userId, tokens, email);

    if (mode === "app") {
      const deeplink = `loravo://connected?provider=outlook&user_id=${encodeURIComponent(
        userId
      )}&email=${encodeURIComponent(email || "")}`;
      return res.redirect(deeplink);
    }

    const successPage = `${SUCCESS_WEB_BASE}/outlook/connected?user_id=${encodeURIComponent(
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

/* ===================== MAIL API (POST) ===================== */

// POST /outlook/list  { user_id, top?, folder?, search? }
router.post("/list", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const top = Math.min(Number(req.body?.top || 10), 25);
    const folder = String(req.body?.folder || "inbox").toLowerCase();
    const search = req.body?.search ? String(req.body.search) : null;

    const emails = await opList({ userId, top, folder, search });
    res.json({ ok: true, folder, top, emails });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// POST /outlook/read  { user_id, id }
router.post("/read", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const id = String(req.body?.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const email = await opRead({ userId, id });
    res.json({ ok: true, email });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// POST /outlook/send  { user_id, to, subject?, body, saveToSentItems? }
router.post("/send", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const to = String(req.body?.to || "").trim();
    const subject = String(req.body?.subject || "").trim();
    const body = String(req.body?.body || "").trim();
    const saveToSentItems = req.body?.saveToSentItems == null ? true : Boolean(req.body.saveToSentItems);

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!to) return res.status(400).json({ error: "Missing to" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opSend({ userId, to, subject, body, saveToSentItems });
    res.json({ ok: true, ...out, sent: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// POST /outlook/reply  { user_id, id, body }
router.post("/reply", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const id = String(req.body?.id || "").trim();
    const body = String(req.body?.body || "").trim();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opReply({ userId, id, body });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

/* ===================== EASY TEST ROUTES (GET) ===================== */

// GET /outlook/list?user_id=...&top=...&folder=...&search=...
router.get("/list", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const top = req.query.top ? Number(req.query.top) : 10;
    const folder = req.query.folder ? String(req.query.folder) : "inbox";
    const search = req.query.search ? String(req.query.search) : null;

    const emails = await opList({ userId, top, folder, search });
    res.json({ ok: true, folder, top: Math.min(Number(top || 10), 25), emails });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// GET /outlook/read?user_id=...&id=...
router.get("/read", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const email = await opRead({ userId, id });
    res.json({ ok: true, email });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// GET /outlook/send?user_id=...&to=...&subject=...&body=...
router.get("/send", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const to = String(req.query.to || "").trim();
    const subject = String(req.query.subject || "").trim();
    const body = String(req.query.body || "").trim();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!to) return res.status(400).json({ error: "Missing to" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opSend({ userId, to, subject, body, saveToSentItems: true });
    res.json({ ok: true, ...out, sent: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// GET /outlook/reply?user_id=...&id=...&body=...
router.get("/reply", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    const body = String(req.query.body || "").trim();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const out = await opReply({ userId, id, body });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

/* ===================== SERVICE API (for LXT / index.js) ===================== */

async function svcGetConnectedProviders({ userId }) {
  const rec = await loadTokens(userId);
  return rec?.tokens ? ["outlook"] : [];
}

async function svcList({ userId, q = null, max = 10 }) {
  const top = Math.min(Number(max || 10), 25);

  // q -> Graph search keyword (AQS). If q is Gmail-style, pass simpler keywords.
  const search = q ? String(q) : null;

  const emails = await opList({ userId, top, folder: "inbox", search });

  // ✅ normalize to Gmail/Yahoo style
  return emails.map((m) => ({
    id: m.id,
    threadId: m.threadId,
    from: m.from,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet || "",
  }));
}

async function svcGetBody({ userId, messageId }) {
  const r = await opRead({ userId, id: String(messageId) });
  return {
    id: r.id,
    threadId: r.threadId,
    from: r.from,
    to: r.to,
    subject: r.subject,
    date: r.date,
    messageId: r.messageId,
    references: null,
    inReplyTo: null,
    snippet: r.snippet || "",
    body: r.body_text || r.body_html || "",
  };
}

async function svcSend({ userId, to, subject, body, threadId = null }) {
  // threadId not used yet for Outlook send
  return await opSend({ userId, to, subject, body, saveToSentItems: true });
}

async function svcReplyById({ userId, messageId, body }) {
  return await opReply({ userId, id: String(messageId), body });
}

async function svcReplyLatest({ userId, body }) {
  const list = await svcList({ userId, max: 1 });
  const latest = list?.[0];
  if (!latest?.id) throw new Error("No Outlook emails found to reply to.");
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