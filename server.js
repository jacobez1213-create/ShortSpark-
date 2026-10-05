import express from "express";
import Stripe from "stripe";
import Replicate from "replicate";
import ffmpegPath from "ffmpeg-static";
import { Pool } from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import helmet from "helmet";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const PORT = process.env.PORT || 4242;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const COOKIE_SECRET = process.env.COOKIE_SECRET || ADMIN_PASSWORD;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const replicate = process.env.REPLICATE_API_TOKEN ? new Replicate({ auth: process.env.REPLICATE_API_TOKEN }) : null;
const priceIds = { creator: process.env.STRIPE_PRICE_CREATOR, pro: process.env.STRIPE_PRICE_PRO };
const VIDEO_MODEL = process.env.VIDEO_MODEL || "wan-video/wan-2.2-5b-fast";
const TTS_MODEL = process.env.TTS_MODEL || "inworld/realtime-tts-1.5-mini";
const FREE_VIDEOS_PER_DAY = Math.max(1, Number(process.env.FREE_VIDEOS_PER_DAY || 1));
const CREATOR_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.CREATOR_VIDEOS_PER_MONTH || 10));
const PRO_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.PRO_VIDEOS_PER_MONTH || 24));
const OWNER_EMAIL = normalizeEmail(process.env.OWNER_EMAIL || "");
const OWNER_ACCESS_CODE = String(process.env.OWNER_ACCESS_CODE || "");

const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;
const jobs = new Map();

