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

const app = express();
const PORT = process.env.PORT || 4242;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const COOKIE_SECRET = process.env.COOKIE_SECRET || ADMIN_PASSWORD;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const replicate = process.env.REPLICATE_API_TOKEN ? new Replicate({ auth: process.env.REPLICATE_API_TOKEN }) : null;
const priceIds = { creator: process.env.STRIPE_PRICE_CREATOR, pro: process.env.STRIPE_PRICE_PRO };
const VIDEO_MODEL = process.env.VIDEO_MODEL || "bytedance/seedance-1.5-pro";
const FREE_VIDEOS_PER_DAY = Math.max(1, Number(process.env.FREE_VIDEOS_PER_DAY || 1));
const CREATOR_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.CREATOR_VIDEOS_PER_MONTH || 15));
const PRO_VIDEOS_PER_MONTH = Math.max(1, Number(process.env.PRO_VIDEOS_PER_MONTH || 30));

const db = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }) : null;
const jobs = new Map();

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
function publicUser(row) { return { id: row.id, email: row.email, plan: row.plan || "free", createdAt: row.created_at }; }
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

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 32768, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key.toString("hex"))));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${await scryptAsync(password, salt)}`;
}
async function verifyPassword(password, encoded) {
  const [, salt, stored] = String(encoded).split("$");
  if (!salt || !stored) return false;
  const derived = await scryptAsync(password, salt);
  return derived.length === stored.length && crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(stored));
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
  return result.rows[0] || null;
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
      status TEXT NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS video_generations_user_created_idx ON video_generations(user_id, created_at);
  `);
}

async function usageForUser(user) {
  requireDb();
  const { period, limit } = planLimit(user.plan);
  const query = period === "day"
    ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
    : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
  const count = Number((await db.query(query, [user.id])).rows[0]?.count || 0);
  return { used: count, limit, remaining: Math.max(0, limit - count), period, plan: user.plan };
}
async function reserveGeneration(user, idea, style, aspectRatio) {
  requireDb();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [user.id]);
    const fresh = (await client.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [user.id])).rows[0];
    const { period, limit } = planLimit(fresh.plan);
    const query = period === "day"
      ? "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('day', NOW()) AND status IN ('queued','generating','completed')"
      : "SELECT COUNT(*)::int AS count FROM video_generations WHERE user_id=$1 AND created_at >= date_trunc('month', NOW()) AND status IN ('queued','generating','completed')";
    const count = Number((await client.query(query, [user.id])).rows[0]?.count || 0);
    if (count >= limit) {
      await client.query("ROLLBACK");
      return { ok: false, usage: { used: count, limit, remaining: 0, period, plan: fresh.plan } };
    }
    const jobId = crypto.randomUUID();
    await client.query("INSERT INTO video_generations(job_id,user_id,idea,style,aspect_ratio,status) VALUES($1,$2,$3,$4,$5,'queued')", [jobId, user.id, idea, style, aspectRatio]);
    await client.query("COMMIT");
    return { ok: true, jobId, usage: { used: count + 1, limit, remaining: Math.max(0, limit - count - 1), period, plan: fresh.plan } };
  } catch (err) {
    await client.query("ROLLBACK"); throw err;
  } finally { client.release(); }
}

