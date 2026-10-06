import express from "express";
import Stripe from "stripe";
import OpenAI from "openai";
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
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const SUPPORT_MODEL = process.env.SUPPORT_MODEL || "gpt-6-luna";
const SUPPORT_MAX_MESSAGES = 8;
const SUPPORT_SYSTEM_PROMPT = `You are ShortSpark's friendly AI customer-support agent.
You help customers use the ShortSpark website, understand plans, create better prompts, generate AI videos, and troubleshoot common issues.
Current plans:
- Free: 1 video per day, 10-second videos, 360p delivery.
- Creator: $8.99/month, 10 videos/month, 5-30 second videos, 480p delivery, premium styles, prompt helper, MP4/caption downloads, connected-scene storytelling.
- Pro: $15.99/month, 24 videos/month, 5-30 second videos, 480p delivery, priority generation, brand presets, all Creator benefits.
Video engine: Wan 2.2 5B Fast at 480p for the current build.
Do not invent refunds, credits, subscriptions, or features that are not listed.
Never ask for or repeat passwords, Stripe secret keys, webhook secrets, database URLs, or Replicate/OpenAI API keys.
Never claim you can see or modify a customer's private billing data unless the server explicitly provides it.
Keep answers concise, friendly, and practical. For technical problems, give one or two clear next steps.
If a user asks for a cancellation/refund, explain that they should use their Stripe customer portal when available or contact the business owner; do not pretend to issue the refund yourself.`;

const replicate = process.env.REPLICATE_API_TOKEN ? new Replicate({ auth: process.env.REPLICATE_API_TOKEN }) : null;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'shortspark-videos';
const cloudStorage = !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const priceIds = { creator: process.env.STRIPE_PRICE_CREATOR, pro: process.env.STRIPE_PRICE_PRO };
const DEFAULT_FIRST_USER_SUPPORT_CODE = "SHORTSPARK50";
const FIRST_USER_SUPPORT_CODE = String(process.env.FIRST_USER_SUPPORT_CODE || DEFAULT_FIRST_USER_SUPPORT_CODE)
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9-]/g, "")
  .slice(0, 40);

const stripePriceCache = new Map();


const PLAN_CONFIG = {
  creator: {
    productName: "ShortSpark Creator",
    amount: 899,
    lookupKey: "shortspark_creator_monthly_v1"
  },
  pro: {
    productName: "ShortSpark Pro",
    amount: 1599,
    lookupKey: "shortspark_pro_monthly_v1"
  }
};

async function ensureFirstUserSupportCode(codeInput = FIRST_USER_SUPPORT_CODE) {
  if (!stripe) throw new Error("Stripe is not connected.");
  const code = String(codeInput || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40);
  if (!code || code.length < 4) throw new Error("Support code must be at least 4 letters/numbers.");

  const existing = await stripe.promotionCodes.list({ code, active: true, limit: 10 });
  const matching = existing.data.find(p => String(p.code || "").toUpperCase() === code);
  if (matching) return matching;

  const coupon = await stripe.coupons.create({
    name: `ShortSpark first-user 50% support — ${code}`,
    percent_off: 50,
    duration: "once",
    metadata: {
      shortspark_support: "first_user_50",
      shortspark_code: code
    }
  });

  return stripe.promotionCodes.create({
    promotion: { type: "coupon", coupon: coupon.id },
    code,
    max_redemptions: 1,
    restrictions: { first_time_transaction: true },
    metadata: {
      shortspark_support: "first_user_50",
      shortspark_code: code
    }
  });
}

