// Emails/yahoo.js
// =====================================================
// LORAVO — Yahoo Mail (single-file router)
//
// ✅ OAuth2 connect (auth-url + callback)
// ✅ Stores tokens in Postgres user_state (Render DATABASE_URL)
// ✅ Status, list, read, send, reply
// ✅ Disconnect (GET + POST)
// ✅ iOS auto-close: mode=app -> redirects to loravo://connected (no success page)
// ✅ Browser success page (for desktop/manual testing)
//
// Mount in index.js:
//   const yahoo = require("./Emails/yahoo");
//   app.use("/yahoo", yahoo);
//
// Required env:
//   YAHOO_CLIENT_ID
//   YAHOO_CLIENT_SECRET
//   YAHOO_REDIRECT_URI   (must match your Yahoo app redirect URI exactly)
//
// Optional env:
//   DATABASE_URL
//   YAHOO_STATE_SECRET
//   YAHOO_SUCCESS_WEB_URL (default https://loravo-backend.onrender.com)
//   YAHOO_SCOPES (default: "openid profile email")
//
// Required npm deps:
//   npm i imap mailparser nodemailer
// =====================================================

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

// IMAP + parsing + SMTP
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

/* ===================== CONFIG ===================== */

const CLIENT_ID = String(process.env.YAHOO_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.YAHOO_CLIENT_SECRET || "").trim();
const REDIRECT_URI = String(process.env.YAHOO_REDIRECT_URI || "").trim();

const STATE_SECRET = String(process.env.YAHOO_STATE_SECRET || "loravo_yahoo_state_secret_change_me").trim();
const SCOPES = String(process.env.YAHOO_SCOPES || "openid profile email mail-r mail-w").trim();

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const DB_ENABLED = Boolean(DATABASE_URL);

const SUCCESS_WEB_BASE =
  String(process.env.YAHOO_SUCCESS_WEB_URL || "").trim() ||
  "https://loravo-backend.onrender.com";

// Yahoo OAuth endpoints
const YAHOO_AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const YAHOO_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const YAHOO_USERINFO_URL = "https://api.login.yahoo.com/openid/v1/userinfo";

// Yahoo Mail servers (IMAP/SMTP)
const YAHOO_IMAP_HOST = "imap.mail.yahoo.com";
const YAHOO_IMAP_PORT = 993;
const YAHOO_SMTP_HOST = "smtp.mail.yahoo.com";
const YAHOO_SMTP_PORT = 465;

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

/* ===================== DB INIT ===================== */

async function initDbIfPossible() {
  if (!pool) {
    dbReady = false;
    return;
  }
  try {
    await pool.query("SELECT 1");
    dbReady = true;
  } catch (e) {
    dbReady = false;
    console.error("⚠️ Yahoo DB init failed:", e?.message || e);
  }
}
initDbIfPossible().catch(() => {});

/* ===================== HELPERS ===================== */

