// ─────────────────────────────────────────────────────────────────────────────
// FlowBoost Backend — Express Server
// Runs on your 1GB RAM VPS
//
// Handles:
//   POST /webhook/flutterwave  → verifies payment + credits user balance
//   POST /api/deduct-daily     → internal cron: deducts burst campaign costs
//   GET  /health               → health check
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Firebase Admin init ──────────────────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json");
} catch {
  console.error("❌  firebase-service-account.json not found.");
  console.error("   Download it from Firebase Console → Project Settings → Service Accounts");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
}));

// Raw body needed for webhook signature verification
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Flutterwave Webhook ──────────────────────────────────────────────────────
// Configure in Flutterwave Dashboard → Settings → Webhooks
// Set webhook URL to: http://YOUR_VPS_IP:3001/webhook/flutterwave
// Set webhook hash to match FLUTTERWAVE_WEBHOOK_HASH in .env
app.post("/webhook/flutterwave", async (req, res) => {
  try {
    // Verify webhook signature
    const hash = req.headers["verif-hash"];
    if (!hash || hash !== process.env.FLUTTERWAVE_WEBHOOK_HASH) {
      console.warn("⚠️  Invalid webhook hash — rejected");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = JSON.parse(req.body.toString());
    const { event, data } = body;

    // Only process successful charge events
    if (event !== "charge.completed") {
      return res.status(200).json({ received: true });
    }

    if (data.status !== "successful") {
      return res.status(200).json({ received: true, note: "Non-successful payment ignored" });
    }

    // Extract user UID from tx_ref: format "fw_{uid}_{timestamp}"
    const txRef = data.tx_ref || "";
    const parts = txRef.split("_");
    if (parts.length < 3 || parts[0] !== "fw") {
      console.warn("⚠️  Unrecognized tx_ref format:", txRef);
      return res.status(200).json({ received: true });
    }

    const uid = parts[1];
    const amount = parseFloat(data.amount);
    const currency = data.currency;
    const flwRef = data.flw_ref;

    // Idempotency check — don't credit the same payment twice
    const existingTx = await db.collection("transactions")
      .where("flwRef", "==", flwRef)
      .limit(1)
      .get();

    if (!existingTx.empty) {
      console.log(`ℹ️  Duplicate webhook for flwRef ${flwRef} — skipping`);
      return res.status(200).json({ received: true, note: "Already processed" });
    }

    // Get user doc and current balance
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      console.warn(`⚠️  User ${uid} not found in Firestore`);
      return res.status(200).json({ received: true });
    }

    const currentBalance = userSnap.data().balance || 0;
    const newBalance = parseFloat((currentBalance + amount).toFixed(2));

    // Update balance in transaction (atomic)
    const batch = db.batch();

    batch.update(userRef, { balance: newBalance });

    const txRef2 = db.collection("transactions").doc();
    batch.set(txRef2, {
      uid,
      type: "topup",
      amount,
      currency,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      flwRef,
      txRef,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(`✅  Credited $${amount} to user ${uid} (new balance: $${newBalance})`);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌  Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── Daily Burst Campaign Deduction ───────────────────────────────────────────
// This runs on a cron-like interval to deduct daily costs from burst campaigns
// and pause campaigns when balance hits $0

async function processDailyDeductions() {
  console.log("🔄  Running daily burst campaign deductions...");

  try {
    // Get all active burst campaigns
    const campaignsSnap = await db.collection("campaigns")
      .where("status", "==", "active")
      .where("deliveryType", "==", "burst_24hr")
      .get();

    if (campaignsSnap.empty) {
      console.log("ℹ️  No active burst campaigns to process.");
      return;
    }

    let processed = 0;
    let paused = 0;

    for (const campDoc of campaignsSnap.docs) {
      const camp = campDoc.data();
      const userRef = db.collection("users").doc(camp.uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) continue;

      const currentBalance = userSnap.data().balance || 0;
      const dailyCost = camp.costPerDay || 0;

      if (currentBalance < dailyCost) {
        // Pause campaign due to insufficient balance
        await campDoc.ref.update({ status: "insufficient" });
        paused++;
        console.log(`⏸  Paused campaign "${camp.name}" (uid: ${camp.uid}) — insufficient balance`);
      } else {
        // Deduct daily cost
        const newBalance = parseFloat((currentBalance - dailyCost).toFixed(2));

        const batch = db.batch();
        batch.update(userRef, { balance: newBalance });

        // Log the deduction
        const txRef = db.collection("transactions").doc();
        batch.set(txRef, {
          uid: camp.uid,
          type: "deduction",
          amount: dailyCost,
          campaignId: campDoc.id,
          campaignName: camp.name,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Increment delivered count (simulate traffic delivery)
        // In production, replace this with your actual traffic delivery logic
        const dailyVisitors = Math.round(camp.volume / (camp.duration || 1));
        const newDelivered = Math.min(
          camp.volume,
          (camp.deliveredCount || 0) + dailyVisitors
        );

        batch.update(campDoc.ref, {
          deliveredCount: newDelivered,
          ...(newDelivered >= camp.volume ? { status: "completed" } : {}),
        });

        await batch.commit();
        processed++;

        console.log(`✅  Deducted $${dailyCost} from user ${camp.uid} for campaign "${camp.name}"`);
      }
    }

    console.log(`✅  Deduction run complete. Processed: ${processed}, Paused: ${paused}`);
  } catch (err) {
    console.error("❌  Daily deduction error:", err);
  }
}

// ── Internal deduction endpoint (can be called by external cron, e.g. crontab) ──
app.post("/api/deduct-daily", async (req, res) => {
  // Simple secret check to prevent unauthorized calls
  const secret = req.headers["x-internal-secret"];
  if (secret !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await processDailyDeductions();
  res.json({ ok: true });
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   FlowBoost Backend running on :${PORT}   ║
╚════════════════════════════════════════╝
  `);
  console.log("📡  Webhook endpoint: POST /webhook/flutterwave");
  console.log("🔧  Health check:     GET  /health");
  console.log("");

  // Run deductions on interval (every hour by default)
  const interval = parseInt(process.env.CRON_INTERVAL_MS) || 3600000;
  setInterval(processDailyDeductions, interval);
  console.log(`⏱  Daily deduction cron: every ${interval / 1000}s`);
});


// ─────────────────────────────────────────────────────────────────────────────
// SMM RESELLER — Owlet API Integration
// All SMM calls go through this VPS since Owlet whitelists by IP
// Markup: 60% on top of Owlet's USD rate, converted to NGN
// ─────────────────────────────────────────────────────────────────────────────

const https = require("https");

const OWLET_API_URL = "https://the-owlet.com/api/v2";
const OWLET_API_KEY = "39a37799e456e85a37d74b548dc904a5";
const MARKUP = 1.60; // 60% markup
const USD_TO_NGN = 1600; // Update this rate periodically

// Cache services for 1 hour to avoid hammering Owlet API
let servicesCache = null;
let servicesCacheTime = 0;
const CACHE_TTL = 3600000;

function owletRequest(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ key: OWLET_API_KEY, ...params }).toString();
    const urlObj = new URL(OWLET_API_URL);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid response: " + data)); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Convert Owlet USD rate to NGN with markup
function toNGN(usdRate) {
  return Math.ceil(parseFloat(usdRate) * USD_TO_NGN * MARKUP);
}

// GET /api/smm/services — fetch all services with our NGN pricing
app.get("/api/smm/services", async (req, res) => {
  try {
    const now = Date.now();
    if (servicesCache && now - servicesCacheTime < CACHE_TTL) {
      return res.json(servicesCache);
    }
    const raw = await owletRequest({ action: "services" });
    if (!Array.isArray(raw)) return res.status(502).json({ error: "Bad response from provider" });

    const services = raw.map((s) => ({
      service: s.service,
      name: s.name,
      category: s.category,
      type: s.type,
      min: parseInt(s.min),
      max: parseInt(s.max),
      refill: s.refill,
      cancel: s.cancel,
      rate_ngn: toNGN(s.rate), // Our price in NGN per 1000
      rate_raw: parseFloat(s.rate), // Owlet's USD rate (don't expose to frontend)
    }));

    // Remove rate_raw before sending to client
    const clientServices = services.map(({ rate_raw, ...s }) => s);
    servicesCache = clientServices;
    servicesCacheTime = now;
    res.json(clientServices);
  } catch (err) {
    console.error("SMM services error:", err);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

// POST /api/smm/order — place an SMM order
app.post("/api/smm/order", async (req, res) => {
  try {
    const { uid, serviceId, link, quantity, campaignName } = req.body;
    if (!uid || !serviceId || !link || !quantity) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user exists and has enough balance
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

    const user = userSnap.data();

    // Get service to calculate cost
    const now = Date.now();
    if (!servicesCache || now - servicesCacheTime >= CACHE_TTL) {
      // Refresh cache
      const raw = await owletRequest({ action: "services" });
      servicesCache = raw.map((s) => ({
        service: s.service, name: s.name, category: s.category,
        type: s.type, min: parseInt(s.min), max: parseInt(s.max),
        refill: s.refill, cancel: s.cancel,
        rate_ngn: toNGN(s.rate), rate_raw: parseFloat(s.rate),
      }));
      servicesCacheTime = now;
    }

    const service = servicesCache.find((s) => s.service == serviceId);
    if (!service) return res.status(404).json({ error: "Service not found" });

    // Validate quantity
    if (quantity < service.min || quantity > service.max) {
      return res.status(400).json({ error: `Quantity must be between ${service.min} and ${service.max}` });
    }

    // Calculate cost in NGN
    const costNGN = Math.ceil((quantity / 1000) * service.rate_ngn);

    if (user.balance < costNGN) {
      return res.status(400).json({ error: "Insufficient balance", required: costNGN, balance: user.balance });
    }

    // Place order on Owlet
    const owletResponse = await owletRequest({
      action: "add",
      service: serviceId,
      link,
      quantity,
    });

    if (owletResponse.error) {
      return res.status(400).json({ error: owletResponse.error });
    }

    const owletOrderId = owletResponse.order;
    const newBalance = parseFloat((user.balance - costNGN).toFixed(2));

    // Save order and deduct balance atomically
    const batch = db.batch();

    const orderRef = db.collection("smm_orders").doc();
    batch.set(orderRef, {
      uid,
      owletOrderId,
      serviceId,
      serviceName: service.name,
      category: service.category,
      link,
      quantity,
      costNGN,
      status: "pending",
      campaignName: campaignName || service.name,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(userRef, { balance: newBalance });

    const txRef = db.collection("transactions").doc();
    batch.set(txRef, {
      uid,
      type: "deduction",
      amount: costNGN,
      campaignName: campaignName || service.name,
      balanceBefore: user.balance,
      balanceAfter: newBalance,
      smmOrderId: orderRef.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(`✅ SMM order placed: ${owletOrderId} for user ${uid} — ₦${costNGN}`);
    res.json({ success: true, orderId: orderRef.id, owletOrderId, cost: costNGN, newBalance });
  } catch (err) {
    console.error("SMM order error:", err);
    res.status(500).json({ error: "Failed to place order" });
  }
});

// GET /api/smm/orders/:uid — get user's SMM orders
app.get("/api/smm/orders/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const snap = await db.collection("smm_orders")
      .where("uid", "==", uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// POST /api/smm/status — check order status from Owlet
app.post("/api/smm/status", async (req, res) => {
  try {
    const { owletOrderId, orderId, uid } = req.body;
    const status = await owletRequest({ action: "status", order: owletOrderId });

    // Update status in Firestore
    if (orderId && status.status) {
      const normalized = status.status.toLowerCase().includes("complet") ? "completed"
        : status.status.toLowerCase().includes("progress") ? "in_progress"
        : status.status.toLowerCase().includes("partial") ? "partial"
        : status.status.toLowerCase().includes("cancel") ? "cancelled"
        : "pending";

      await db.collection("smm_orders").doc(orderId).update({
        status: normalized,
        startCount: status.start_count,
        remains: status.remains,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Failed to check status" });
  }
});

// GET /api/smm/balance — check Owlet reseller balance
app.get("/api/smm/balance", async (req, res) => {
  try {
    const balance = await owletRequest({ action: "balance" });
    res.json(balance);
  } catch (err) {
    res.status(500).json({ error: "Failed to check balance" });
  }
});
