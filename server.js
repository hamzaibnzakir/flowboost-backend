require("dotenv").config();
const express = require("express");
const cors = require("cors");
const https = require("https");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Firebase Admin ────────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
} else {
  try {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "./firebase-service-account.json");
  } catch {
    console.error("❌ No Firebase credentials found.");
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const OWLET_API_URL  = process.env.OWLET_API_URL  || "https://the-owlet.com/api/v2";
const OWLET_API_KEY  = process.env.OWLET_API_KEY  || "";
const SMM_MARKUP = parseFloat(process.env.SMM_MARKUP || "1.25");
const USD_TO_NGN     = parseFloat(process.env.USD_TO_NGN   || "1600");

// Services cache — refresh every hour
let servicesCache     = null;
let servicesCacheTime = 0;
const CACHE_TTL       = 3600000;

// ── Owlet API helper ──────────────────────────────────────────────────────────
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
        "User-Agent": "Mozilla/5.0",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Invalid response: " + data.slice(0, 100))); }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Convert Owlet NGN rate to our NGN price with markup
// Owlet rates are per 1000 already in NGN (from the balance response showing NGN)
function applyMarkup(rate) {
  return Math.ceil(parseFloat(rate) * SMM_MARKUP);
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Flutterwave Webhook ───────────────────────────────────────────────────────
app.post("/webhook/flutterwave", async (req, res) => {
  try {
    const hash = req.headers["verif-hash"];
    if (!hash || hash !== process.env.FLUTTERWAVE_WEBHOOK_HASH) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = JSON.parse(req.body.toString());
    const { event, data } = body;

    if (event !== "charge.completed") return res.status(200).json({ received: true });
    if (data.status !== "successful") return res.status(200).json({ received: true });

    const txRef  = data.tx_ref || "";
    const parts  = txRef.split("_");
    if (parts.length < 3 || parts[0] !== "fw") return res.status(200).json({ received: true });

    const uid    = parts[1];
    const amount = parseFloat(data.amount);
    const flwRef = data.flw_ref;

    // Idempotency check
    const existing = await db.collection("transactions").where("flwRef", "==", flwRef).limit(1).get();
    if (!existing.empty) return res.status(200).json({ received: true, note: "Already processed" });

    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(200).json({ received: true });

    const currentBalance = userSnap.data().balance || 0;
    const newBalance     = parseFloat((currentBalance + amount).toFixed(2));

    const batch = db.batch();
    batch.update(userRef, { balance: newBalance });

    const txDocRef = db.collection("transactions").doc();
    batch.set(txDocRef, {
      uid, type: "topup", amount,
      currency: data.currency,
      balanceBefore: currentBalance,
      balanceAfter: newBalance,
      flwRef, txRef,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    console.log(`✅ Credited ₦${amount} to ${uid} → balance: ₦${newBalance}`);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── SMM: Get services ─────────────────────────────────────────────────────────
app.get("/api/smm/services", async (req, res) => {
  try {
    const now = Date.now();
    if (servicesCache && now - servicesCacheTime < CACHE_TTL) {
      return res.json(servicesCache);
    }

    const raw = await owletRequest({ action: "services" });
    if (!Array.isArray(raw)) {
      return res.status(502).json({ error: "Bad response from provider" });
    }

    // Map Owlet fields — rate is per 1000, already in NGN
    const services = raw.map((s) => ({
      service:   s.service,
      name:      s.name,
      category:  s.category,
      type:      s.type,
      min:       parseInt(s.min),
      max:       parseInt(s.max),
      dripfeed:  s.dripfeed,
      refill:    s.refill,
      cancel:    s.cancel,
      rate_ngn:  applyMarkup(s.rate), // our price per 1K in NGN
    }));

    servicesCache     = services;
    servicesCacheTime = now;
    console.log(`✅ Loaded ${services.length} SMM services from Owlet`);
    res.json(services);

  } catch (err) {
    console.error("❌ SMM services error:", err);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

// ── SMM: Place order ──────────────────────────────────────────────────────────
app.post("/api/smm/order", async (req, res) => {
  try {
    const { uid, serviceId, link, quantity, campaignName } = req.body;
    if (!uid || !serviceId || !link || !quantity) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Refresh cache if needed
    const now = Date.now();
    if (!servicesCache || now - servicesCacheTime >= CACHE_TTL) {
      const raw = await owletRequest({ action: "services" });
      servicesCache = raw.map((s) => ({
        service: s.service, name: s.name, category: s.category,
        type: s.type, min: parseInt(s.min), max: parseInt(s.max),
        dripfeed: s.dripfeed, refill: s.refill, cancel: s.cancel,
        rate_ngn: applyMarkup(s.rate),
      }));
      servicesCacheTime = now;
    }

    const service = servicesCache.find((s) => s.service == serviceId);
    if (!service) return res.status(404).json({ error: "Service not found" });

    const qty = parseInt(quantity);
    if (qty < service.min || qty > service.max) {
      return res.status(400).json({ error: `Quantity must be between ${service.min} and ${service.max}` });
    }

    // Cost in NGN
    const costNGN = Math.ceil((qty / 1000) * service.rate_ngn);

    // Check user balance
    const userRef  = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

    const currentBalance = userSnap.data().balance || 0;
    if (currentBalance < costNGN) {
      return res.status(400).json({
        error: "Insufficient balance",
        required: costNGN,
        balance: currentBalance,
      });
    }

    // Place order on Owlet
    const owletRes = await owletRequest({
      action:   "add",
      service:  serviceId,
      link:     link,
      quantity: qty,
    });

    if (owletRes.error) {
      return res.status(400).json({ error: owletRes.error });
    }

    const owletOrderId = owletRes.order;
    const newBalance   = parseFloat((currentBalance - costNGN).toFixed(2));

    // Save order + deduct balance atomically
    const batch      = db.batch();
    const orderRef   = db.collection("smm_orders").doc();
    const txRef      = db.collection("transactions").doc();

    batch.set(orderRef, {
      uid,
      owletOrderId,
      serviceId:    parseInt(serviceId),
      serviceName:  service.name,
      category:     service.category,
      link,
      quantity:     qty,
      costNGN,
      status:       "pending",
      campaignName: campaignName || service.name,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(userRef, { balance: newBalance });

    batch.set(txRef, {
      uid,
      type:         "deduction",
      amount:       costNGN,
      campaignName: campaignName || service.name,
      balanceBefore: currentBalance,
      balanceAfter:  newBalance,
      smmOrderId:   orderRef.id,
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    console.log(`✅ SMM order #${owletOrderId} — ${service.name} — ₦${costNGN} — user ${uid}`);
    res.json({ success: true, orderId: orderRef.id, owletOrderId, cost: costNGN, newBalance });

  } catch (err) {
    console.error("❌ SMM order error:", err);
    res.status(500).json({ error: "Failed to place order" });
  }
});

// ── SMM: Get user orders ──────────────────────────────────────────────────────
app.get("/api/smm/orders/:uid", async (req, res) => {
  try {
    const snap = await db.collection("smm_orders")
      .where("uid", "==", req.params.uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error("❌ Fetch orders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// ── SMM: Check order status ───────────────────────────────────────────────────
app.post("/api/smm/status", async (req, res) => {
  try {
    const { owletOrderId, orderId } = req.body;
    const status = await owletRequest({ action: "status", order: owletOrderId });

    if (orderId && status.status) {
      const s = status.status.toLowerCase();
      const normalized =
        s.includes("complet") ? "completed" :
        s.includes("progress") || s.includes("processing") ? "in_progress" :
        s.includes("partial") ? "partial" :
        s.includes("cancel") ? "cancelled" : "pending";

      await db.collection("smm_orders").doc(orderId).update({
        status:     normalized,
        startCount: status.start_count || null,
        remains:    status.remains     || null,
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json(status);
  } catch (err) {
    console.error("❌ Status check error:", err);
    res.status(500).json({ error: "Failed to check status" });
  }
});

// ── SMM: Reseller balance ─────────────────────────────────────────────────────
app.get("/api/smm/reseller-balance", async (req, res) => {
  try {
    const data = await owletRequest({ action: "balance" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// ── Daily burst campaign deductions ──────────────────────────────────────────
async function processDailyDeductions() {
  try {
    const snap = await db.collection("campaigns")
      .where("status", "==", "active")
      .where("deliveryType", "==", "burst_24hr")
      .get();

    for (const campDoc of snap.docs) {
      const camp    = campDoc.data();
      const userRef = db.collection("users").doc(camp.uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) continue;

      const currentBalance = userSnap.data().balance || 0;
      const dailyCost      = camp.costPerDay || 0;

      if (currentBalance < dailyCost) {
        await campDoc.ref.update({ status: "insufficient" });
        console.log(`⏸ Paused campaign "${camp.name}" — low balance`);
      } else {
        const newBalance    = parseFloat((currentBalance - dailyCost).toFixed(2));
        const dailyVisitors = Math.round(camp.volume / (camp.duration || 1));
        const newDelivered  = Math.min(camp.volume, (camp.deliveredCount || 0) + dailyVisitors);
        const batch         = db.batch();

        batch.update(userRef, { balance: newBalance });

        const txRef = db.collection("transactions").doc();
        batch.set(txRef, {
          uid: camp.uid, type: "deduction", amount: dailyCost,
          campaignId: campDoc.id, campaignName: camp.name,
          balanceBefore: currentBalance, balanceAfter: newBalance,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        batch.update(campDoc.ref, {
          deliveredCount: newDelivered,
          ...(newDelivered >= camp.volume ? { status: "completed" } : {}),
        });

        await batch.commit();
        console.log(`✅ Deducted ₦${dailyCost} from ${camp.uid} for "${camp.name}"`);
      }
    }
  } catch (err) {
    console.error("❌ Daily deduction error:", err);
  }
}

app.post("/api/deduct-daily", async (req, res) => {
  if (req.headers["x-internal-secret"] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await processDailyDeductions();
  res.json({ ok: true });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Waveport backend running on port ${PORT}`);
  console.log(`📡 Webhook:  POST /webhook/flutterwave`);
  console.log(`🛍  SMM:      GET  /api/smm/services`);
  console.log(`💊 Health:   GET  /health`);

  const interval = parseInt(process.env.CRON_INTERVAL_MS) || 3600000;
  setInterval(processDailyDeductions, interval);
  console.log(`⏱  Cron: every ${interval / 1000}s`);
});