async function resolveStripePriceId(plan) {
  if (!stripe) return null;
  const cfg = PLAN_CONFIG[plan];
  if (!cfg) return null;

  const cached = stripePriceCache.get(plan);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  // 1) Prefer a lookup key created/managed by ShortSpark.
  try {
    const byLookup = await stripe.prices.list({
      active: true,
      type: "recurring",
      lookup_keys: [cfg.lookupKey],
      limit: 1
    });
    const exactLookup = byLookup.data.find(p =>
      p.currency === "usd" &&
      p.unit_amount === cfg.amount &&
      p.recurring?.interval === "month"
    );
    if (exactLookup) {
      stripePriceCache.set(plan, { id: exactLookup.id, expiresAt: Date.now() + 10 * 60 * 1000 });
      return exactLookup.id;
    }
  } catch (err) {
    console.warn(`Lookup-key price search failed for ${plan}:`, err.message);
  }

  // 2) Find the exact product by name in the current Stripe account/mode.
  let product = null;
  try {
    const products = await stripe.products.list({ active: true, limit: 100 });
    product = products.data.find(p =>
      String(p.name || "").trim().toLowerCase() === cfg.productName.toLowerCase()
    );
  } catch (err) {
    throw new Error(`Could not read Stripe products: ${err.message}`);
  }

  // 3) If the product is missing, create it in the current Stripe mode.
  // This fixes a half-configured account without exposing secrets to the client.
  if (!product) {
    try {
      product = await stripe.products.create({
        name: cfg.productName,
        metadata: { shortspark_plan: plan, managed_by: "shortspark" }
      });
      console.log(`Created missing Stripe product: ${product.id} (${cfg.productName}).`);
    } catch (err) {
      throw new Error(`Could not create ${cfg.productName}: ${err.message}`);
    }
  }

  // 4) Find an exact $8.99 / $15.99 monthly USD price for that product.
  let exact = null;
  try {
    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      type: "recurring",
      limit: 100
    });
    exact = prices.data.find(p =>
      p.currency === "usd" &&
      p.unit_amount === cfg.amount &&
      p.recurring?.interval === "month"
    );
  } catch (err) {
    throw new Error(`Could not read prices for ${cfg.productName}: ${err.message}`);
  }

  // 5) If the exact price does not exist, create it.
  if (!exact) {
    try {
      exact = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: cfg.amount,
        recurring: { interval: "month" },
        lookup_key: cfg.lookupKey,
        metadata: { shortspark_plan: plan, managed_by: "shortspark" }
      });
      console.log(`Created exact Stripe price ${exact.id} for ${cfg.productName} at $${(cfg.amount / 100).toFixed(2)}/month.`);
    } catch (err) {
      throw new Error(
        `Could not create the exact ${cfg.productName} price of $${(cfg.amount / 100).toFixed(2)}/month: ${err.message}`
      );
    }
  } else {
    // Best effort: add the lookup key to an existing exact price.
    if (!exact.lookup_key) {
      try {
        exact = await stripe.prices.update(exact.id, { lookup_key: cfg.lookupKey });
      } catch (err) {
        console.warn(`Could not add lookup key to ${exact.id}:`, err.message);
      }
    }
  }

  stripePriceCache.set(plan, { id: exact.id, expiresAt: Date.now() + 10 * 60 * 1000 });
  console.log(`Resolved ${plan} checkout price to ${exact.id} at $${(cfg.amount / 100).toFixed(2)}/month.`);
  return exact.id;
}

const VIDEO_MODEL = "wan-video/wan-2.2-5b-fast";
const TTS_MODEL = process.env.TTS_MODEL || "inworld/realtime-tts-1.5-mini";
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || "Alex";
const VOICE_EMOTIONS = new Set(["excited","suspenseful","warm","dramatic","calm"]);
const FREE_VIDEOS_PER_DAY = Math.max(1, Number(process.env.FREE_VIDEOS_PER_DAY || 1));
const CREATOR_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.CREATOR_VIDEOS_PER_MONTH || 10));
const PRO_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.PRO_VIDEOS_PER_MONTH || 24));
const OWNER_EMAIL = normalizeEmail(process.env.OWNER_EMAIL || "");
const OWNER_ACCESS_CODE = String(process.env.OWNER_ACCESS_CODE || "");
const OWNER_BYPASS_LIMITS = String(process.env.OWNER_BYPASS_LIMITS || "true").toLowerCase() === "true";

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
function planFromSubscription(sub) {
  const metadataPlan = sub?.metadata?.plan;
  if (metadataPlan === "creator" || metadataPlan === "pro") return metadataPlan;
  return planFromPrice(sub?.items?.data?.[0]?.price?.id);
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
      video_data BYTEA,
      storage_path TEXT,
      captions_text TEXT,
      narration_script TEXT,
      subject_action TEXT,
      voice_emotion TEXT NOT NULL DEFAULT 'excited',
      voice_direction TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS duration_seconds INTEGER NOT NULL DEFAULT 10;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS video_data BYTEA;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS storage_path TEXT;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS captions_text TEXT;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS narration_script TEXT;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS subject_action TEXT;
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS voice_emotion TEXT NOT NULL DEFAULT 'excited';
    ALTER TABLE video_generations ADD COLUMN IF NOT EXISTS voice_direction TEXT NOT NULL DEFAULT '';
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
async function reserveGeneration(user, idea, style, aspectRatio, requestedDuration, narrationScript, subjectAction, voiceEmotion, voiceDirection) {
  requireDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const fresh = (await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [user.id])).rows[0];
    const freshPlan = effectivePlanForUser(fresh);
    const ownerBypass = OWNER_BYPASS_LIMITS && isOwnerAccount(fresh);
    const effectiveForGeneration = ownerBypass ? "pro" : freshPlan;
    const { period, limit } = planLimit(effectiveForGeneration);
    const selectedDuration = effectiveForGeneration === "free" ? 10 : normalizePaidDuration(requestedDuration);
    if (freshPlan !== "free" && !selectedDuration) {
      await client.query("ROLLBACK");
      return { ok: false, invalidDuration: true };
    }
    const query = period === "day"
      ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
      : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
    const count = Number((await client.query(query, [user.id])).rows[0]?.count || 0);
    if (!ownerBypass && count >= limit) {
      await client.query("ROLLBACK");
      return { ok: false, usage: { used: count, limit, remaining: 0, period, plan: freshPlan } };
    }
    const jobId = crypto.randomUUID();
    await client.query("INSERT INTO video_generations(job_id,user_id,idea,style,aspect_ratio,duration_seconds,status,narration_script,subject_action,voice_emotion,voice_direction) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10)", [jobId, user.id, idea, style, aspectRatio, selectedDuration, narrationScript, subjectAction, voiceEmotion, voiceDirection]);
    await client.query("COMMIT");
    return { ok: true, jobId, totalDuration: selectedDuration, usage: { used: ownerBypass ? count : count + 1, limit, remaining: ownerBypass ? 9999 : Math.max(0, limit - count - 1), period, plan: effectiveForGeneration }, ownerBypass };
  } catch (err) {
    await client.query("ROLLBACK"); throw err;
  } finally { client.release(); }
}