const STYLE_OPTIONS = new Set(["Fast & viral", "Storytelling", "Funny", "Mysterious", "Educational"]);
const rateBuckets = new Map();
function requesterKey(req) {
  return hashValue(req.ip || req.socket.remoteAddress || "unknown");
}
function rateLimit(name, { windowMs, max, keyFn = requesterKey }) {
  return (req, res, next) => {
    const key = `${name}:${keyFn(req)}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    next();
  };
}
function sameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "Request origin could not be verified." });
  const configured = String(process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
  const expected = configured || `${req.protocol}://${req.get("host")}`;
  if (origin !== expected) return res.status(403).json({ error: "Request origin could not be verified." });
  next();
}

function sign(value) { return crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest("hex"); }
function makeToken() { return crypto.randomBytes(32).toString("hex"); }
function hashValue(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function cookieOptions(maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
function adminSessionCookie(req) {
  const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("ss_admin="));
  if (!raw) return null;
  const value = decodeURIComponent(raw.slice("ss_admin=".length));
  const [token, sig] = value.split(".");
  const expected = sign(token || "");
  if (!token || !sig || sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? token : null;
}
function requireAdmin(req, res, next) {
  if (!adminSessionCookie(req)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function requireDb() { if (!db) throw new Error("Database is not configured."); }
function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
function isOwnerAccount(row) { return !!OWNER_EMAIL && normalizeEmail(row?.email) === OWNER_EMAIL; }
function effectivePlanForUser(row) {
  return (row?.complimentary_pro || isOwnerAccount(row)) ? "pro" : (row?.plan || "free");
}
function effectiveUser(row) { return row ? { ...row, plan: effectivePlanForUser(row) } : row; }
function publicUser(row) { return { id: row.id, email: row.email, plan: effectivePlanForUser(row), complimentaryPro: !!row.complimentary_pro || isOwnerAccount(row), createdAt: row.created_at }; }
function planFromPrice(priceId) {
  if (priceId && priceId === priceIds.pro) return "pro";
  if (priceId && priceId === priceIds.creator) return "creator";
  return "free";
}
function planLimit(plan) {
  if (plan === "pro") return { period: "month", limit: PRO_VIDEOS_PER_MONTH };
  if (plan === "creator") return { period: "month", limit: CREATOR_VIDEOS_PER_MONTH };
  return { period: "day", limit: FREE_VIDEOS_PER_DAY };
}

function pbkdf2Async(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(
      password,
      salt,
      100000,
      32,
      "sha256",
      (err, key) => err ? reject(err) : resolve(key.toString("hex"))
    )
  );
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `pbkdf2$${salt}$${await pbkdf2Async(password, salt)}`;
}
async function verifyPassword(password, encoded) {
  const [algorithm, salt, stored] = String(encoded).split("$");
  if (!salt || !stored) return false;
  if (algorithm !== "pbkdf2") {
    // Older account records from the MVP used scrypt. They are intentionally
    // not verified here because that configuration can exceed memory limits
    // on the free Render instance. Users with legacy records can reset their
    // password through a future account-recovery flow.
    return false;
  }
  const derived = await pbkdf2Async(password, salt);
  const expected = Buffer.from(stored, "hex");
  const actual = Buffer.from(derived, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

async function createUserSession(res, userId) {
  requireDb();
  const raw = makeToken();
  await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')", [hashValue(raw), userId]);
  res.setHeader("Set-Cookie", `ss_session=${encodeURIComponent(raw)}; ${cookieOptions(30 * 24 * 60 * 60)}`);
}
async function currentUser(req) {
  if (!db) return null;
  const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("ss_session="));
  if (!raw) return null;
  const token = decodeURIComponent(raw.slice("ss_session=".length));
  const result = await db.query("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()", [hashValue(token)]);
  return effectiveUser(result.rows[0] || null);
}
async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in to continue." });
    req.user = user;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Account service is unavailable." });
  }
}

async function initDb() {
  if (!db) { console.warn("DATABASE_URL missing: accounts are disabled."); return; }
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      complimentary_pro BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users(stripe_customer_id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS video_generations (
      job_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idea TEXT NOT NULL,
      style TEXT NOT NULL,
      aspect_ratio TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 10;
    CREATE INDEX IF NOT EXISTS video_generations_user_created_idx ON video_generations(user_id, created_at);
  `);
  await db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS complimentary_pro BOOLEAN NOT NULL DEFAULT FALSE");
}

async function usageForUser(user) {
  requireDb();
  const { period, limit } = planLimit(effectivePlanForUser(user));
  const query = period === "day"
    ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
    : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
  const count = Number((await db.query(query, [user.id])).rows[0]?.count || 0);
  return { used: count, limit, remaining: Math.max(0, limit - count), period, plan: user.plan };
}
async function reserveGeneration(user, idea, style, aspectRatio, requestedDuration) {
  requireDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const fresh = (await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [user.id])).rows[0];
    const freshPlan = effectivePlanForUser(fresh);
    const { period, limit } = planLimit(freshPlan);
    const selectedDuration = freshPlan === "free" ? 10 : normalizePaidDuration(requestedDuration);
    if (freshPlan !== "free" && !selectedDuration) {
      await client.query("ROLLBACK");
      return { ok: false, invalidDuration: true };
    }
    const query = period === "day"
      ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
      : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
    const count = Number((await client.query(query, [user.id])).rows[0]?.count || 0);
    if (count >= limit) {
      await client.query("ROLLBACK");
      return { ok: false, usage: { used: count, limit, remaining: 0, period, plan: freshPlan } };
    }
    const jobId = crypto.randomUUID();
    await client.query("INSERT INTO video_generations(job_id,user_id,idea,style,aspect_ratio,duration_seconds,status) VALUES($1,$2,$3,$4,$5,$6,'queued')", [jobId, user.id, idea, style, aspectRatio, selectedDuration]);
    await client.query("COMMIT");
    return { ok: true, jobId, totalDuration: selectedDuration, usage: { used: count + 1, limit, remaining: Math.max(0, limit - count - 1), period, plan: freshPlan } };
  } catch (err) {
    await client.query("ROLLBACK"); throw err;
  } finally { client.release(); }
}

function cleanIdea(value) { return String(value || "").replace(/[<>]/g, "").trim().slice(0, 900); }
function normalizePaidDuration(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 5 && n <= 30 ? n : null;
}
function clipDurationsForTotal(totalDuration) {
  const minSec = 81 / 16;
  const maxSec = 121 / 16;
  const count = Math.max(1, Math.ceil(Number(totalDuration) / maxSec));
  const parts = [];
  let remaining = Number(totalDuration);
  for (let i = 0; i < count; i++) {
    const left = count - i - 1;
    let value;
    if (i === count - 1) value = remaining;
    else value = Math.min(maxSec, Math.max(minSec, remaining / (left + 1)));
    value = Math.min(maxSec, Math.max(minSec, value));
    parts.push(Number(value.toFixed(3)));
    remaining = Number((remaining - value).toFixed(3));
  }
  return parts;
}
function frameCountForSeconds(seconds) {
  return Math.max(81, Math.min(121, Math.round(Number(seconds) * 16)));
}
function narrationForDuration(idea, totalDuration) {
  if (totalDuration <= 7) return `You won't believe this about ${idea}.`;
  if (totalDuration <= 12) return `Stop scrolling. Here's the surprising part about ${idea}. Watch what happens next.`;
  if (totalDuration <= 18) return `Stop scrolling. Here's the surprising part about ${idea}. At first it seems impossible, but one detail changes everything.`;
  if (totalDuration <= 24) return `Stop scrolling. Here's the surprising part about ${idea}. At first it seems impossible, but one detail changes everything. Then comes the part nobody expects.`;
  return `Stop scrolling. You need to hear this about ${idea}. At first it sounds impossible, but one detail changes everything. Then comes the part nobody expects. Would you have noticed it?`;
}
function outputUrl(output) {
  if (Array.isArray(output)) return outputUrl(output[0]);
  if (typeof output === "string") return output;
  if (output && typeof output.url === "function") return output.url();
  if (output && typeof output.url === "string") return output.url;
  throw new Error("The video provider returned an unexpected output.");
}
async function generateNarration(text) {
  if (!replicate) throw new Error("Replicate is not configured.");
  const out = await replicate.run(TTS_MODEL, { input: {
    text,
    language: "en",
    voice_id: process.env.TTS_VOICE_ID || "Ashley",
    sample_rate: 48000,
    audio_format: "mp3",
    speaking_rate: 0
  }});
  return outputUrl(out);
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(stderr.slice(-2000) || `ffmpeg exited with ${code}`)));
  });
}
async function downloadTo(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download generated video (${response.status}).`);
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
}
function buildStoryPlan(idea, style, sceneCount) {
  const pace = {
    "Fast & viral": "fast pacing, punchy visual changes, energetic camera motion",
    "Storytelling": "cinematic storytelling, clear visual progression, dramatic pacing",
    "Funny": "playful timing, comedic visual beats, expressive reactions",
    "Mysterious": "dark suspense, eerie lighting, slow reveals, rising tension",
    "Educational": "clean visual explanation, crisp compositions, surprising details"
  }[style] || "cinematic short-form storytelling";
  return {
    pace,
    continuity: `Continuity bible: keep the SAME main subject, same appearance, same clothing, same props, same location, same time of day, same color language, and same cinematic style across every scene. Do not redesign the character or environment between scenes. Treat the previous clip's final frame as the exact starting state for the next clip.`,
    beats: sceneCount === 1 ? [
      `FULL STORY: establish the main subject and situation immediately, build the action, and deliver a complete payoff in one continuous shot tied directly to: ${idea}.`
    ] : sceneCount === 2 ? [
      `HOOK: establish the main subject and situation immediately. Start with a visually clear action tied directly to: ${idea}. End in a specific state that can continue naturally into Scene 2.`,
      `PAYOFF: begin from the exact state of Scene 1, escalate the action, and resolve the story with the strongest visual payoff related to ${idea}.`
    ] : [
      `HOOK: establish the main subject and situation immediately. Start with a visually clear action tied directly to: ${idea}. End the scene with the subject in a specific state that can continue naturally into the next shot.`,
      `ESCALATION: begin from the exact state of Scene 1 and continue the same action. Advance the story with one concrete new development, keeping the same subject, wardrobe, props, location, and time continuity. End in a new state that can continue naturally into Scene 3.`,
      `PAYOFF: begin from the exact state of Scene 2. Resolve the story with the strongest visual payoff related to ${idea}. Finish with a memorable final image and a natural stopping point.`
    ]
  };
}
function buildScenePrompt(plan, idea, style, aspectRatio, sceneNumber) {
  const sceneCount = plan.beats.length;
  return `Short-form ${aspectRatio} video. ${plan.pace}. High visual quality, realistic motion, coherent subject continuity, no logos or watermarks. NO SPOKEN DIALOGUE and NO MUSIC; visuals only. ${plan.continuity} Scene ${sceneNumber} of ${sceneCount}. ${plan.beats[sceneNumber-1]} The topic is: ${idea}. This is ${style} style. Avoid unrelated objects, unrelated locations, or visual resets. Avoid introducing new main characters unless absolutely required by the story. The final second should hold a stable frame so the next scene can continue from it.`;
}

