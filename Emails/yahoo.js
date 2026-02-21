// Emails/yahoo.js
// =====================================================
// LORAVO — Yahoo Mail (single-file router)
//
// ✅ OAuth2 connect (auth + callback)
// ✅ Stores tokens in Postgres user_state (Render DATABASE_URL)
// ✅ Status, list, read, send, reply
// ✅ Disconnect (GET + POST)
// ✅ iOS auto-close: mode=app -> redirects to loravo://connected
// ✅ Web success page (desktop/manual testing)
//
// Mount in index.js:
//   const yahooPkg = require("./Emails/yahoo");
//   app.use("/yahoo", yahooPkg.router);
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
//   YAHOO_SCOPES (default: "openid profile email")  <-- keep simple to avoid invalid_scope
//
// Required npm deps:
//   npm i node-fetch@2 imap mailparser nodemailer
// =====================================================

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // ✅ REQUIRED (you used fetch before)
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

// ✅ KEEP SIMPLE to avoid Yahoo "invalid_scope"
const SCOPES = String(process.env.YAHOO_SCOPES || "openid profile email").trim();

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
    const err = new Error("Missing Yahoo refresh_token. Reconnect Yahoo (prompt=consent).");
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

/* ===================== ROUTES ===================== */

router.get("/", (_, res) => {
  res.json({
    ok: true,
    service: "loravo-yahoo-router",
    dbReady,
    scopes: SCOPES,
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

// GET /yahoo/auth?user_id=...&mode=app&email=...
router.get("/auth", (req, res) => {
  const userId = String(req.query.user_id || "").trim();
  const mode = String(req.query.mode || "").trim();
  const email = String(req.query.email || "").trim();

  if (!userId) return res.status(400).send("Missing user_id");

  const redirectTo = `/yahoo/auth-url?user_id=${encodeURIComponent(userId)}${
    mode ? `&mode=${encodeURIComponent(mode)}` : ""
  }${email ? `&email=${encodeURIComponent(email)}` : ""}`;

  return res.redirect(redirectTo);
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

// GET /yahoo/auth-url?user_id=...&mode=app&email=...
// Default: redirects to Yahoo. Debug: add &format=json
router.get("/auth-url", async (req, res) => {
  try {
    requireEnv();
    const userId = String(req.query.user_id || "").trim();
    const mode = String(req.query.mode || "").trim();
    const email = String(req.query.email || "").trim();
    const format = String(req.query.format || "").trim().toLowerCase();

    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const state = signState({
      user_id: userId,
      mode: mode || "",
      email: email || "",
      nonce: crypto.randomBytes(12).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000,
    });

    const params = new URLSearchParams();
    params.set("client_id", CLIENT_ID);
    params.set("redirect_uri", REDIRECT_URI);
    params.set("response_type", "code");
    params.set("state", state);
    params.set("language", "en-us");
    params.set("scope", SCOPES);
    params.set("prompt", "consent");

    const url = `${YAHOO_AUTH_URL}?${params.toString()}`;

    if (format === "json") {
      return res.json({ ok: true, url, scopes: SCOPES });
    }
    return res.redirect(url);
  } catch (e) {
    res.status(e?.status || 500).json({ error: String(e?.message || e) });
  }
});

// Web success page: GET /yahoo/connected?user_id=...&email=...
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
          If you’re on iPhone, go back to Loravo. If Loravo didn’t open automatically, tap below.
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
    const oauthErr = String(req.query.error || "").trim();
    const oauthDesc = String(req.query.error_description || "").trim();
    if (oauthErr) {
      const msg = `Yahoo OAuth error: ${oauthErr}${oauthDesc ? " — " + oauthDesc : ""}`;
      const state = verifyState(String(req.query.state || "").trim());
      if (state?.mode === "app") return res.status(400).json({ ok: false, error: msg });
      return res.status(400).send(msg);
    }

    requireEnv();

    const code = String(req.query.code || "").trim();
    const stateStr = String(req.query.state || "").trim();

    if (!code) {
      return res.status(400).send(`Missing code. Query received: ${JSON.stringify(req.query)}`);
    }

    const state = verifyState(stateStr);
    if (!state?.user_id) {
      return res.status(400).send("Invalid state (expired or tampered)");
    }

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
    try {
      tokenJson = JSON.parse(text);
    } catch {}

    if (!resp.ok || !tokenJson?.access_token) {
      return res.status(500).send(`Yahoo OAuth token exchange failed (${resp.status}): ${text}`);
    }

    // Try to get email from userinfo
    let emailGuess = null;
    try {
      const u = await fetch(YAHOO_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const uText = await u.text();
      let userinfo = null;
      try {
        userinfo = JSON.parse(uText);
      } catch {}
      emailGuess = userinfo?.email || null;
    } catch (e) {
      console.warn("Yahoo userinfo fetch failed:", e?.message || e);
    }

    // fallback: email passed into state (from iOS)
    if (!emailGuess) {
      emailGuess = String(state.email || "").trim() || null;
    }

    await saveYahooTokens(userId, tokenJson, emailGuess);

    if (mode === "app") {
      const deeplink = `loravo://connected?provider=yahoo&user_id=${encodeURIComponent(
        userId
      )}&email=${encodeURIComponent(emailGuess || "")}`;
      return res.redirect(deeplink);
    }

    const successPage = `${SUCCESS_WEB_BASE}/yahoo/connected?user_id=${encodeURIComponent(
      userId
    )}&email=${encodeURIComponent(emailGuess || "")}`;
    return res.redirect(successPage);
  } catch (e) {
    return res.status(e?.status || 500).send(`OAuth error: ${String(e?.message || e)}`);
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

/* ===================== MAIL API (GET routes) ===================== */

// GET /yahoo/list?user_id=...&maxResults=...
router.get("/list", async (req, res) => {
  try {
    const userId = String(req.query.user_id || "").trim();
    const maxResults = Math.min(Number(req.query.maxResults || 10), 25);
    if (!userId) return res.status(400).json({ error: "Missing user_id" });

    const { accessToken, email } = await getValidYahooAccessToken(userId);

    if (!email) {
      return res.status(400).json({
        error: "Yahoo connected but email missing. Reconnect Yahoo (userinfo did not return email).",
      });
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
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          imap.end();
        } catch {}
        reject(err);
      };

      imap.once("ready", () => {
        imap.openBox("INBOX", true, (err, box) => {
          if (err) return fail(err);

          const total = box?.messages?.total || 0;
          if (!total || total <= 0) {
            settled = true;
            imap.end();
            return resolve();
          }

          const start = Math.max(1, total - maxResults + 1);
          const range = `${start}:${total}`;

          const f = imap.fetch(range, {
            bodies: "HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)",
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
              emailsOut.push({
                id: String(attrs?.uid || ""),
                from: parseHeaderValue(headerBuf, "From") || "",
                to: parseHeaderValue(headerBuf, "To") || "",
                subject: parseHeaderValue(headerBuf, "Subject") || "",
                date: parseHeaderValue(headerBuf, "Date") || "",
                messageId: parseHeaderValue(headerBuf, "Message-Id") || "",
                snippet: "",
                threadId: null,
              });
            });
          });

          f.once("error", fail);
          f.once("end", () => {
            settled = true;
            imap.end();
            resolve();
          });
        });
      });

      imap.once("error", (err) => fail(err));
      imap.connect();
    });

    // newest first
    emailsOut.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    return res.json({ ok: true, q: "INBOX", emails: emailsOut });
  } catch (e) {
    const msg = String(e?.message || e);
    const looksAuth =
      /AUTH|authentication|Invalid credentials|NO \[AUTHENTICATIONFAILED\]|LOGIN failed|oauth/i.test(msg);

    return res.status(looksAuth ? 401 : 500).json({
      error: msg,
      hint: looksAuth
        ? "Yahoo IMAP OAuth2 auth failed. Your Yahoo app likely does NOT have Mail/IMAP permission enabled. Enable Yahoo Mail scopes in Yahoo Developer Console OR use Yahoo App Password IMAP."
        : null,
    });
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

    // Read original
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

// ===================== SERVICE API (for LXT / index.js) =====================

async function svcGetConnectedProviders({ userId }) {
  const rec = await loadYahooRecord(userId);
  return rec?.yahoo_connected && rec?.yahoo_access_token ? ["yahoo"] : [];
}

async function svcList({ userId, q = null, max = 10 }) {
  // Yahoo IMAP search is more work; for now: newest messages like /list
  const maxResults = Math.min(Number(max || 10), 25);

  // If q provided, we ignore it for now (keep stable).
  // You can later implement IMAP SEARCH with SUBJECT/TEXT.
  const { accessToken, email } = await getValidYahooAccessToken(userId);
  if (!email) throw new Error("Yahoo connected but email missing; reconnect.");

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
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        imap.end();
      } catch {}
      reject(err);
    };

    imap.once("ready", () => {
      imap.openBox("INBOX", true, (err, box) => {
        if (err) return fail(err);

        const total = box?.messages?.total || 0;
        if (!total || total <= 0) {
          settled = true;
          imap.end();
          return resolve();
        }

        const start = Math.max(1, total - maxResults + 1);
        const range = `${start}:${total}`;

        const f = imap.fetch(range, {
          bodies: "HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)",
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
            emailsOut.push({
              id: String(attrs?.uid || ""),
              threadId: null,
              messageId: parseHeaderValue(headerBuf, "Message-Id") || null,
              from: parseHeaderValue(headerBuf, "From") || "",
              subject: parseHeaderValue(headerBuf, "Subject") || "",
              date: parseHeaderValue(headerBuf, "Date") || "",
              snippet: "",
            });
          });
        });

        f.once("error", fail);
        f.once("end", () => {
          settled = true;
          imap.end();
          resolve();
        });
      });
    });

    imap.once("error", (err) => fail(err));
    imap.connect();
  });

  emailsOut.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  return emailsOut;
}