function cleanIdea(value) { return String(value || "").replace(/[<>]/g, "").trim().slice(0, 900); }
function cleanScript(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}
function cleanAction(value) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 700);
}
function cleanEmotion(value) {
  const emotion = String(value || "").toLowerCase();
  return VOICE_EMOTIONS.has(emotion) ? emotion : "excited";
}
function cleanVoiceDirection(value) {
  return String(value || "").replace(/[<>]/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
function voiceDirectionMarkup(direction) {
  const d = String(direction || "").toLowerCase();
  const marks = [];
  if (/whisper|whispering|very quiet|hushed/.test(d)) marks.push("[whisper]");
  else if (/shout|yell|scream|loud|booming/.test(d)) marks.push("[shout]");
  if (/nervous|anxious|scared|afraid|terrified|fearful|panicked/.test(d)) marks.push("[fearful]");
  else if (/angry|furious|rage|mad|aggressive/.test(d)) marks.push("[angry]");
  else if (/surprised|shocked|astonished|amazed/.test(d)) marks.push("[surprised]");
  else if (/happy|joyful|cheerful|playful|excited|energetic/.test(d)) marks.push("[happy]");
  if (/sad|heartbroken|crying|tearful|melancholy/.test(d)) marks.push("[sad]");
  return marks.slice(0, 2).join("");
}
function fitScriptToDuration(text, totalDuration) {
  const clean = cleanScript(text);
  if (!clean) return narrationForDuration("", totalDuration);
  const maxChars = Math.max(55, Math.floor(Number(totalDuration) * 13));
  if (clean.length <= maxChars) return clean;
  const words = clean.split(/\s+/);
  let output = "";
  for (const word of words) {
    const candidate = output ? `${output} ${word}` : word;
    if (candidate.length > maxChars) break;
    output = candidate;
  }
  return output || clean.slice(0, maxChars);
}
function emotionMarkup(emotion) {
  switch (emotion) {
    case "suspenseful": return "[fearful]";
    case "warm": return "[happy]";
    case "dramatic": return "[surprised]";
    case "calm": return "";
    default: return "[happy]";
  }
}
function applyVoiceEmotion(script, emotion, voiceDirection = "") {
  const clean = fitScriptToDuration(script, 30).replace(/[\r\n]+/g, " ").trim();
  const mark = voiceDirectionMarkup(voiceDirection) || emotionMarkup(emotion);
  if (!clean) return mark ? `${mark}Hi there.` : "Hi there.";
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const joined = sentences.join(" <break time=\"250ms\" /> ");
  return mark ? `${mark}${joined}` : joined;
}
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
async function generateNarration(text, emotion = "excited", voiceDirection = "") {
  if (!replicate) throw new Error("Replicate is not configured.");
  const out = await replicate.run(TTS_MODEL, { input: {
    text: applyVoiceEmotion(text, emotion, voiceDirection),
    language: "en",
    voice_id: TTS_VOICE_ID,
    sample_rate: 48000,
    audio_format: "mp3",
    speaking_rate: emotion === "calm" ? -10 : emotion === "excited" ? 4 : 0
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

async function uploadToCloudStorage(file, storagePath, contentType = "video/mp4") {
  if (!cloudStorage) throw new Error("Cloud storage is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const data = await fs.readFile(file);
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true"
    },
    body: data
  });
  if (!response.ok) throw new Error(`Cloud storage upload failed (${response.status}).`);
  return storagePath;
}

async function createCloudSignedUrl(storagePath, expiresIn = 3600) {
  if (!cloudStorage || !storagePath) return null;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn })
  });
  if (!response.ok) throw new Error(`Cloud storage signed URL failed (${response.status}).`);
  const data = await response.json();
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

async function deleteCloudObject(storagePath) {
  if (!cloudStorage || !storagePath) return;
  await fetch(`${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_STORAGE_BUCKET)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: [storagePath] })
  });
}
function buildStoryPlan(idea, style, sceneCount, subjectAction) {
  const pace = {
    "Fast & viral": "fast pacing, punchy visual changes, energetic camera motion",
    "Storytelling": "cinematic storytelling, clear visual progression, dramatic pacing",
    "Funny": "playful timing, comedic visual beats, expressive reactions",
    "Mysterious": "dark suspense, eerie lighting, slow reveals, rising tension",
    "Educational": "clean visual explanation, crisp compositions, surprising details"
  }[style] || "cinematic short-form storytelling";
  return {
    pace,
    continuity: `Continuity bible: keep the SAME main subject, same appearance, same clothing, same props, same location, same time of day, same color language, and same cinematic style across every scene. Do not redesign the character or environment between scenes. Treat the previous clip's final frame as the exact starting state for the next clip. The subject/object action is a hard requirement and must be visibly performed on screen, not merely implied.`,
    beats: sceneCount === 1 ? [
      `FULL STORY: establish the main subject and situation immediately, then make the subject perform this specific action: ${subjectAction || "follow the most natural action implied by the idea"}. Build the action and deliver a complete payoff in one continuous shot tied directly to: ${idea}.`
    ] : sceneCount === 2 ? [
      `HOOK: establish the main subject and situation immediately. Start with the specific action: ${subjectAction || "a clear action tied to the idea"}. End in a specific state that can continue naturally into Scene 2.`,
      `PAYOFF: begin from the exact state of Scene 1, continue the same action, escalate it, and resolve the story with the strongest visual payoff related to ${idea}.`
    ] : [
      `HOOK: establish the main subject and situation immediately. Start with the specific action: ${subjectAction || "a clear action tied to the idea"}. End the scene with the subject in a specific state that can continue naturally into the next shot.`,
      `ESCALATION: begin from the exact state of Scene 1 and continue the same action: ${subjectAction || "the same clearly defined action"}. Advance the story with one concrete new development, keeping the same subject, wardrobe, props, location, and time continuity. End in a new state that can continue naturally into Scene 3.`,
      `PAYOFF: begin from the exact state of Scene 2. Continue the same action and resolve the story with the strongest visual payoff related to ${idea}. Finish with a memorable final image and a natural stopping point.`
    ]
  };
}
function buildScenePrompt(plan, idea, style, aspectRatio, sceneNumber, subjectAction) {
  const sceneCount = plan.beats.length;
  return `Short-form ${aspectRatio} video. ${plan.pace}. High visual quality, realistic motion, coherent subject continuity, no logos or watermarks. NO SPOKEN DIALOGUE and NO MUSIC; visuals only. ${plan.continuity} Scene ${sceneNumber} of ${sceneCount}. ${plan.beats[sceneNumber-1]} The topic is: ${idea}. The specific subject/object action is: ${subjectAction || "perform the clearest action implied by the topic"}. This is ${style} style. Treat the specified action as the primary visual instruction. Avoid unrelated objects, unrelated locations, or visual resets. Avoid introducing new main characters unless absolutely required by the story. Keep the subject large enough to read on a phone and show the action clearly. The final second should hold a stable frame so the next scene can continue from it.`;
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
          const resolvedPlan = planFromSubscription(sub);
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
          const resolvedPlan = planFromSubscription(sub);
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
            const resolvedPlan = planFromSubscription(sub);
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

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", ...(SUPABASE_URL ? [SUPABASE_URL] : [])],
      mediaSrc: ["'self'", "blob:", ...(SUPABASE_URL ? [SUPABASE_URL] : [])],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", "https://checkout.stripe.com"],
      upgradeInsecureRequests: []
    }
  },
  referrerPolicy: { policy: "no-referrer" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" }
}));
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