function requireEnv() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    const missing = [
      !CLIENT_ID ? "YAHOO_CLIENT_ID" : null,
      !CLIENT_SECRET ? "YAHOO_CLIENT_SECRET" : null,
      !REDIRECT_URI ? "YAHOO_REDIRECT_URI" : null,
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

/* ===================== TOKEN STORAGE (user_state) ===================== */

async function ensureUserStateRow(userId) {
  if (!dbReady) return;
  await dbQuery(
    `INSERT INTO user_state (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [String(userId)]
  );
}

async function saveYahooTokens(userId, tokenResponse, emailGuess) {
  if (!dbReady) {
    const err = new Error("DATABASE_URL not set / DB not ready. Yahoo requires DB storage in your setup.");
    err.status = 500;
    throw err;
  }
  if (!userId || !tokenResponse) return;

  const accessToken = tokenResponse.access_token || null;
  const refreshToken = tokenResponse.refresh_token || null;
  const expiresIn = Number(tokenResponse.expires_in || 0);
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  await ensureUserStateRow(userId);

  await dbQuery(
    `
    UPDATE user_state
    SET
      yahoo_connected = $2,
      yahoo_email = $3,
      yahoo_access_token = $4,
      yahoo_refresh_token = $5,
      yahoo_token_expires_at = $6,
      updated_at = NOW()
    WHERE user_id = $1
    `,
    [String(userId), true, emailGuess || null, accessToken, refreshToken, expiresAt]
  );
}

async function loadYahooRecord(userId) {
  if (!dbReady) return null;
  const { rows } = await dbQuery(
    `
    SELECT
      user_id,
      yahoo_connected,
      yahoo_email,
      yahoo_access_token,
      yahoo_refresh_token,
      yahoo_token_expires_at,
      updated_at
    FROM user_state
    WHERE user_id = $1
    LIMIT 1
    `,
    [String(userId)]
  );
  return rows?.[0] || null;
}

async function clearYahooTokens(userId) {
  if (!dbReady) return;
  await ensureUserStateRow(userId);
  await dbQuery(
    `
    UPDATE user_state
    SET
      yahoo_connected = FALSE,
      yahoo_email = NULL,
      yahoo_access_token = NULL,
      yahoo_refresh_token = NULL,
      yahoo_token_expires_at = NULL,
      updated_at = NOW()
    WHERE user_id = $1
    `,
    [String(userId)]
  );
}

/* ===================== OAUTH TOKEN REFRESH ===================== */

async function refreshYahooAccessToken(refreshToken) {
  requireEnv();
  if (!refreshToken) {
    const err = new Error("Missing Yahoo refresh_token. Reconnect Yahoo with prompt=consent.");
    err.status = 401;
    throw err;
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", String(refreshToken));
  body.set("redirect_uri", REDIRECT_URI);

  const resp = await fetch(YAHOO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!resp.ok) {
    const msg = `Yahoo token refresh failed (${resp.status}): ${text}`;
    const err = new Error(msg);
    err.status = 401;
    throw err;
  }

  return json || {};
}

async function getValidYahooAccessToken(userId) {
  const rec = await loadYahooRecord(userId);
  if (!rec?.yahoo_connected || !rec?.yahoo_access_token) {
    const err = new Error("Yahoo not connected for this user_id. Call /yahoo/auth first.");
    err.status = 401;
    throw err;
  }

  const exp = rec.yahoo_token_expires_at ? new Date(rec.yahoo_token_expires_at).getTime() : 0;
  const needsRefresh = exp && Date.now() > exp - 60_000;

  if (!needsRefresh) {
    return {
      accessToken: rec.yahoo_access_token,
      refreshToken: rec.yahoo_refresh_token,
      email: rec.yahoo_email,
      record: rec,
    };
  }

  const refreshed = await refreshYahooAccessToken(rec.yahoo_refresh_token);
  const merged = {
    access_token: refreshed.access_token || rec.yahoo_access_token,
    refresh_token: refreshed.refresh_token || rec.yahoo_refresh_token,
    expires_in: refreshed.expires_in || 0,
  };

  await saveYahooTokens(userId, merged, rec.yahoo_email || null);

  const rec2 = await loadYahooRecord(userId);
  return {
    accessToken: rec2?.yahoo_access_token,
    refreshToken: rec2?.yahoo_refresh_token,
    email: rec2?.yahoo_email,
    record: rec2,
  };
}

/* ===================== IMAP/SMTP HELPERS ===================== */

function buildXOAuth2(user, accessToken) {
  const s = `user=${user}\x01auth=Bearer ${accessToken}\x01\x01`;
  return Buffer.from(s, "utf8").toString("base64");
}

function parseHeaderValue(rawHeaderBlock, key) {
  if (!rawHeaderBlock) return null;
  const lines = String(rawHeaderBlock).split(/\r?\n/);
  const lowerKey = String(key).toLowerCase();

  const unfolded = [];
  for (const line of lines) {
    if (/^\s/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }

  for (const l of unfolded) {
    const idx = l.indexOf(":");
    if (idx <= 0) continue;
    const k = l.slice(0, idx).trim().toLowerCase();
    if (k === lowerKey) return l.slice(idx + 1).trim();
  }
  return null;
}

function relativeShort(d) {
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(secs / 3600);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(secs / 86400);
  return `${days}d`;
}

/* ===================== ROUTES ===================== */

router.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "loravo-yahoo-router",
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

// GET /yahoo/auth?user_id=...&mode=app?
router.get("/auth", (req, res) => {
  const userId = String(req.query.user_id || "").trim();
  const mode = String(req.query.mode || "").trim();
  if (!userId) return res.status(400).send("Missing user_id");
  const extra = mode ? `&mode=${encodeURIComponent(mode)}` : "";
  return res.redirect(`/yahoo/auth-url?user_id=${encodeURIComponent(userId)}${extra}`);
});

// GET /yahoo/status?user_id=...
router.get("/status", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const rec = await loadYahooRecord(userId);
    res.json({
      ok: true,
      connected: Boolean(rec?.yahoo_connected && rec?.yahoo_access_token),
      dbReady,
      email: rec?.yahoo_email || null,
      token_expires_at: rec?.yahoo_token_expires_at || null,
      updated_at: rec?.updated_at || null,
    });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// GET /yahoo/auth-url?user_id=...&mode=app?
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

       const params = new URLSearchParams();
    params.set("client_id", CLIENT_ID);
    params.set("redirect_uri", REDIRECT_URI);
    params.set("response_type", "code");
    params.set("state", state);
    params.set("language", "en-us");

// ✅ REQUIRED: without this you often won't get mail permissions → IMAP fails → 500 in /list
params.set("scope", SCOPES);

// ✅ IMPORTANT: helps ensure refresh_token is issued
params.set("prompt", "consent");

    const url = `${YAHOO_AUTH_URL}?${params.toString()}`;
    res.json({ ok: true, url });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// Browser success page: GET /yahoo/connected?user_id=...&email=...
router.get("/connected", (req, res) => {
  const email = String(req.query.email || "");
  const userId = String(req.query.user_id || "");
  res.setHeader("Content-Type", "text/html");
  res.send(`
    <html>
      <head>
        <title>Loravo Yahoo Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="font-family: -apple-system, system-ui; padding: 28px; line-height: 1.4;">
        <h1 style="margin:0 0 12px 0;">✅ Yahoo Connected</h1>
        <p style="margin:0 0 18px 0;">${email ? `Connected as <b>${email}</b>.` : "Connection saved."}</p>

        <p style="margin:0 0 10px 0; opacity:.75;">
          If you’re on iPhone, go back to Loravo. If Loravo didn’t open automatically, tap the button below.
        </p>

        <a href="loravo://connected?provider=yahoo&user_id=${encodeURIComponent(userId)}&email=${encodeURIComponent(email)}"
           style="display:inline-block; padding:12px 16px; border-radius:12px; background:#111; color:#fff; text-decoration:none;">
          Open Loravo
        </a>
      </body>
    </html>
  `);
});

// OAuth callback: GET /yahoo/oauth2callback?code=...&state=...
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

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", REDIRECT_URI);

    const resp = await fetch(YAHOO_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const text = await resp.text();
    let tokenJson = null;
    try { tokenJson = JSON.parse(text); } catch {}

    if (!resp.ok || !tokenJson?.access_token) {
      return res.status(500).send(`Yahoo OAuth token exchange failed (${resp.status}): ${text}`);
    }

    // ✅ IMPORTANT: fetch the user's email via OIDC userinfo
    let emailGuess = null;
    try {
      const u = await fetch(YAHOO_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const uText = await u.text();
      let userinfo = null;
      try { userinfo = JSON.parse(uText); } catch {}
      emailGuess = userinfo?.email || null;
    } catch (e) {
      console.warn("Yahoo userinfo fetch failed:", e?.message || e);
    }

    await saveYahooTokens(userId, tokenJson, emailGuess);

    if (mode === "app") {
      const deeplink = `loravo://connected?provider=yahoo&user_id=${encodeURIComponent(userId)}&email=${encodeURIComponent(
        emailGuess || ""
      )}`;
      return res.redirect(deeplink);
    }

    const successPage = `${SUCCESS_WEB_BASE}/yahoo/connected?user_id=${encodeURIComponent(
      userId
    )}&email=${encodeURIComponent(emailGuess || "")}`;
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
    await clearYahooTokens(userId);
    res.json({ ok: true, disconnected: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

router.get("/disconnect", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    await clearYahooTokens(userId);
    res.json({ ok: true, disconnected: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

/* ===================== MAIL API ===================== */

// GET /yahoo/list?user_id=...&maxResults=...
router.get("/list", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const maxResults = Math.min(Number(req.query.maxResults || 10), 25);
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const { accessToken, email } = await getValidYahooAccessToken(userId);

    if (!email) {
      return res.json({ ok: true, q: "INBOX", emails: [] });
    }

    const xoauth2 = buildXOAuth2(email, accessToken);

    const imap = new Imap({
      user: email,
      xoauth2,
      host: YAHOO_IMAP_HOST,
      port: YAHOO_IMAP_PORT,
      tls: true,
      autotls: "always",
      tlsOptions: { servername: YAHOO_IMAP_HOST },
    });

    const emailsOut = [];

    await new Promise((resolve, reject) => {
      imap.once("ready", () => {
        imap.openBox("INBOX", true, (err, box) => {
          if (err) return reject(err);

          const total = box.messages.total || 0;

          // ✅ FIX: empty inbox -> don't fetch 1:0
          if (!total || total <= 0) {
            imap.end();
            return resolve();
          }

          const start = Math.max(1, total - maxResults + 1);
          const range = `${start}:${total}`;

          const f = imap.fetch(range, {
            bodies: "HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)",
            struct: false,
          });

          f.on("message", (msg) => {
            let headerBuf = "";
            let attrs = null;

            msg.on("body", (stream) => {
              stream.on("data", (chunk) => (headerBuf += chunk.toString("utf8")));
            });

            msg.once("attributes", (a) => {
              attrs = a;
            });

            msg.once("end", () => {
              const from = parseHeaderValue(headerBuf, "From");
              const to = parseHeaderValue(headerBuf, "To");
              const subject = parseHeaderValue(headerBuf, "Subject");
              const dateStr = parseHeaderValue(headerBuf, "Date");
              const messageId = parseHeaderValue(headerBuf, "Message-Id");

              emailsOut.push({
                id: String(attrs?.uid || ""),
                threadId: null,
                from: from || "",
                to: to || "",
                subject: subject || "",
                date: dateStr || "",
                messageId: messageId || "",
                snippet: "",
              });
            });
          });

          f.once("error", reject);
          f.once("end", () => {
            imap.end();
            resolve();
          });
        });
      });

      imap.once("error", reject);
      imap.connect();
    });

    emailsOut.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    res.json({ ok: true, q: "INBOX", emails: emailsOut });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// GET /yahoo/read?user_id=...&id=...
router.get("/read", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });

    const { accessToken, email } = await getValidYahooAccessToken(userId);
    if (!email) return res.status(400).json({ error: "Yahoo connected but email missing; reconnect." });

    const xoauth2 = buildXOAuth2(email, accessToken);

    const imap = new Imap({
      user: email,
      xoauth2,
      host: YAHOO_IMAP_HOST,
      port: YAHOO_IMAP_PORT,
      tls: true,
      autotls: "always",
      tlsOptions: { servername: YAHOO_IMAP_HOST },
    });

    let raw = "";

    await new Promise((resolve, reject) => {
      imap.once("ready", () => {
        imap.openBox("INBOX", true, (err) => {
          if (err) return reject(err);

          const f = imap.fetch(String(id), { bodies: "" });
          f.on("message", (msg) => {
            msg.on("body", (stream) => {
              stream.on("data", (chunk) => (raw += chunk.toString("utf8")));
            });
          });
          f.once("error", reject);
          f.once("end", () => {
            imap.end();
            resolve();
          });
        });
      });
      imap.once("error", reject);
      imap.connect();
    });

    const parsed = await simpleParser(raw);

    res.json({
      ok: true,
      email: {
        id,
        threadId: null,
        from: parsed.from?.text || "",
        to: parsed.to?.text || "",
        subject: parsed.subject || "",
        date: parsed.date ? parsed.date.toString() : "",
        messageId: parsed.messageId || "",
        references: (parsed.references || []).join(" "),
        inReplyTo: parsed.inReplyTo || "",
        snippet: (parsed.text || "").slice(0, 180),
        body_text: parsed.text || "",
      },
    });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// GET /yahoo/send?user_id=...&to=...&subject=...&body=...
router.get("/send", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const to = String(req.query.to || "").trim();
    const subject = String(req.query.subject || "").trim();
    const body = String(req.query.body || "").trim();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!to) return res.status(400).json({ error: "Missing to" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const { accessToken, refreshToken, email } = await getValidYahooAccessToken(userId);
    if (!email) return res.status(400).json({ error: "Yahoo connected but email missing; reconnect." });

    const transport = nodemailer.createTransport({
      host: YAHOO_SMTP_HOST,
      port: YAHOO_SMTP_PORT,
      secure: true,
      auth: {
        type: "OAuth2",
        user: email,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: refreshToken || undefined,
        accessToken: accessToken,
      },
    });

    const info = await transport.sendMail({
      from: email,
      to,
      subject: subject || "",
      text: body,
    });

    res.json({ ok: true, id: info?.messageId || null, threadId: null });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// GET /yahoo/reply?user_id=...&id=...&body=...
router.get("/reply", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const id = String(req.query.id || "").trim();
    const body = String(req.query.body || "").trim();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!body) return res.status(400).json({ error: "Missing body" });

    const readResp = await fetch(
      `${SUCCESS_WEB_BASE}/yahoo/read?user_id=${encodeURIComponent(userId)}&id=${encodeURIComponent(id)}`
    );
    const readJson = await readResp.json();
    if (!readResp.ok || !readJson?.ok) {
      return res.status(500).json({ error: readJson?.error || "Failed to read original email." });
    }

    const original = readJson.email || {};
    const to = original.from || "";
    const subj0 = original.subject || "";
    const subject = /^re:/i.test(subj0) ? subj0 : `Re: ${subj0}`;
    const inReplyTo = original.messageId || undefined;
    const references = original.references || undefined;

    const { accessToken, refreshToken, email } = await getValidYahooAccessToken(userId);
    if (!email) return res.status(400).json({ error: "Yahoo connected but email missing; reconnect." });

    const transport = nodemailer.createTransport({
      host: YAHOO_SMTP_HOST,
      port: YAHOO_SMTP_PORT,
      secure: true,
      auth: {
        type: "OAuth2",
        user: email,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: refreshToken || undefined,
        accessToken: accessToken,
      },
    });

    const info = await transport.sendMail({
      from: email,
      to,
      subject,
      text: body,
      headers: {
        ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
        ...(references ? { References: references } : {}),
      },
    });

    res.json({ ok: true, id: info?.messageId || null, threadId: null });
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

module.exports = router;