// Stripe webhooks must be parsed as raw bytes before express.json().
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.json({ received: true, demo: true });
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: "Webhook signing secret is not configured." });
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    if (db) {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;
        if (userId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const priceId = sub.items.data[0]?.price?.id;
          const resolvedPlan = planFromPrice(priceId);
          if (resolvedPlan !== "free" || priceId === priceIds.creator || priceId === priceIds.pro) {
            await db.query("UPDATE users SET stripe_customer_id=$2,stripe_subscription_id=$3,stripe_price_id=$4,plan=CASE WHEN complimentary_pro THEN 'pro' ELSE $5 END,updated_at=NOW() WHERE id=$1", [userId, session.customer, sub.id, priceId || null, resolvedPlan]);
          }
        }
      } else if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        const found = await db.query("SELECT id FROM users WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2 LIMIT 1", [sub.customer, sub.id]);
        if (found.rows[0]) {
          const priceId = sub.items.data[0]?.price?.id;
          const active = ["active", "trialing", "past_due"].includes(sub.status);
          const resolvedPlan = planFromPrice(priceId);
          const finalPlan = active && resolvedPlan !== "free" ? resolvedPlan : "free";
          await db.query("UPDATE users SET stripe_subscription_id=$2,stripe_price_id=$3,plan=CASE WHEN complimentary_pro THEN 'pro' ELSE $4 END,updated_at=NOW() WHERE id=$1", [found.rows[0].id, sub.id, priceId || null, finalPlan]);
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        await db.query("UPDATE users SET plan=CASE WHEN complimentary_pro THEN 'pro' ELSE 'free' END,stripe_subscription_id=NULL,stripe_price_id=NULL,updated_at=NOW() WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2", [sub.customer, sub.id]);
      } else if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const found = await db.query("SELECT id FROM users WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2 LIMIT 1", [invoice.customer, sub.id]);
          if (found.rows[0]) {
            const priceId = sub.items.data[0]?.price?.id;
            const resolvedPlan = planFromPrice(priceId);
            if (resolvedPlan !== "free") {
              await db.query("UPDATE users SET stripe_subscription_id=$2,stripe_price_id=$3,plan=CASE WHEN complimentary_pro THEN 'pro' ELSE $4 END,updated_at=NOW() WHERE id=$1", [found.rows[0].id, sub.id, priceId || null, resolvedPlan]);
            }
          }
        }
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Webhook error:", error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname, { dotfiles: "deny", index: false }));