app.get("/api/stripe-status", async (req, res) => {
  res.json({
    configured: !!stripe,
    livemode: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.startsWith("sk_live_") : false,
    creatorPriceConfigured: typeof priceIds.creator === "string" && priceIds.creator.startsWith("price_"),
    proPriceConfigured: typeof priceIds.pro === "string" && priceIds.pro.startsWith("price_"),
    creatorConfiguredValue: priceIds.creator ? "[set]" : "[missing]",
    proConfiguredValue: priceIds.pro ? "[set]" : "[missing]",
    supportConfigured: !!openai,
    videoConfigured: !!replicate,
    intendedCreatorMonthlyUsd: 8.99,
    intendedProMonthlyUsd: 15.99
  });
});

app.get("/subscribe/:plan", rateLimit("subscribe-redirect", {
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyFn: req => req.ip
}), async (req, res) => {
  const plan = req.params.plan === "creator" || req.params.plan === "pro" ? req.params.plan : null;
  if (!plan) return res.status(404).send("Plan not found.");

  const user = await currentUser(req);
  if (!user) return res.redirect(`/account?next=${encodeURIComponent(plan)}`);

  if (!stripe) {
    return res.status(503).send("Stripe is not connected. Add STRIPE_SECRET_KEY in Render → Environment.");
  }

  try {
    const price = await resolveStripePriceId(plan);
    const base = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { userId: user.id, plan },
      subscription_data: { metadata: { userId: user.id, plan } },
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/account?checkout=cancelled`,
      allow_promotion_codes: true
    });

    if (!session.url) throw new Error("Stripe returned no Checkout URL.");
    return res.redirect(303, session.url);
  } catch (err) {
    console.error("GET checkout redirect error:", err);
    const message = String(err?.message || "unknown Stripe error").slice(0, 500);
    return res.status(502).send(`Stripe Checkout could not be opened: ${message}`);
  }
});

app.post("/api/create-checkout-session", sameOrigin, requireUser, rateLimit("checkout", { windowMs: 10 * 60 * 1000, max: 8, keyFn: req => req.user.id }), async (req, res) => {
  const plan = req.body?.plan;
  if (!['creator','pro'].includes(plan)) return res.status(400).json({ error: "Invalid plan." });
  if (!stripe) return res.status(503).json({ error: "Stripe is not connected. Add STRIPE_SECRET_KEY in Render → Environment." });
  try {
    const price = await resolveStripePriceId(plan);
    const base = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      metadata: { userId: req.user.id, plan },
      subscription_data: { metadata: { userId: req.user.id, plan } },
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/account?checkout=cancelled`,
      allow_promotion_codes: true
    }, { idempotencyKey: `checkout_${req.user.id}_${plan}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}` });
    res.json({ url: session.url });
  } catch (err) {
    console.error("POST checkout error:", err);
    res.status(502).json({ error: String(err?.message || "Could not create Stripe Checkout session.").slice(0, 500) });
  }
});


