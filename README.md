# FlowBoost — Growth Infrastructure SaaS

A full-stack React application for purchasing targeted website traffic.
Frontend hosted on GitHub Pages. Backend runs on your VPS.

---

## Project Structure

```
flowboost/          ← React frontend (GitHub Pages)
flowboost-backend/  ← Express backend (your VPS)
```

---

## STEP 1 — Firebase Setup

1. Go to https://console.firebase.google.com
2. Create a new project (name it "flowboost")
3. **Add a Web App** → copy the `firebaseConfig` object
4. Paste it into: `flowboost/src/lib/firebase.js`

Enable these in Firebase Console:
- **Authentication** → Sign-in methods → enable **Google** and **Email/Password**
- **Firestore Database** → Create database → choose a region → Start in production mode

Add this Firestore security rule (in Firebase Console → Firestore → Rules):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /campaigns/{campaignId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
    }
    match /transactions/{txId} {
      allow read: if request.auth != null && request.auth.uid == resource.data.uid;
      allow write: if false; // Only backend writes transactions
    }
  }
}
```

---

## STEP 2 — Flutterwave Setup

1. Go to https://dashboard.flutterwave.com
2. **Settings → API Keys** → copy your **Public Key** and **Secret Key**
3. Paste Public Key into: `flowboost/src/lib/flutterwave.js`
4. Keep Secret Key for the backend `.env` file (never put it in frontend)

**Webhook Setup (after VPS is running):**
- Go to **Settings → Webhooks** in Flutterwave dashboard
- Set URL to: `http://YOUR_VPS_IP:3001/webhook/flutterwave`
- Set a secret hash (make it a strong random string)
- Add the same hash to your backend `.env` as `FLUTTERWAVE_WEBHOOK_HASH`

---

## STEP 3 — VPS Backend Setup

SSH into your VPS and run:

```bash
# Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Copy the backend folder to your VPS (via scp, git, or however you prefer)
# Then:
cd flowboost-backend
npm install

# Copy .env.example to .env and fill in all values
cp .env.example .env
nano .env

# Download Firebase service account JSON:
# Firebase Console → Project Settings → Service Accounts → Generate new private key
# Save as: flowboost-backend/firebase-service-account.json

# Start the server
npm start
```

**Keep it running with PM2:**
```bash
npm install -g pm2
pm2 start server.js --name flowboost-backend
pm2 save
pm2 startup
```

**Verify it's working:**
```bash
curl http://localhost:3001/health
# Should return: {"status":"ok",...}
```

---

## STEP 4 — Frontend GitHub Pages Deployment

1. Create a GitHub repo named `flowboost`

2. Edit `flowboost/vite.config.js`:
   ```js
   base: "/flowboost/",  // ← your repo name
   ```

3. Edit `flowboost/package.json`:
   ```json
   "homepage": "https://YOURUSERNAME.github.io/flowboost"
   ```

4. Edit `flowboost/src/lib/flutterwave.js`:
   ```js
   export const API_BASE_URL = "http://YOUR_VPS_IP:3001";
   ```

5. Push to GitHub and deploy:
   ```bash
   cd flowboost
   git init
   git remote add origin https://github.com/YOURUSERNAME/flowboost.git
   git add .
   git commit -m "initial commit"
   git push -u origin main
   npm run deploy
   ```

6. In GitHub repo → **Settings → Pages** → set source to `gh-pages` branch

Your app will be live at: `https://YOURUSERNAME.github.io/flowboost`

---

## STEP 5 — Firebase Auth Authorized Domains

In Firebase Console → **Authentication → Settings → Authorized domains**:
Add: `YOURUSERNAME.github.io`

---

## Local Development

```bash
cd flowboost
npm run dev
# App runs at http://localhost:5173
```

For backend dev:
```bash
cd flowboost-backend
npm run dev
# Server runs at http://localhost:3001
```

---

## Files to Fill In (Checklist)

| File | What to add |
|------|-------------|
| `flowboost/src/lib/firebase.js` | Your Firebase config object |
| `flowboost/src/lib/flutterwave.js` | Your Flutterwave public key + VPS URL |
| `flowboost/vite.config.js` | Your GitHub repo name |
| `flowboost/package.json` | Your GitHub username |
| `flowboost-backend/.env` | Firebase + Flutterwave secrets |
| `flowboost-backend/firebase-service-account.json` | Downloaded from Firebase |

---

## Adding New Services (Coming Soon slots)

To add a new service later:
1. Add a new traffic type to `TRAFFIC_TYPES` in `NewCampaign.jsx`
2. Remove it from `COMING_SOON` in `Sidebar.jsx`
3. Handle the new type in backend `server.js`
