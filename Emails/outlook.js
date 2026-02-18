// Emails/outlook.js
// =====================================================
// LORAVO — Outlook / Microsoft (single-file router)
//
// ✅ OAuth2 connect (auth-url + callback) via Microsoft Identity Platform
// ✅ Uses Microsoft Graph for mail (list/read/send)
// ✅ Stores tokens in Postgres if DATABASE_URL exists (Render) else in-memory fallback
// ✅ Status + Disconnect (GET + POST)
// ✅ iOS auto-close: mode=app -> redirects to loravo://connected
// ✅ Browser success page for desktop/manual testing
// ✅ Friendly GET routes for quick testing
//
// Mount in index.js:
//   const outlook = require("./Emails/outlook");
//   app.use("/outlook", outlook);
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
// Notes:
// - Uses delegated permissions (user sign-in). Your Azure API permissions should include:
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
const TENANT = "common"; // "common" supports personal + work/school accounts
const AUTHORIZE_URL = `${AUTH_BASE}/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_URL = `${AUTH_BASE}/${TENANT}/oauth2/v2.0/token`;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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

// In-memory fallback (ONLY when DB is off)
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
    const msg = `Missing env vars: ${missing.join(", ")} (set them in .env / Render)`;
    const err = new Error(msg);
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

  memTokens.set(String(userId), { tokens, email: email || null, updated_at: new Date().toISOString() });
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
  if (dbReady) {
    await dbQuery(`DELETE FROM outlook_tokens WHERE user_id=$1`, [String(userId)]);
  } else {
    memTokens.delete(String(userId));
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * If access token expired and we have a refresh_token, refresh it.
 * Returns tokens record (possibly updated) with a valid access token.
 */
async function ensureFreshAccessToken(userId) {
  const record = await loadTokens(userId);
  if (!record?.tokens) {
    const err = new Error("Outlook not connected for this user_id. Call /outlook/auth first.");
    err.status = 401;
    throw err;
  }

  const tokens = record.tokens || {};
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  // If no expiry info, just try with current access_token.
  const expiresAt = tokens.expires_at ? Number(tokens.expires_at) : null;
  const expiresOn = tokens.expires_on ? Number(tokens.expires_on) : null;
  const expMs = expiresAt ? expiresAt : expiresOn ? expiresOn * 1000 : null;

  const needsRefresh = !accessToken || (expMs && Date.now() > expMs - 60_000);

  if (!needsRefresh) return { ...record, tokens };

  if (!refreshToken) {
    const err = new Error("Outlook access token expired and no refresh_token is available. Reconnect required.");
    err.status = 401;
    throw err;
  }

  // Refresh via token endpoint (x-www-form-urlencoded)
  const body = new URLSearchParams();
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("redirect_uri", REDIRECT_URI);

  // Recommended scopes for refresh: include the same ones you requested
  body.set(
    "scope",
    [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ].join(" ")
  );

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`Token refresh failed: ${json?.error_description || json?.error || r.status}`);
    err.status = 401;
    throw err;
  }

  const refreshed = {
    ...tokens,
    ...json,
  };

  // Compute expires_at (ms) for easy checks
  if (typeof json.expires_in === "number" || /^\d+$/.test(String(json.expires_in || ""))) {
    const sec = Number(json.expires_in);
    refreshed.expires_at = Date.now() + sec * 1000;
  }

  // If refresh response did not include refresh_token, keep existing one
  if (!refreshed.refresh_token && refreshToken) refreshed.refresh_token = refreshToken;

  await saveTokens(userId, refreshed, record.email || null);

  return { ...record, tokens: refreshed, updated_at: nowIso() };
}

async function graphRequest(userId, method, path, { query, body, headers } = {}) {
  requireEnv();
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
      "Content-Type": "application/json",
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
  // Graph messages: from.emailAddress.address, sender.emailAddress.address
  const from = item?.from?.emailAddress?.address || null;
  const fromName = item?.from?.emailAddress?.name || null;
  const sender = item?.sender?.emailAddress?.address || null;
  const senderName = item?.sender?.emailAddress?.name || null;
  return {
    from: fromName && from ? `${fromName} <${from}>` : from || null,
    sender: senderName && sender ? `${senderName} <${sender}>` : sender || null,
  };
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
    const mode = String(req.query.mode || "").trim(); // "app"
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const state = signState({
      user_id: userId,
      mode: mode || "",
      nonce: crypto.randomBytes(12).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000,
    });

    // v2 scopes must include "offline_access" to get refresh_token
    const scope = [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ].join(" ");

    const u = new URL(AUTHORIZE_URL);
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", REDIRECT_URI);
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("scope", scope);
    u.searchParams.set("state", state);
    // This forces a consent prompt so you get refresh_token reliably
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

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.set("client_id", CLIENT_ID);
    body.set("client_secret", CLIENT_SECRET);
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", REDIRECT_URI);

    // Must match what you asked in authorize
    body.set(
      "scope",
      [
        "openid",
        "profile",
        "email",
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
      ].join(" ")
    );

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

    // Compute expires_at (ms)
    if (typeof tokens.expires_in === "number" || /^\d+$/.test(String(tokens.expires_in || ""))) {
      tokens.expires_at = Date.now() + Number(tokens.expires_in) * 1000;
    }

    // Fetch user email from Graph
    let email = null;
    try {
      const me = await (async () => {
        const url = `${GRAPH_BASE}/me`;
        const rr = await fetch(url, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        const t = await rr.text();
        const j = t ? JSON.parse(t) : null;
        return j;
      })();

      // Most common fields:
      // - mail (work/school)
      // - userPrincipalName (work/school)
      // - For personal accounts, sometimes mail is null; still UPN-ish exists.
      email = me?.mail || me?.userPrincipalName || null;
    } catch {
      email = null;
    }

    await saveTokens(userId, tokens, email);

    // iOS auto-close
    if (mode === "app") {
      const deeplink = `loravo://connected?provider=outlook&user_id=${encodeURIComponent(
        userId
      )}&email=${encodeURIComponent(email || "")}`;
      return res.redirect(deeplink);
    }

    // Desktop/manual testing
    const successPage = `${SUCCESS_WEB_BASE}/outlook/connected?user_id=${encodeURIComponent(
      userId
    )}&email=${encodeURIComponent(email || "")}`;
    return res.redirect(successPage);
  } catch (e) {
    res.status(e?.status || 500).send(`OAuth error: ${String(e?.message || e)}`);
  }
});

/* ===================== DISCONNECT ===================== */

// POST /outlook/disconnect  { user_id }
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

// GET /outlook/disconnect?user_id=...
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

// POST /outlook/list  body: { user_id, top?, folder?, search? }
router.post("/list", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const top = Math.min(Number(req.body?.top || 10), 25);
    const folder = String(req.body?.folder || "inbox").toLowerCase();
    const search = req.body?.search ? String(req.body.search) : null;

    // Build request
    // Using /me/mailFolders/{id}/messages for folder support
    // If you want focused inbox later, you can use /me/mailFolders/inbox/messages?$orderby=receivedDateTime desc
    const path = `/me/mailFolders/${encodeURIComponent(folder)}/messages`;
    const query = {
      $top: top,
      $orderby: "receivedDateTime desc",
      $select: "id,subject,bodyPreview,from,receivedDateTime,isRead,conversationId",
    };

    const headers = {};
    // Graph $search requires ConsistencyLevel: eventual and uses AQS
    if (search) {
      query.$search = `"${search.replace(/"/g, '\\"')}"`;
      headers.ConsistencyLevel = "eventual";
    }

    const data = await graphRequest(userId, "GET", path, { query, headers });

    const items = (data?.value || []).map((m) => {
      const who = pickSender(m);
      return {
        id: m.id,
        conversationId: m.conversationId || null,
        subject: m.subject || "",
        from: who.from || who.sender || null,
        date: m.receivedDateTime || null,
        isRead: Boolean(m.isRead),
        snippet: m.bodyPreview || "",
      };
    });

    res.json({ ok: true, folder, top, emails: items });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// POST /outlook/read  body: { user_id, id }