app.get("/api/support-status", (req, res) => {
  res.json({
    configured: !!openai,
    model: openai ? SUPPORT_MODEL : null
  });
});

app.post("/api/support/chat",
  sameOrigin,
  rateLimit("support-chat", {
    windowMs: 5 * 60 * 1000,
    max: 12,
    keyFn: req => req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`
  }),
  async (req, res) => {
    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = rawMessages
      .slice(-SUPPORT_MAX_MESSAGES)
      .filter(m => m && (m.role === "user" || m.role === "assistant"))
      .map(m => ({
        role: m.role,
        content: String(m.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200)
      }))
      .filter(m => m.content);

    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return res.status(400).json({ error: "Send a customer-support question first." });
    }

    const last = messages[messages.length - 1].content;
    if (!last || last.length < 2) return res.status(400).json({ error: "Your message is too short." });

    const accountContext = req.user
      ? `The signed-in customer account is authenticated. Their current server-reported plan is ${req.user.plan || "free"}.`
      : "The visitor is not signed in. Do not assume a paid plan.";

    try {
      if (!openai) {
        return res.json({
          source: "faq",
          answer: "AI support isn't connected yet. The site is running the built-in FAQ fallback. The owner needs to add OPENAI_API_KEY in Render → Environment to turn on the live AI support agent. Current plans: Free 1 video/day, Creator $8.99/month for 10 videos/month, Pro $15.99/month for 24 videos/month."
        });
      }

      const response = await openai.responses.create({
        model: SUPPORT_MODEL,
        instructions: `${SUPPORT_SYSTEM_PROMPT}\n${accountContext}`,
        input: messages
      });

      const answer = String(response.output_text || "").trim();
      if (!answer) throw new Error("The support model returned no text.");
      res.json({ source: "ai", answer: answer.slice(0, 2200) });
    } catch (err) {
      console.error("Support AI error:", err);
      res.status(502).json({
        error: "Customer support is temporarily unavailable. Please try again in a moment."
      });
    }
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

app.get("/api/admin/first-user-code", requireAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe is not connected." });
  try {
    const code = String(req.query.code || FIRST_USER_SUPPORT_CODE).trim().toUpperCase()
      .replace(/[^A-Z0-9-]/g, "").slice(0, 40);
    const matches = await stripe.promotionCodes.list({ code, active: true, limit: 10 });
    const promo = matches.data.find(p => String(p.code || "").toUpperCase() === code);
    res.json({
      configured: !!promo,
      code,
      active: !!promo?.active,
      redemptions: promo?.times_redeemed || 0,
      maxRedemptions: promo?.max_redemptions || 1,
      percentOff: 50,
      firstTimeOnly: true,
      duration: "first invoice only"
    });
  } catch (err) {
    console.error("First-user support code lookup error:", err);
    res.status(500).json({ error: "Could not read the first-user support code." });
  }
});

app.post("/api/admin/first-user-code", sameOrigin, requireAdmin, rateLimit("first-user-code", { windowMs: 10 * 60 * 1000, max: 10 }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe is not connected." });
  try {
    const code = String(req.body?.code || FIRST_USER_SUPPORT_CODE).trim().toUpperCase()
      .replace(/[^A-Z0-9-]/g, "").slice(0, 40);
    const promo = await ensureFirstUserSupportCode(code);
    res.json({
      ok: true,
      code: promo.code,
      active: !!promo.active,
      redemptions: promo.times_redeemed || 0,
      maxRedemptions: promo.max_redemptions || 1,
      percentOff: 50,
      firstTimeOnly: true,
      duration: "first invoice only"
    });
  } catch (err) {
    console.error("First-user support code creation error:", err);
    res.status(500).json({ error: String(err?.message || "Could not create the support code.").slice(0, 300) });
  }
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

async function generateJob(jobId, idea, style, aspectRatio, plan, totalDuration, narrationScript, subjectAction, voiceEmotion, voiceDirection) {
  const job = jobs.get(jobId); if (!job) return;
  const isFree = plan === "free";
  const safeDuration = isFree ? 10 : Math.max(5, Math.min(30, Number(totalDuration) || 30));
  const sceneDurations = clipDurationsForTotal(safeDuration);
  const sceneCount = sceneDurations.length;
  const providerResolution = "480p";
  const outputWidth = aspectRatio === "9:16" ? (isFree ? 360 : 480) : (isFree ? 640 : 854);
  const outputHeight = aspectRatio === "9:16" ? (isFree ? 640 : 854) : (isFree ? 360 : 480);
  try {
    if (!replicate) throw new Error("AI video is not configured. Add REPLICATE_API_TOKEN to Render Environment Variables.");
    if (db) await db.query("UPDATE video_generations SET status='generating' WHERE job_id=$1", [jobId]);
    job.status = "generating"; job.progress = 5;
    console.log(`[video ${jobId}] model=${VIDEO_MODEL} resolution=${providerResolution} duration=${safeDuration}s scenes=${sceneCount}`);
    job.message = isFree ? "Creating your 10-second free preview…" : `Creating your ${safeDuration}-second Short in ${sceneCount} connected scene${sceneCount === 1 ? "" : "s"}…`;

    const storyPlan = buildStoryPlan(idea, style, sceneCount, subjectAction);
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
        prompt: buildScenePrompt(storyPlan, idea, style, aspectRatio, sceneNumber, subjectAction),
        negative_prompt: "blurry, low detail, deformed hands, extra fingers, extra limbs, duplicate people, warped face, text, subtitles, logos, watermark, flicker, jitter, scene reset, unrelated objects, broken anatomy",
        num_frames: frameCountForSeconds(clipDuration),
        resolution: providerResolution,
        aspect_ratio: aspectRatio,
        frames_per_second: 16,
        go_fast: true,
        sample_shift: Math.max(1, Math.min(20, Number(process.env.WAN_SAMPLE_SHIFT || 12))),
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
    const narrationText = narrationScript || narrationForDuration(idea, safeDuration);
    const narrationUrl = await generateNarration(fitScriptToDuration(narrationText, safeDuration), voiceEmotion, voiceDirection);
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
    const captionText = fitScriptToDuration(narrationScript || narrationForDuration(idea, safeDuration), safeDuration);
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
    const srtText = captions.join("\n");
    await fs.writeFile(captionsPath, srtText, "utf8");
    let storagePath = null;
    if (cloudStorage) {
      job.progress = 94; job.message = "Saving your Short to secure cloud storage…";
      storagePath = `users/${job.userId}/${jobId}.mp4`;
      await uploadToCloudStorage(finalPath, storagePath, "video/mp4");
    }
    if (db) {
      await db.query("UPDATE video_generations SET storage_path=$2, video_data=NULL, captions_text=$3, status='completed', completed_at=NOW() WHERE job_id=$1", [jobId, storagePath, srtText]);
      job.persistentCopy = !!storagePath;
    }
    Object.assign(job, {
      status: "completed",
      dir, finalPath, captionsPath, progress: 100,
      message: isFree ? "Your 10-second free Short is ready." : `Your ${safeDuration}-second Short is ready.`,
      durationSeconds: safeDuration, outputWidth, outputHeight, plan
    });

  } catch (error) {
    console.error(`Video job ${jobId} failed`, error);
    Object.assign(job, { status: "failed", progress: 0, error: error.message || "Video generation failed." });
    if (db) await db.query("UPDATE video_generations SET status='failed', error=$2 WHERE job_id=$1", [jobId, job.error]);
  }
}
app.get("/api/generator-status", requireUser, async (req, res) => {
  try {
    requireDb();
    const row = (await db.query("SELECT * FROM users WHERE id=$1", [req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: "Account not found." });
    const plan = effectivePlanForUser(row);
    const owner = OWNER_BYPASS_LIMITS && isOwnerAccount(row);
    const { period, limit } = planLimit(owner ? "pro" : plan);
    const query = period === "day"
      ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
      : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
    const used = Number((await db.query(query, [req.user.id])).rows[0]?.count || 0);
    res.json({
      ok: true,
      model: VIDEO_MODEL,
      resolution: "480p",
      freeDurationSeconds: 10,
      paidDurationRange: [5, 30],
      plan,
      ownerBypass: owner,
      usage: { used, limit, remaining: owner ? 9999 : Math.max(0, limit - used), period }
    });
  } catch (err) {
    console.error("Generator status error", err);
    res.status(500).json({ error: "Could not inspect generator status." });
  }
});

app.post("/api/generate-video", sameOrigin, requireUser, rateLimit("video", { windowMs: 10 * 60 * 1000, max: 6, keyFn: req => req.user.id }), async (req, res) => {
  const idea = cleanIdea(req.body?.idea);
  const style = STYLE_OPTIONS.has(req.body?.style) ? req.body.style : "Fast & viral";
  const aspectRatio = req.body?.aspectRatio === "16:9" ? "16:9" : "9:16";
  const requestedDuration = req.body?.durationSeconds;
  const narrationScript = cleanScript(req.body?.narrationScript);
  const subjectAction = cleanAction(req.body?.subjectAction);
  const voiceEmotion = cleanEmotion(req.body?.voiceEmotion);
  const voiceDirection = cleanVoiceDirection(req.body?.voiceDirection);
  if (!idea) return res.status(400).json({ error: "Enter an idea first." });
  if (!replicate) return res.status(503).json({ error: "AI video is not configured yet. Add REPLICATE_API_TOKEN to Render." });
  if (!db) return res.status(503).json({ error: "Accounts are not configured yet. Add DATABASE_URL to Render." });
  if (!cloudStorage) return res.status(503).json({ error: "Cloud video storage is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to Render." });
  if (jobs.size > 10) return res.status(429).json({ error: "The generator is busy. Try again in a minute." });
  try {
    const reservation = await reserveGeneration(req.user, idea, style, aspectRatio, requestedDuration, narrationScript, subjectAction, voiceEmotion, voiceDirection);
    if (reservation.invalidDuration) return res.status(400).json({ error: "Paid video duration must be between 5 and 30 seconds." });
    if (!reservation.ok) return res.status(429).json({ error: `You've used all ${reservation.usage.limit} video generation(s) for this ${reservation.usage.period}.`, usage: reservation.usage });
    jobs.set(reservation.jobId, { status: "queued", progress: 2, message: "Queued…", createdAt: Date.now(), userId: req.user.id, plan: reservation.usage.plan, totalDuration: reservation.totalDuration, ownerBypass: !!reservation.ownerBypass });
    generateJob(reservation.jobId, idea, style, aspectRatio, reservation.usage.plan, reservation.totalDuration, narrationScript, subjectAction, voiceEmotion, voiceDirection);
    res.status(202).json({ jobId: reservation.jobId, usage: reservation.usage, durationSeconds: reservation.totalDuration });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not start video generation." }); }
});
app.get("/api/video-status/:id", requireUser, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && String(job.userId) === String(req.user.id)) {
    if (job.status === "completed") return res.json({ status: "completed", progress: 100, message: job.message, durationSeconds: job.durationSeconds, outputWidth: job.outputWidth, outputHeight: job.outputHeight, videoUrl: `/api/generated-video/${req.params.id}`, captionsUrl: `/api/generated-captions/${req.params.id}` });
    if (job.status === "failed") return res.status(500).json({ status: "failed", error: job.error || "Video generation failed." });
    return res.json({ status: job.status, progress: job.progress, message: job.message });
  }
  try {
    requireDb();
    const row = (await db.query("SELECT job_id, status, duration_seconds, storage_path, video_data IS NOT NULL AS has_video, captions_text IS NOT NULL AS has_captions, completed_at, error FROM video_generations WHERE job_id=$1 AND user_id=$2", [req.params.id, req.user.id])).rows[0];
    if (!row) return res.status(404).json({ error: "Video job not found." });
    if (row.status === "completed" && row.storage_path) return res.json({ status: "completed", progress: 100, message: "Your Short is ready.", durationSeconds: row.duration_seconds, videoUrl: `/api/generated-video/${req.params.id}`, captionsUrl: `/api/generated-captions/${req.params.id}` });
    if (row.status === "failed") return res.status(500).json({ status: "failed", error: row.error || "Video generation failed." });
    return res.json({ status: row.status, progress: row.status === "generating" ? 55 : 5, message: row.status === "generating" ? "Generating…" : "Queued…" });
  } catch (err) {
    console.error("Video status fallback error", err);
    return res.status(500).json({ error: "Video status is temporarily unavailable." });
  }
});
async function sendVideoBuffer(req, res, buffer) {
  const total = buffer.length;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", "inline; filename=shortspark-short.mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") return res.status(200).end();
  const range = req.headers.range;
  if (!range) { res.setHeader("Content-Length", total); return res.end(buffer); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.setHeader("Content-Range", `bytes */${total}`); return res.status(416).end(); }
  let start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2] || 1));
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
    res.setHeader("Content-Range", `bytes */${total}`); return res.status(416).end();
  }
  end = Math.min(end, total - 1);
  const chunk = buffer.subarray(start, end + 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", chunk.length);
  return res.end(chunk);
}

