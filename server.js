require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Firebase Admin ────────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  const decoded = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "base64").toString("utf8");
serviceAccount = JSON.parse(decoded);
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
const USD_TO_NGN     = parseFloat(process.env.USD_TO_NGN   || "1600");

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

    const uid          = parts[1];
    const rawAmount    = parseFloat(data.amount);
    const currency     = (data.currency || 'NGN').toUpperCase();
    const flwRef       = data.flw_ref;

    // Convert everything to NGN before storing
    let amountNGN;
    if (currency === 'NGN') {
      amountNGN = rawAmount;
    } else if (currency === 'USD') {
      amountNGN = parseFloat((rawAmount * USD_TO_NGN).toFixed(2));
    } else if (currency === 'GBP') {
      amountNGN = parseFloat((rawAmount * USD_TO_NGN * 1.27).toFixed(2));
    } else if (currency === 'EUR') {
      amountNGN = parseFloat((rawAmount * USD_TO_NGN * 1.08).toFixed(2));
    } else {
      amountNGN = rawAmount;
    }
    console.log('💱 Payment: ' + currency + ' ' + rawAmount + ' → NGN ' + amountNGN);

    // Idempotency check
    const existing = await db.collection('transactions').where('flwRef', '==', flwRef).limit(1).get();
    if (!existing.empty) return res.status(200).json({ received: true, note: 'Already processed' });

    const userRef  = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(200).json({ received: true });

    const currentBalance = userSnap.data().balance || 0;
    const newBalance     = parseFloat((currentBalance + amountNGN).toFixed(2));
    const amount         = amountNGN;

    const batch = db.batch();
    batch.update(userRef, { balance: newBalance });

    const txDocRef = db.collection('transactions').doc();
    batch.set(txDocRef, {
      uid,
      type: 'topup',
      amount: amountNGN,
      originalAmount: rawAmount,
      originalCurrency: currency,
      currency: 'NGN',
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

// ── Daily burst campaign deductions ──────────────────────────────────────────
// ── Hourly deductions for 24hr burst campaigns ───────────────────────────────
// Runs every hour — deducts hourly cost, pauses if balance is too low
async function processHourlyDeductions() {
  try {
    const snap = await db.collection("campaigns")
      .where("status", "==", "active")
      .where("deliveryType", "==", "burst_24hr")
      .get();

    if (snap.empty) return;
    console.log(`⏱ Processing hourly deductions for ${snap.size} campaign(s)...`);

    for (const campDoc of snap.docs) {
      const camp     = campDoc.data();
      const userRef  = db.collection("users").doc(camp.uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) continue;

      const currentBalance = userSnap.data().balance || 0;

      // Calculate hourly cost — costPerHour stored at launch, fallback to costTotal/24
      const hourlyCost = camp.costPerHour || Math.ceil((camp.costTotal || 0) / 24);

      if (hourlyCost <= 0) continue;

      if (currentBalance < hourlyCost) {
        // Pause campaign — not enough for this hour
        await campDoc.ref.update({ status: "insufficient" });
        console.log(`⏸ Paused "${camp.name}" — balance too low (${currentBalance} < ${hourlyCost})`);
      } else {
        const newBalance   = parseFloat((currentBalance - hourlyCost).toFixed(2));
        // Hourly visitor increment (total volume / 24 hours)
        const hourlyVisitors = Math.round((camp.volume || 0) / 24);
        const newDelivered   = Math.min(camp.volume, (camp.deliveredCount || 0) + hourlyVisitors);
        const isComplete     = newDelivered >= (camp.volume || 0);

        const batch  = db.batch();
        batch.update(userRef, { balance: newBalance });

        const txRef = db.collection("transactions").doc();
        batch.set(txRef, {
          uid: camp.uid,
          type: "deduction",
          amount: hourlyCost,
          campaignId: campDoc.id,
          campaignName: camp.name,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          note: "Hourly traffic delivery charge",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        batch.update(campDoc.ref, {
          deliveredCount: newDelivered,
          lastChargedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(isComplete ? { status: "completed" } : {}),
        });

        await batch.commit();
        console.log(`✅ Charged ₦${hourlyCost}/hr from ${camp.uid} for "${camp.name}" (+${hourlyVisitors} visitors)`);
      }
    }
  } catch (err) {
    console.error("❌ Hourly deduction error:", err);
  }
}

// Also handle non-burst scheduled campaigns (daily deduction)
async function processDailyDeductions() {
  try {
    const snap = await db.collection("campaigns")
      .where("status", "==", "active")
      .where("deliveryType", "in", ["normal", "scheduled", "drip"])
      .get();

    for (const campDoc of snap.docs) {
      const camp    = campDoc.data();
      const dailyVisitors = Math.round((camp.volume || 0) / (camp.duration || 1));
      const newDelivered  = Math.min(camp.volume, (camp.deliveredCount || 0) + dailyVisitors);

      await campDoc.ref.update({
        deliveredCount: newDelivered,
        ...(newDelivered >= (camp.volume || 0) ? { status: "completed" } : {}),
      });
    }
  } catch (err) {
    console.error("❌ Daily update error:", err);
  }
}

app.post("/api/deduct-hourly", async (req, res) => {
  if (req.headers["x-internal-secret"] !== process.env.INTERNAL_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  await processHourlyDeductions();
  res.json({ ok: true });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Waveport backend running on port ${PORT}`);
  console.log(`📡 Webhook:  POST /webhook/flutterwave`);
  console.log(`💊 Health:   GET  /health`);

  // Hourly deductions — every 1 hour
  const hourlyInterval = 3600000;
  setInterval(processHourlyDeductions, hourlyInterval);
  console.log(`⏱  Hourly deductions: every 60 min`);

  // Daily delivery update — every 24 hours
  setInterval(processDailyDeductions, 86400000);
  const interval = parseInt(process.env.CRON_INTERVAL_MS) || 3600000;
  console.log(`⏱  Daily updates: every 24h`);
});