router.post("/read", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    const id = String(req.body?.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const msg = await graphRequest(userId, "GET", `/me/messages/${encodeURIComponent(id)}`, {
      query: {
        $select: "id,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,conversationId,internetMessageId",
      },
    });

    const who = pickSender(msg);
    const to = (msg?.toRecipients || [])
      .map((r) => r?.emailAddress?.address || null)
      .filter(Boolean);

    // Body is HTML usually; we return both preview and body HTML
    res.json({
      ok: true,
      email: {
        id: msg?.id || id,
        conversationId: msg?.conversationId || null,
        internetMessageId: msg?.internetMessageId || null,
        from: who.from || who.sender || null,
        to,
        subject: msg?.subject || "",
        date: msg?.receivedDateTime || null,
        snippet: msg?.bodyPreview || "",
        body_html: msg?.body?.contentType === "html" ? (msg?.body?.content || "") : null,
        body_text: msg?.body?.contentType === "text" ? (msg?.body?.content || "") : null,
      },
    });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e), detail: e?._graph || null });
  }
});

// POST /outlook/send  body: { user_id, to, subject, body, saveToSentItems? }
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

    // Graph sendMail
    const payload = {
      message: {
        subject: subject || "",
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems,
    };

    await graphRequest(userId, "POST", "/me/sendMail", { body: payload });

    res.json({ ok: true, sent: true });
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

    req.body = { user_id: userId, top, folder, search };
    return router.handle(Object.assign(req, { method: "POST", url: "/list" }), res);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// GET /outlook/read?user_id=...&id=...
router.get("/read", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    req.body = { user_id: userId, id };
    return router.handle(Object.assign(req, { method: "POST", url: "/read" }), res);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
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

    req.body = { user_id: userId, to, subject, body };
    return router.handle(Object.assign(req, { method: "POST", url: "/send" }), res);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;