async function streamVideo(req, res) {
  try {
    requireDb();
    const row = (await db.query("SELECT storage_path FROM video_generations WHERE job_id=$1 AND user_id=$2 AND status='completed'", [req.params.id, req.user.id])).rows[0];
    if (!row?.storage_path) return res.status(404).send("Video not found.");
    const url = await createCloudSignedUrl(row.storage_path, 900);
    if (!url) return res.status(503).send("Cloud storage is not configured.");
    return res.redirect(302, url);
  } catch (err) { console.error("Video stream error:", err); return res.status(500).send("Could not open video."); }
}

app.get("/api/my-shorts", requireUser, async (req, res) => {
  try {
    requireDb();
    const rows = (await db.query(`SELECT job_id, idea, style, aspect_ratio, duration_seconds, status, created_at, completed_at, storage_path, captions_text FROM video_generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.id])).rows;
    const shorts = [];
    for (const row of rows) {
      if (row.status !== "completed" || !row.storage_path) continue;
      shorts.push({ id: row.job_id, idea: row.idea, style: row.style, aspectRatio: row.aspect_ratio, durationSeconds: row.duration_seconds, createdAt: row.created_at, videoUrl: `/api/generated-video/${row.job_id}`, captionsUrl: `/api/generated-captions/${row.job_id}` });
    }
    res.json({ shorts });
  } catch (err) { console.error("My Shorts error:", err); res.status(500).json({ error: "Could not load your Shorts." }); }
});

app.get("/api/generated-captions/:id", requireUser, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && String(job.userId) === String(req.user.id) && job.captionsPath) { try { return res.type("text/plain").sendFile(job.captionsPath); } catch {} }
  try {
    requireDb();
    const row=(await db.query("SELECT captions_text FROM video_generations WHERE job_id=$1 AND user_id=$2 AND status='completed'",[req.params.id,req.user.id])).rows[0];
    if (!row?.captions_text) return res.status(404).send("Captions not found.");
    return res.type("text/plain").send(row.captions_text);
  } catch (err) { console.error("Captions fallback error",err); return res.status(500).send("Captions could not be loaded."); }
});

setInterval(async () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  for (const [id, job] of jobs) if (job.createdAt < cutoff) { if (job.dir) { try { await fs.rm(job.dir, { recursive: true, force: true }); } catch {} } jobs.delete(id); }
  if (db) { try { await db.query("DELETE FROM sessions WHERE expires_at<NOW()") } catch {} }
}, 10 * 60 * 1000).unref();

app.get("/my-shorts", (req, res) => res.sendFile(path.join(__dirname, "my-shorts.html")));
app.get("/support", (req, res) => res.sendFile(path.join(__dirname, "support.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/recommendations", (req, res) => res.sendFile(path.join(__dirname, "recommendations.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "account.html")));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

initDb().then(() => app.listen(PORT, "0.0.0.0", () => console.log(`ShortSpark running on port ${PORT}`))).catch(err => { console.error("Database initialization failed", err); process.exit(1); });