app.post("/api/auth/signup", sameOrigin, rateLimit("signup", { windowMs: 15 * 60 * 1000, max: 5 }), async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || ""), developerCode = String(req.body?.developerCode || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    if (password.length > 128) return res.status(400).json({ error: "Password is too long." });
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const complimentaryPro = !!OWNER_EMAIL && email === OWNER_EMAIL && !!OWNER_ACCESS_CODE && developerCode === OWNER_ACCESS_CODE;
    try { await db.query("INSERT INTO users(id,email,password_hash,complimentary_pro) VALUES($1,$2,$3,$4)", [id, email, passwordHash, complimentaryPro]); }
    catch (err) { if (err.code === "23505") return res.status(409).json({ error: "An account with that email already exists." }); throw err; }
    await createUserSession(res, id);
    res.status(201).json({ user: { id, email, plan: "free" } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not create account." }); }
});
app.post("/api/auth/login", sameOrigin, rateLimit("login", { windowMs: 15 * 60 * 1000, max: 10 }), async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || ""), developerCode = String(req.body?.developerCode || "");
    const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
    await createUserSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not sign in." }); }
});
app.post("/api/account/redeem-owner-code", sameOrigin, requireUser, rateLimit("owner-code", { windowMs: 60 * 60 * 1000, max: 5, keyFn: req => req.user.id }), async (req, res) => {
  try {
    requireDb();
    if (!OWNER_EMAIL || !OWNER_ACCESS_CODE) return res.status(503).json({ error: "Owner code is not configured." });
    if (normalizeEmail(req.user.email) !== OWNER_EMAIL) return res.status(403).json({ error: "This developer code is not valid for this account." });
    const code = String(req.body?.code || "");
    if (!code || code !== OWNER_ACCESS_CODE) return res.status(403).json({ error: "Invalid developer code." });
    await db.query("UPDATE users SET complimentary_pro=TRUE,plan='pro',updated_at=NOW() WHERE id=$1", [req.user.id]);
    const fresh = (await db.query("SELECT * FROM users WHERE id=$1", [req.user.id])).rows[0];
    res.json({ ok: true, user: publicUser(fresh), usage: await usageForUser(effectiveUser(fresh)) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not redeem developer access." }); }
});

app.post("/api/auth/logout", sameOrigin, rateLimit("logout", { windowMs: 5 * 60 * 1000, max: 20 }), async (req, res) => {
  if (db) {
    const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("ss_session="));
    if (raw) await db.query("DELETE FROM sessions WHERE token_hash=$1", [hashValue(decodeURIComponent(raw.slice("ss_session=".length)))]);
  }
  res.setHeader("Set-Cookie", `ss_session=; ${cookieOptions(0)}`);
  res.json({ ok: true });
});
app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    res.json({ user: publicUser(user), usage: await usageForUser(user) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Account service is unavailable." }); }
});
app.get("/api/account/usage", requireUser, async (req, res) => { res.json({ user: publicUser(req.user), usage: await usageForUser(req.user) }); });

app.get("/api/health", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ ok: false, database: false, error: "DATABASE_URL is missing." });
    await db.query("SELECT 1");
    res.json({ ok: true, database: true });
  } catch (err) {
    res.status(503).json({ ok: false, database: false });
  }
});

