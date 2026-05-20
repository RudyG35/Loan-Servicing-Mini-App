# Loan Servicing — CSR Console

A web-based console for customer service reps to check loan standing and record payments in real time.

No database. No Docker. Just Node.

---

## Prerequisites

- Node 18 or later
- npm (bundled with Node)
- Git

Verify with:

```bash
node --version   # v18.x or higher
npm --version
```

---

## Setup

Clone the repo, then install dependencies for the API and the frontend separately. They are independent packages.

```bash
git clone <repo-url>
cd loan-servicing

cd api && npm install
cd ../web && npm install
```

---

## Running the API

```bash
cd api
npm start
```

The API starts on `http://127.0.0.1:3001`. Confirm it's up:

```bash
curl http://127.0.0.1:3001/health
# → {"ok":true}
```

The API loads `seed-data.json` at startup and keeps all data in memory. Payments recorded during a session reset on restart.

---

## Running the Frontend

Open a **second terminal**, leaving the API running in the first:

```bash
cd web
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies all `/api/*` requests to the API on port 3001, so no CORS setup is needed.

---

## Running the Tests

### Unit tests (Vitest)

```bash
cd api
npm test
```

Covers all logic in `evaluation.js`: date helpers, payment classification, every labeled seed edge case (L-1001 through L-1020), on-time rate scenarios, and balance computation. All tests run against a pinned reference date so results are fully deterministic.

Run in watch mode during development:

```bash
npm run test:watch
```

### Smoke test (no npm required)

```bash
cd api
node smoke-test.js
```

A zero-dependency Node script that evaluates all 20 seed loans and exercises three post-payment flows:

- L-1003: pay April → `late`; pay May → `current`
- L-1006: cumulative partial top-up → `current`, `nextDueDate` advances
- L-1003: 3× overpayment split across consecutive due dates → `current`

Exits `0` on success, `1` on any failure.

---

## Project Layout

```
seed-data.json              loan portfolio and payment history
api/
  server.js                 Fastify entry point (port 3001)
  smoke-test.js             zero-dependency regression check
  src/
    data.js                 in-memory store + seed loader
    evaluation.js           status, delinquency, and on-time-rate logic
    evaluation.test.js      Vitest unit suite
    routes.js               HTTP route handlers
web/
  src/
    App.jsx                 React UI
    api.js                  fetch wrapper
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

