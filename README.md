# Loan Servicing — CSR Console

A small loan-servicing API with a React frontend that lets a customer service rep answer two questions about any loan in the portfolio:

1. **Is this loan current, or is the borrower behind?**
2. **Was their most recent payment on time?**

---

## Prerequisites

- Node 18+ and npm (both via `node --version` / `npm --version`)
- Git (already used to clone this repo)

No database, no Docker, nothing else.

---

## Setup

Clone the repo and install dependencies for both the API and the frontend. They are independent packages with their own `node_modules`.

**From the project root:**

```bash
# API:
cd api
npm install

# Frontend:
cd ../web
npm install
```

---

## Running the API

```bash
cd api
npm start
```

The API listens on `http://127.0.0.1:3001`. To confirm it's up:

```bash
curl http://127.0.0.1:3001/health
# → {"ok":true}
```

> The API loads `seed-data.json` at startup and keeps everything in memory. Payments recorded via `POST` persist for the life of the process and reset on restart.

---

## Running the Frontend

In a **second terminal** (keep the API running):

```bash
cd web
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/api/*` to the API on `:3001` — no CORS configuration needed.

Pick a loan from the left panel. The right side shows the evaluation summary, loan detail, a payment recording form, and the full payment history.

---

## Running the Tests

### Vitest unit suite (recommended)

```bash
cd api
npm test
```

Covers every function in `evaluation.js`: date helpers, payment classification including the 10/11-day grace boundary, every labeled seed edge case (L-1001 through L-1008), synthetic boundary scenarios, and balance computation. All tests use a pinned reference date so results are fully deterministic.

To run in watch mode during development:

```bash
npm run test:watch
```

### Smoke test (no dependencies required)

```bash
cd api
node smoke-test.js
```

A zero-dependency Node script that checks all 20 seed loans for expected status and runs three post-payment flows: L-1003 pay-April → `late` → pay-May → `current`; L-1006 cumulative partial top-up → `current` with `nextDueDate` advancing; L-1003 3× overpayment split across consecutive due dates → `current`. Exits `0` on success, `1` on any failure. Useful when npm packages aren't available.

---

## Project Layout

```
seed-data.json          portfolio (~20 loans, ~200 payments)
api/
  server.js             Fastify entry point (port 3001)
  smoke-test.js         zero-dependency evaluation check
  src/
    data.js             in-memory store + seed loader
    evaluation.js       status / delinquency / on-time-rate logic
    evaluation.test.js  Vitest suite
    routes.js           HTTP handlers
web/
  src/
    App.jsx             full UI (~490 lines)
    api.js              fetch wrapper
    App.css
```

---

## Quick API Reference

All endpoints accept `?asOf=YYYY-MM-DD` to override the evaluation date — handy for reproducing seed edge cases at any point in time.

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/loans` | All loans with status, balance, next due date |
| `GET` | `/loans/:id` | Full loan detail |
| `GET` | `/loans/:id/payments` | Payment history, newest first, each classified |
| `POST` | `/loans/:id/payments` | Record a payment (`{ amount, paidOn, dueDate? }`) |
| `GET` | `/loans/:id/evaluation` | Full status evaluation with CSR summary |

```bash
# Try the delinquent loan
curl "http://127.0.0.1:3001/loans/L-1003/evaluation" | jq .

# Reproduce seed behavior at the authored date
curl "http://127.0.0.1:3001/loans?asOf=2026-05-15" | jq '.[0:4]'
```