function cleanIdea(value) { return String(value || "").replace(/[<>]/g, "").trim().slice(0, 900); }
function outputUrl(output) {
  if (Array.isArray(output)) return outputUrl(output[0]);
  if (typeof output === "string") return output;
  if (output && typeof output.url === "function") return output.url();
  if (output && typeof output.url === "string") return output.url;
  throw new Error("The video provider returned an unexpected output.");
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
function buildScenes(idea, style, aspectRatio) {
  const pace = { "Fast & viral":"fast pacing, punchy visual changes, energetic camera motion", "Storytelling":"cinematic storytelling, clear visual progression, dramatic pacing", "Funny":"playful timing, comedic visual beats, expressive reactions", "Mysterious":"dark suspense, eerie lighting, slow reveals, rising tension", "Educational":"clean visual explanation, crisp compositions, surprising details" }[style] || "cinematic short-form storytelling";
  const common = `Short-form ${aspectRatio} video, ${pace}. High visual quality, realistic motion, coherent subject continuity, no logos or watermarks.`;
  return [
    `${common} Scene 1 — HOOK. Immediately visualize the central idea: ${idea}. Create a strong first-second visual surprise. Spoken narration in natural American English: "Stop scrolling. You need to hear this about ${idea}." Add fitting music and sound effects.`,
    `${common} Scene 2 — ESCALATION. Continue the same story about ${idea}. Reveal a stronger detail, change the setting or camera angle, and build curiosity. Spoken narration in natural American English: "At first, it sounds impossible. But then one detail changes everything." Add synchronized sound design.`,
    `${common} Scene 3 — PAYOFF. Deliver the strongest visual payoff connected to ${idea}. End with a memorable final shot. Spoken narration in natural American English: "And that's the part nobody sees coming. Would you have noticed it?" Add a final musical hit and sound design.`
  ];
}

// Stripe webhooks must be parsed as raw bytes before express.json().
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.json({ received: true, demo: true });
  try {
    const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    if (db) {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = session.client_reference_id || session.metadata?.userId;
        if (userId && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const priceId = sub.items.data[0]?.price?.id;
          await db.query("UPDATE users SET stripe_customer_id=$2,stripe_subscription_id=$3,stripe_price_id=$4,plan=$5,updated_at=NOW() WHERE id=$1", [userId, session.customer, sub.id, priceId || null, planFromPrice(priceId)]);
        }
      } else if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        const found = await db.query("SELECT id FROM users WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2 LIMIT 1", [sub.customer, sub.id]);
        if (found.rows[0]) {
          const priceId = sub.items.data[0]?.price?.id;
          const active = ["active", "trialing", "past_due"].includes(sub.status);
          await db.query("UPDATE users SET stripe_subscription_id=$2,stripe_price_id=$3,plan=$4,updated_at=NOW() WHERE id=$1", [found.rows[0].id, sub.id, priceId || null, active ? planFromPrice(priceId) : "free"]);
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        await db.query("UPDATE users SET plan='free',stripe_subscription_id=NULL,stripe_price_id=NULL,updated_at=NOW() WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2", [sub.customer, sub.id]);
      } else if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const found = await db.query("SELECT id FROM users WHERE stripe_customer_id=$1 OR stripe_subscription_id=$2 LIMIT 1", [invoice.customer, sub.id]);
          if (found.rows[0]) {
            const priceId = sub.items.data[0]?.price?.id;
            await db.query("UPDATE users SET stripe_subscription_id=$2,stripe_price_id=$3,plan=$4,updated_at=NOW() WHERE id=$1", [found.rows[0].id, sub.id, priceId || null, planFromPrice(priceId)]);
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

app.use(express.json());
app.use(express.static(__dirname));

app.post("/api/auth/signup", async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    try { await db.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [id, email, passwordHash]); }
    catch (err) { if (err.code === "23505") return res.status(409).json({ error: "An account with that email already exists." }); throw err; }
    await createUserSession(res, id);
    res.status(201).json({ user: { id, email, plan: "free" } });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not create account." }); }
});
app.post("/api/auth/login", async (req, res) => {
  try {
    requireDb();
    const email = normalizeEmail(req.body?.email), password = String(req.body?.password || "");
    const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: "Incorrect email or password." });
    await createUserSession(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not sign in." }); }
});
app.post("/api/auth/logout", async (req, res) => {
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

app.post("/api/create-checkout-session", requireUser, async (req, res) => {
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
    });
    res.json({ url: session.url });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || "Could not create Stripe Checkout session." }); }
});