async function svcGetBody({ userId, messageId }) {
  // messageId here is IMAP UID in our yahoo routes
  const { accessToken, email } = await getValidYahooAccessToken(userId);
  if (!email) throw new Error("Yahoo connected but email missing; reconnect.");

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

        const f = imap.fetch(String(messageId), { bodies: "" });
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

  return {
    id: String(messageId),
    threadId: null,
    messageId: parsed.messageId || null,
    from: parsed.from?.text || "",
    subject: parsed.subject || "",
    date: parsed.date ? parsed.date.toString() : "",
    snippet: (parsed.text || "").slice(0, 180),
    body: parsed.text || "",
  };
}

async function svcSend({ userId, to, subject, body, threadId = null }) {
  const { accessToken, refreshToken, email } = await getValidYahooAccessToken(userId);
  if (!email) throw new Error("Yahoo connected but email missing; reconnect.");

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
    text: body || "",
  });

  return { id: info?.messageId || null, threadId: threadId || null };
}

async function svcReplyById({ userId, messageId, body }) {
  // Uses your existing /reply flow
  const url = `${SUCCESS_WEB_BASE}/yahoo/reply?user_id=${encodeURIComponent(userId)}&id=${encodeURIComponent(
    messageId
  )}&body=${encodeURIComponent(body || "")}`;

  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) throw new Error(j?.error || "Yahoo reply failed");
  return { id: j?.id || null, threadId: null };
}

async function svcReplyLatest({ userId, body }) {
  const list = await svcList({ userId, max: 1 });
  const latest = list?.[0];
  if (!latest?.id) throw new Error("No Yahoo emails found to reply to.");
  return svcReplyById({ userId, messageId: latest.id, body });
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