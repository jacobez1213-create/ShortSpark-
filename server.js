import express from "express";
import Stripe from "stripe";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 4242;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const COOKIE_SECRET = process.env.COOKIE_SECRET || ADMIN_PASSWORD;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const priceIds = {
  creator: process.env.STRIPE_PRICE_CREATOR,
  pro: process.env.STRIPE_PRICE_PRO,
};

function sign(value) {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
}
function makeSession() {
  const value = crypto.randomBytes(24).toString("hex");
  return `${value}.${sign(value)}`;
}
function validSession(req) {
  const raw = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("ss_admin="));
  if (!raw) return false;
  const value = decodeURIComponent(raw.slice("ss_admin=".length));
  const [token, sig] = value.split(".");
  const expected = sign(token);
  if (!token || !sig || sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function requireAdmin(req,res,next) {
  if (!validSession(req)) return res.status(401).json({error:"Unauthorized"});
  next();
}

// Stripe webhook needs the raw request body, so define it before express.json().
app.post("/api/webhook", express.raw({type:"application/json"}), (req,res)=>{
  if (!stripe) return res.json({received:true, demo:true});
  const signature = req.headers["stripe-signature"];
  try {
    const event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    // Production app: update your DB from these events. Useful events include:
    // checkout.session.completed, invoice.paid, invoice.payment_failed,
    // customer.subscription.updated, customer.subscription.deleted.
    console.log(`Stripe event: ${event.type}`);
    res.json({received:true});
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(express.json());
app.use(express.static(__dirname));

app.post("/api/create-checkout-session", async (req,res)=>{
  const plan = req.body?.plan;
  const price = priceIds[plan];
  if (!stripe || !price) {
    return res.status(503).json({error:"Stripe is not configured. Add STRIPE_SECRET_KEY and the matching price ID to .env."});
  }
  try {
    const base = `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{price, quantity:1}],
      success_url: `${base}/?checkout=success`,
      cancel_url: `${base}/?checkout=cancelled`,
      allow_promotion_codes: true,
    });
    res.json({url: session.url});
  } catch (err) {
    console.error(err);
    res.status(500).json({error:"Could not create Stripe Checkout session."});
  }
});

app.post("/api/admin/login",(req,res)=>{
  if (req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({error:"Incorrect password."});
  const cookie = makeSession();
  res.setHeader("Set-Cookie", `ss_admin=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
  res.json({ok:true});
});
app.post("/api/admin/logout",(req,res)=>{
  res.setHeader("Set-Cookie","ss_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ok:true});
});

const demo = {
  available: 12847,
  pending: 3261,
  revenue: 24891,
  paymentCount: 184,
  activeSubscriptions: 97,
  payments:[
    {customer:"alex@example.com",amount:1999,status:"paid"},
    {customer:"creator@example.com",amount:999,status:"paid"},
    {customer:"studio@example.com",amount:1999,status:"paid"},
    {customer:"jamie@example.com",amount:999,status:"paid"},
  ],
  payouts:[
    {amount:6500,status:"paid",created:Date.now()/1000-86400*3},
    {amount:2500,status:"paid",created:Date.now()/1000-86400*10},
  ]
};

app.get("/api/admin/overview", requireAdmin, async (req,res)=>{
  if (!stripe) return res.json({demo:true,...demo});
  try {
    const balance = await stripe.balance.retrieve();
    const usdAvailable = balance.available.find(x=>x.currency==="usd")?.amount || 0;
    const usdPending = balance.pending.find(x=>x.currency==="usd")?.amount || 0;
    const since = Math.floor(Date.now()/1000)-60*60*24*30;
    const charges = await stripe.charges.list({limit:100, created:{gte:since}});
    const payments = charges.data.map(c=>({
      customer:c.billing_details?.email || c.receipt_email || c.customer || "Customer",
      amount:c.amount,
      status:c.paid ? "paid" : "failed"
    }));
    const revenue = charges.data.filter(c=>c.paid).reduce((sum,c)=>sum+c.amount,0);
    const subscriptions = await stripe.subscriptions.list({status:"active",limit:100});
    const payouts = await stripe.payouts.list({limit:10});
    res.json({
      demo:false,available:usdAvailable,pending:usdPending,revenue,
      paymentCount:payments.length,activeSubscriptions:subscriptions.data.length,
      payments,payouts:payouts.data.map(p=>({amount:p.amount,status:p.status,created:p.created}))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({error:"Stripe dashboard data could not be loaded."});
  }
});

app.post("/api/admin/payout", requireAdmin, async (req,res)=>{
  if (!stripe) return res.status(503).json({error:"Payouts are unavailable in demo mode."});
  const amount = Math.round(Number(req.body?.amount || 0)*100);
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({error:"Enter a positive USD amount."});
  try {
    const payout = await stripe.payouts.create({amount,currency:"usd",description:"ShortSpark manual payout"});
    res.json({id:payout.id,status:payout.status});
  } catch (err) {
    console.error(err);
    res.status(400).json({error:err.message || "Could not create payout."});
  }
});

app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"admin.html")));
app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.listen(PORT,()=>console.log(`ShortSpark running on http://localhost:${PORT}`));
