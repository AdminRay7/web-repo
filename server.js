// ══════════════════════════════════════════════════════════════
//  server.js — 303-XMD Web Panel (Repo B)
//  Public Express server. Proxies to bot server. No bot logic.
// ══════════════════════════════════════════════════════════════

"use strict";

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");
const pino = require("pino");

// ── Env ───────────────────────────────────────────────────
const PORT          = Number(process.env.PORT || 3000);
const HOST          = process.env.HOST || "0.0.0.0";
const BOT_API_URL   = process.env.BOT_API_URL || "http://127.0.0.1:4000";
const INTERNAL_KEY  = process.env.INTERNAL_API_KEY;
const PAIR_API_KEY  = process.env.PAIR_API_KEY || "";
const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS || 60_000);
const STATUS_RATE_MS= Number(process.env.STATUS_RATE_MS || 30_000);

if (!INTERNAL_KEY) {
  console.error("❌ INTERNAL_API_KEY not set — cannot reach bot server.");
  process.exit(1);
}

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: process.env.LOG_PRETTY === "true"
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined,
});

// ── HTTP client to bot ────────────────────────────────────
const bot = axios.create({
  baseURL: BOT_API_URL,
  headers: { "x-internal-key": INTERNAL_KEY },
  timeout: 60_000, // pairing can take ~30s
});

// ── Express ───────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// ── Rate limiters (per IP) ────────────────────────────────
const limiterMaps = {
  pair:   new Map(),
  status: new Map(),
  config: new Map(),
};
function limited(bucket, ip, windowMs) {
  const m = limiterMaps[bucket];
  const now = Date.now();
  const last = m.get(ip) || 0;
  if (now - last < windowMs) return true;
  m.set(ip, now);
  return false;
}
function pruneLimiters() {
  const cut = Date.now() - Math.max(RATE_LIMIT_MS * 4, 60_000);
  for (const m of Object.values(limiterMaps)) {
    for (const [ip, ts] of m.entries()) if (ts < cut) m.delete(ip);
  }
}
setInterval(pruneLimiters, 10 * 60 * 1000).unref();

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ── Auth helper ───────────────────────────────────────────
function requireApiKey(req, res) {
  if (!PAIR_API_KEY) return true;
  const key = req.headers["x-api-key"] || req.body?.apiKey || req.query?.apiKey;
  if (key !== PAIR_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── Error helper ──────────────────────────────────────────
function forwardError(res, e) {
  const status = e.response?.status || 500;
  const msg = e.response?.data?.error || e.message || "Internal error";
  logger.warn({ status, msg, path: e.config?.url }, "bot proxy error");
  res.status(status).json({ error: msg });
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

// Static UI
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Public metadata (safe subset of bot info)
app.get("/api", async (_req, res) => {
  try {
    const { data } = await bot.get("/internal/health");
    res.json({
      bot: data.bot,
      version: data.version,
      sessions: data.sessions,
      capacity: data.capacity,
      commands: data.commands,
      uptime: data.uptime,
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: "Bot unreachable" });
  }
});

// ── /pair ─────────────────────────────────────────────────
app.post("/pair", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  if (limited("pair", ip, RATE_LIMIT_MS)) {
    return res.status(429).json({ error: "Too many attempts, wait a minute" });
  }

  try {
    const { data } = await bot.post("/internal/pair", {
      phone: req.body?.phone,
      botName: req.body?.botName,
    });
    return res.json(data);
  } catch (e) {
    return forwardError(res, e);
  }
});

// ── /status/:sessionId ────────────────────────────────────
app.get("/status/:sessionId", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  if (limited("status", ip, STATUS_RATE_MS)) {
    return res.status(429).json({ error: "Slow down" });
  }

  try {
    const { data } = await bot.get(`/internal/status/${encodeURIComponent(req.params.sessionId)}`);
    return res.json(data);
  } catch (e) {
    return forwardError(res, e);
  }
});

// ── /config/:sessionId ────────────────────────────────────
app.post("/config/:sessionId", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const ip = clientIp(req);
  if (limited("config", ip, RATE_LIMIT_MS)) {
    return res.status(429).json({ error: "Slow down" });
  }

  try {
    const { data } = await bot.post(
      `/internal/config/${encodeURIComponent(req.params.sessionId)}`,
      req.body || {}
    );
    return res.json(data);
  } catch (e) {
    return forwardError(res, e);
  }
});

// ── /commands (public list) ───────────────────────────────
app.get("/commands", async (_req, res) => {
  try {
    const { data } = await bot.get("/internal/commands");
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: "Bot unreachable" });
  }
});

// ── /reload (admin, needs both keys) ──────────────────────
app.post("/reload", async (req, res) => {
  if (!requireApiKey(req, res)) return;
  try {
    const { data } = await bot.post("/internal/reload");
    res.json(data);
  } catch (e) {
    forwardError(res, e);
  }
});

// ── /health ───────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const { data } = await bot.get("/internal/health");
    res.json({ ok: true, web: "up", bot: data });
  } catch {
    res.status(503).json({ ok: false, web: "up", bot: "down" });
  }
});

// ── 404 ───────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── Error handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message }, "unhandled");
  res.status(500).json({ error: "Internal error" });
});

// ══════════════════════════════════════════════════════════
//  Boot + graceful shutdown
// ══════════════════════════════════════════════════════════
const server = app.listen(PORT, HOST, () => {
  console.log(`🌐 Web panel → http://${HOST}:${PORT}`);
  console.log(`   Bot API    → ${BOT_API_URL}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} already in use.`);
    process.exit(1);
  }
  console.error("Server error:", err);
});

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
function shutdown(sig) {
  console.log(`\n${sig} received — shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("uncaughtException", (e) => console.error("Uncaught Exception:", e));
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
