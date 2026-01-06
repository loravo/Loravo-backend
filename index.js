const express = require("express");
const cors = require("cors");
require("dotenv").config();

const fetch = require("node-fetch"); // ✅ makes fetch work on Node < 18

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/ask", async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Missing text" });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY in .env" });
    }

    const system = `
You are LXT-1, a future-positioning intelligence.
Return ONLY valid JSON.
Verdicts: HOLD, PREPARE, MOVE, AVOID.
If unsure, choose HOLD.
Schema:
{"verdict":"HOLD|PREPARE|MOVE|AVOID","confidence":0.0,"one_liner":"VERDICT. short future-based reason"}
`.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: system },
          { role: "user", content: text },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      return res.status(500).json({ error: "Model call failed", detail });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content || "{}";

    let out;
    try {
      out = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: "Bad JSON from model", raw });
    }

    const confidence = Number(out.confidence ?? 0);
    const verdict = String(out.verdict ?? "");
    const one_liner = String(out.one_liner ?? "").trim();

    if (confidence < 0.65) return res.json({ silent: true });

    if (!["HOLD", "PREPARE", "MOVE", "AVOID"].includes(verdict)) {
      return res.status(500).json({ error: "Invalid verdict", out });
    }

    return res.json({ verdict, confidence, message: one_liner });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("LORAVO backend running on port", PORT));