app.post("/api/create-checkout-session", sameOrigin, requireUser, rateLimit("checkout", { windowMs: 10 * 60 * 1000, max: 8, keyFn: req => req.user.id }), async (req, res) => {
  const plan = req.body?.plan;
  const price = priceIds[plan];
  if (!stripe || !price) return res.status(503).json({ error: "Stripe is not configured. Check Render environment variables." });
  if (!['creator','pro'].includes(plan)) return res.status(400).json({ error: "Invalid plan." });
  try {
    const base = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      metadata: { userId: req.user.id, plan },
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/account?checkout=cancelled`,
      allow_promotion_codes: true
    }, { idempotencyKey: `checkout_${req.user.id}_${crypto.randomUUID()}` });
    res.json({ url: session.url });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || "Could not create Stripe Checkout session." }); }
});

app.post("/api/admin/login", sameOrigin, rateLimit("admin-login", { windowMs: 15 * 60 * 1000, max: 5 }), (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Incorrect password." });
  const token = crypto.randomBytes(24).toString("hex");
  res.setHeader("Set-Cookie", `ss_admin=${encodeURIComponent(`${token}.${sign(token)}`)}; ${cookieOptions(8 * 60 * 60)}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", sameOrigin, requireAdmin, rateLimit("admin-logout", { windowMs: 5 * 60 * 1000, max: 10 }), (req, res) => { res.setHeader("Set-Cookie", `ss_admin=; ${cookieOptions(0)}`); res.json({ ok: true }); });
app.post("/api/admin/grant-pro", sameOrigin, requireAdmin, rateLimit("grant-pro", { windowMs: 10 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Enter an email address." });
    const result = await db.query("UPDATE users SET complimentary_pro=TRUE,plan='pro',updated_at=NOW() WHERE email=$1 RETURNING id,email,plan,complimentary_pro", [email]);
    if (!result.rows[0]) return res.status(404).json({ error: "No account found for that email." });
    res.json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not grant Pro." }); }
});
app.post("/api/admin/revoke-pro", sameOrigin, requireAdmin, rateLimit("revoke-pro", { windowMs: 10 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "Enter an email address." });
    const result = await db.query("UPDATE users SET complimentary_pro=FALSE,plan=CASE WHEN stripe_price_id=$2 THEN 'creator' WHEN stripe_price_id=$3 THEN 'pro' ELSE 'free' END,updated_at=NOW() WHERE email=$1 RETURNING id,email,plan,complimentary_pro", [email, priceIds.creator, priceIds.pro]);
    if (!result.rows[0]) return res.status(404).json({ error: "No account found for that email." });
    res.json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not revoke Pro." }); }
});

app.get("/api/admin/overview", requireAdmin, async (req, res) => {
  if (!stripe) return res.json({ demo: true, available: 0, pending: 0, revenue: 0, paymentCount: 0, activeSubscriptions: 0, payments: [], payouts: [] });
  try {
    const balance = await stripe.balance.retrieve();
    const available = balance.available.find(x => x.currency === "usd")?.amount || 0;
    const pending = balance.pending.find(x => x.currency === "usd")?.amount || 0;
    const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
    const charges = await stripe.charges.list({ limit: 100, created: { gte: since } });
    const payments = charges.data.map(c => ({ customer: c.billing_details?.email || c.receipt_email || c.customer || "Customer", amount: c.amount, status: c.paid ? "paid" : "failed" }));
    const revenue = charges.data.filter(c => c.paid).reduce((s, c) => s + c.amount, 0);
    const subscriptions = await stripe.subscriptions.list({ status: "active", limit: 100 });
    const payouts = await stripe.payouts.list({ limit: 10 });
    res.json({ demo: false, available, pending, revenue, paymentCount: payments.length, activeSubscriptions: subscriptions.data.length, payments, payouts: payouts.data.map(p => ({ amount: p.amount, status: p.status, created: p.created })) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Stripe dashboard data could not be loaded." }); }
});

async function extractLastFrame(videoPath, imagePath) {
  await ffmpegRun(["-y", "-sseof", "-0.08", "-i", videoPath, "-frames:v", "1", "-q:v", "2", imagePath]);
}

async function generateJob(jobId, idea, style, aspectRatio, plan, totalDuration) {
  const job = jobs.get(jobId); if (!job) return;
  const isFree = plan === "free";
  const safeDuration = isFree ? 10 : Math.max(5, Math.min(30, Number(totalDuration) || 30));
  const sceneDurations = isFree ? [10] : clipDurationsForTotal(safeDuration);
  const sceneCount = sceneDurations.length;
  const providerResolution = "480p";
  const outputWidth = aspectRatio === "9:16" ? (isFree ? 360 : 480) : (isFree ? 640 : 854);
  const outputHeight = aspectRatio === "9:16" ? (isFree ? 640 : 854) : (isFree ? 360 : 480);
  try {
    if (!replicate) throw new Error("AI video is not configured. Add REPLICATE_API_TOKEN to Render Environment Variables.");
    if (db) await db.query("UPDATE video_generations SET status='generating' WHERE job_id=$1", [jobId]);
    job.status = "generating"; job.progress = 5;
    job.message = isFree ? "Creating your 10-second free preview…" : `Creating your ${safeDuration}-second Short in ${sceneCount} connected scene${sceneCount === 1 ? "" : "s"}…`;

    const storyPlan = buildStoryPlan(idea, style, sceneCount);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shortspark-"));
    const clipPaths = [];
    let continuationImage = null;

    // Generate sequentially. Each paid scene starts from the previous scene's last frame.
    for (let i = 0; i < sceneCount; i++) {
      const sceneNumber = i + 1;
      const clipDuration = sceneDurations[i];
      job.progress = 8 + Math.floor(i * (46 / Math.max(1, sceneCount - 1 || 1)));
      job.message = `Generating scene ${sceneNumber} of ${sceneCount} (${clipDuration}s) at ${providerResolution}…`;
      const input = {
        prompt: buildScenePrompt(storyPlan, idea, style, aspectRatio, sceneNumber),
        negative_prompt: "blurry, low detail, deformed hands, extra fingers, extra limbs, duplicate people, warped face, text, subtitles, logos, watermark, flicker, jitter, scene reset, unrelated objects, broken anatomy",
        num_frames: frameCountForSeconds(clipDuration),
        resolution: providerResolution,
        aspect_ratio: aspectRatio,
        frames_per_second: 16,
        go_fast: true,
        sample_shift: Number(process.env.WAN_SAMPLE_SHIFT || 12),
        optimize_prompt: false,
        disable_safety_checker: false
      };
      if (continuationImage) input.image = continuationImage;
      const output = await replicate.run(VIDEO_MODEL, { input });
      const videoUrl = outputUrl(output);
      const clipPath = path.join(dir, `clip-${sceneNumber}.mp4`);
      await downloadTo(videoUrl, clipPath);
      clipPaths.push(clipPath);
      if (!isFree && sceneNumber < sceneCount) {
        const framePath = path.join(dir, `continuation-${sceneNumber}.png`);
        await extractLastFrame(clipPath, framePath);
        continuationImage = await fs.readFile(framePath);
      }
    }

    job.progress = 62; job.message = "Generating low-cost voice narration…";
    const narrationUrl = await generateNarration(narrationForDuration(idea, safeDuration));
    const audioPath = path.join(dir, "narration.mp3");
    await downloadTo(narrationUrl, audioPath);
    const listPath = path.join(dir, "concat.txt");
    await fs.writeFile(listPath, clipPaths.map(p => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
    const finalPath = path.join(dir, "shortspark-short.mp4");
    job.progress = 86; job.message = `Joining ${sceneCount} connected scene${sceneCount === 1 ? "" : "s"} into ${safeDuration} seconds…`;
    const scaleFilter = aspectRatio === "9:16"
      ? `[0:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v]`
      : `[0:v]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v]`;
    await ffmpegRun([
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", audioPath, "-filter_complex", scaleFilter,
      "-map", "[v]", "-map", "1:a", "-t", String(safeDuration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", isFree ? "29" : "26",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", finalPath
    ]);

    const captionsPath = path.join(dir, "captions.srt");
    const captionText = narrationForDuration(idea, safeDuration);
    const words = captionText.split(/\s+/).filter(Boolean);
    const chunkCount = sceneCount;
    const captions = [];
    let cursor = 0;
    for (let i = 0; i < chunkCount; i++) {
      const start = cursor;
      const end = i === chunkCount - 1 ? safeDuration : cursor + sceneDurations[i];
      cursor = end;
      const from = Math.floor((i * words.length) / chunkCount);
      const to = Math.floor(((i + 1) * words.length) / chunkCount);
      const text = words.slice(from, Math.max(from + 1, to)).join(" ");
      const fmt = sec => `${String(Math.floor(sec / 3600)).padStart(2,"0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2,"0")}:${String(Math.floor(sec % 60)).padStart(2,"0")},000`;
      captions.push(`${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${text}\n`);
    }
    await fs.writeFile(captionsPath, captions.join("\n"), "utf8");
    Object.assign(job, {
      dir, finalPath, captionsPath, progress: 100,
      message: isFree ? "Your 10-second free Short is ready." : `Your ${safeDuration}-second Short is ready.`,
      durationSeconds: safeDuration, outputWidth, outputHeight, plan
    });
    if (db) await db.query("UPDATE video_generations SET status='completed', completed_at=NOW() WHERE job_id=$1", [jobId]);
  } catch (error) {
    console.error(`Video job ${jobId} failed`, error);
    Object.assign(job, { status: "failed", progress: 0, error: error.message || "Video generation failed." });
    if (db) await db.query("UPDATE video_generations SET status='failed', error=$2 WHERE job_id=$1", [jobId, job.error]);
  }
}
app.post("/api/generate-video", sameOrigin, requireUser, rateLimit("video", { windowMs: 10 * 60 * 1000, max: 6, keyFn: req => req.user.id }), async (req, res) => {
  const idea = cleanIdea(req.body?.idea);
  const style = STYLE_OPTIONS.has(req.body?.style) ? req.body.style : "Fast & viral";
  const aspectRatio = req.body?.aspectRatio === "16:9" ? "16:9" : "9:16";
  const requestedDuration = req.body?.durationSeconds;
  if (!idea) return res.status(400).json({ error: "Enter an idea first." });
  if (!replicate) return res.status(503).json({ error: "AI video is not configured yet. Add REPLICATE_API_TOKEN to Render." });
  if (!db) return res.status(503).json({ error: "Accounts are not configured yet. Add DATABASE_URL to Render." });
  if (jobs.size > 10) return res.status(429).json({ error: "The generator is busy. Try again in a minute." });
  try {
    const reservation = await reserveGeneration(req.user, idea, style, aspectRatio, requestedDuration);
    if (reservation.invalidDuration) return res.status(400).json({ error: "Paid video duration must be between 5 and 30 seconds." });
    if (!reservation.ok) return res.status(429).json({ error: `You've used all ${reservation.usage.limit} video generation(s) for this ${reservation.usage.period}.`, usage: reservation.usage });
    jobs.set(reservation.jobId, { status: "queued", progress: 2, message: "Queued…", createdAt: Date.now(), userId: req.user.id, plan: reservation.usage.plan, totalDuration: reservation.totalDuration });
    generateJob(reservation.jobId, idea, style, aspectRatio, reservation.usage.plan, reservation.totalDuration);
    res.status(202).json({ jobId: reservation.jobId, usage: reservation.usage, durationSeconds: reservation.totalDuration });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not start video generation." }); }
});
app.get("/api/video-status/:id", requireUser, (req, res) => {
  const job = jobs.get(req.params.id); if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "Video job not found." });
  if (job.status === "completed") return res.json({ status: "completed", progress: 100, message: job.message, videoUrl: `/api/generated-video/${req.params.id}`, captionsUrl: `/api/generated-captions/${req.params.id}` });
  if (job.status === "failed") return res.status(500).json({ status: "failed", error: job.error || "Video generation failed." });
  res.json({ status: job.status, progress: job.progress, message: job.message });
});
app.get("/api/generated-video/:id", requireUser, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.finalPath || job.userId !== req.user.id) return res.status(404).send("Video not found.");
  res.type("mp4");
  res.setHeader("Content-Disposition", "inline; filename=shortspark-short.mp4");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.sendFile(job.finalPath);
});
app.get("/api/generated-captions/:id", requireUser, (req, res) => { const job = jobs.get(req.params.id); if (!job?.captionsPath || job.userId !== req.user.id) return res.status(404).send("Captions not found."); res.type("text/plain").sendFile(job.captionsPath); });

setInterval(async () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  for (const [id, job] of jobs) if (job.createdAt < cutoff) { if (job.dir) { try { await fs.rm(job.dir, { recursive: true, force: true }); } catch {} } jobs.delete(id); }
  if (db) { try { await db.query("DELETE FROM sessions WHERE expires_at<NOW()") } catch {} }
}, 10 * 60 * 1000).unref();

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "account.html")));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

initDb().then(() => app.listen(PORT, "0.0.0.0", () => console.log(`ShortSpark running on port ${PORT}`))).catch(err => { console.error("Database initialization failed", err); process.exit(1); });
