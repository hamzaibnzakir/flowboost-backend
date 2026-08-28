# FlowBoost traffic backend

This Node/Express service supports the FlowBoost website-traffic product. It handles Firebase Admin access, Flutterwave payment webhooks, wallet credits, campaign delivery updates, and balance deductions. The separate SMM/Owlet reseller-service product has been removed.

## Local setup

```bash
npm ci
cp .env.example .env
# Fill .env with Firebase, Flutterwave, and CORS values
npm start
```

The health endpoint is `GET /health`.

## Railway deployment

Create a Railway project from this repository, use the variables in `.env.example`, and deploy. Railway will use `npm start` and the `/health` healthcheck from `railway.toml`. Set `FRONTEND_URL` to the exact production frontend origin. Configure the Flutterwave webhook as:

```text
https://YOUR_RAILWAY_DOMAIN/webhook/flutterwave
```

Do not commit `.env`, Firebase service-account files, or payment credentials.