app.post("/api/admin/login", (req, res) => {
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Incorrect password." });
  const token = crypto.randomBytes(24).toString("hex");
  res.setHeader("Set-Cookie", `ss_admin=${encodeURIComponent(`${token}.${sign(token)}`)}; ${cookieOptions(8 * 60 * 60)}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { res.setHeader("Set-Cookie", `ss_admin=; ${cookieOptions(0)}`); res.json({ ok: true }); });
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

async function generateJob(jobId, idea, style, aspectRatio) {
  const job = jobs.get(jobId); if (!job) return;
  try {
    if (!replicate) throw new Error("AI video is not configured. Add REPLICATE_API_TOKEN to Render Environment Variables.");
    if (db) await db.query("UPDATE video_generations SET status='generating' WHERE job_id=$1", [jobId]);
    job.status = "generating"; job.progress = 8; job.message = "Starting three AI video scenes…";
    const prompts = buildScenes(idea, style, aspectRatio), outputs = [];
    for (let i = 0; i < prompts.length; i++) {
      job.progress = 10 + i * 18; job.message = `Generating scene ${i + 1} of 3…`;
      const output = await replicate.run(VIDEO_MODEL, { input: { prompt: prompts[i], duration: 10, resolution: "720p", aspect_ratio: aspectRatio, fps: 24, camera_fixed: false, generate_audio: true } });
      outputs.push(outputUrl(output));
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shortspark-")), clipPaths = [];
    for (let i = 0; i < outputs.length; i++) {
      const clip = path.join(dir, `clip-${i + 1}.mp4`); job.progress = 66 + i * 5; job.message = `Preparing scene ${i + 1}…`; await downloadTo(outputs[i], clip); clipPaths.push(clip);
    }
    const listPath = path.join(dir, "concat.txt");
    await fs.writeFile(listPath, clipPaths.map(p => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
    const finalPath = path.join(dir, "shortspark-short.mp4"); job.progress = 87; job.message = "Joining the scenes into one Short…";
    await ffmpegRun(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", finalPath]);
    const captionsPath = path.join(dir, "captions.srt");
    await fs.writeFile(captionsPath, `1\n00:00:00,000 --> 00:00:10,000\nStop scrolling. You need to hear this about ${idea}.\n\n2\n00:00:10,000 --> 00:00:20,000\nAt first, it sounds impossible. But then one detail changes everything.\n\n3\n00:00:20,000 --> 00:00:30,000\nAnd that's the part nobody sees coming. Would you have noticed it?\n`, "utf8");
    Object.assign(job, { dir, finalPath, captionsPath, progress: 100, message: "Your 30-second Short is ready.", status: "completed" });
    if (db) await db.query("UPDATE video_generations SET status='completed', completed_at=NOW() WHERE job_id=$1", [jobId]);
  } catch (error) {
    console.error(`Video job ${jobId} failed`, error); Object.assign(job, { status: "failed", progress: 0, error: error.message || "Video generation failed." });
    if (db) await db.query("UPDATE video_generations SET status='failed', error=$2 WHERE job_id=$1", [jobId, job.error]);
  }
}
app.post("/api/generate-video", requireUser, async (req, res) => {
  const idea = cleanIdea(req.body?.idea), style = String(req.body?.style || "Fast & viral"), aspectRatio = req.body?.aspectRatio === "16:9" ? "16:9" : "9:16";
  if (!idea) return res.status(400).json({ error: "Enter an idea first." });
  if (!replicate) return res.status(503).json({ error: "AI video is not configured yet. Add REPLICATE_API_TOKEN to Render." });
  if (!db) return res.status(503).json({ error: "Accounts are not configured yet. Add DATABASE_URL to Render." });
  if (jobs.size > 10) return res.status(429).json({ error: "The generator is busy. Try again in a minute." });
  try {
    const reservation = await reserveGeneration(req.user, idea, style, aspectRatio);
    if (!reservation.ok) return res.status(429).json({ error: `You've used all ${reservation.usage.limit} video generation(s) for this ${reservation.usage.period}.`, usage: reservation.usage });
    jobs.set(reservation.jobId, { status: "queued", progress: 2, message: "Queued…", createdAt: Date.now(), userId: req.user.id });
    generateJob(reservation.jobId, idea, style, aspectRatio);
    res.status(202).json({ jobId: reservation.jobId, usage: reservation.usage });
  } catch (err) { console.error(err); res.status(500).json({ error: "Could not start video generation." }); }
});
app.get("/api/video-status/:id", requireUser, (req, res) => {
  const job = jobs.get(req.params.id); if (!job || job.userId !== req.user.id) return res.status(404).json({ error: "Video job not found." });
  if (job.status === "completed") return res.json({ status: "completed", progress: 100, message: job.message, videoUrl: `/api/generated-video/${req.params.id}`, captionsUrl: `/api/generated-captions/${req.params.id}` });
  if (job.status === "failed") return res.status(500).json({ status: "failed", error: job.error || "Video generation failed." });
  res.json({ status: job.status, progress: job.progress, message: job.message });
});
app.get("/api/generated-video/:id", requireUser, (req, res) => { const job = jobs.get(req.params.id); if (!job?.finalPath || job.userId !== req.user.id) return res.status(404).send("Video not found."); res.sendFile(job.finalPath); });
app.get("/api/generated-captions/:id", requireUser, (req, res) => { const job = jobs.get(req.params.id); if (!job?.captionsPath || job.userId !== req.user.id) return res.status(404).send("Captions not found."); res.type("text/plain").sendFile(job.captionsPath); });

setInterval(async () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) { if (job.dir) { try { await fs.rm(job.dir, { recursive: true, force: true }); } catch {} } jobs.delete(id); }
  if (db) { try { await db.query("DELETE FROM sessions WHERE expires_at<NOW()") } catch {} }
}, 10 * 60 * 1000).unref();

app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "admin.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "account.html")));
app.get("/{*splat}", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

initDb().then(() => app.listen(PORT, "0.0.0.0", () => console.log(`ShortSpark running on port ${PORT}`))).catch(err => { console.error("Database initialization failed", err); process.exit(1); });
