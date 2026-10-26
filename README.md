# Reliable Recharge Service

A small wallet-based mobile recharge service (Node.js + Express, MySQL, React) that stays correct when the
operator API times out, answers late, or sends duplicate / late / out-of-order callbacks.

```
React (Vite :5173) --/api--> Express API (:3000) --HTTP--> Mock operator (:4000)
                                  |   ^                          |
                                  v   +------ webhooks ----------+
                                MySQL (wallets, orders, ledger, order_events, webhook_events)
```

## Run it

Prerequisites: Node.js 18+ (uses built-in `fetch`), MySQL 8 (or MariaDB 10.5+) running locally.

```bash
# 1) Backend
cd backend
cp .env.example .env          # edit DB_USER / DB_PASSWORD if needed
npm install
npm run migrate               # creates DB + tables, seeds wallet with Rs 1000
npm start                     # API on :3000 (also starts the reconciliation job)

# 2) Mock operator  (new terminal)
cd mock-operator
npm install
npm start                     # :4000

# 3) Frontend  (new terminal)
cd frontend
npm install
npm run dev                   # open http://localhost:5173
```

Tests (need MySQL; they use a separate `recharge_test` database and a deterministic fake operator):

```bash
cd backend && npm test
```

Using the real mock API from the assignment instead of the bundled one: set `OPERATOR_BASE_URL` in `backend/.env`.
The client in `backend/src/operator.js` expects `POST /recharge` and `GET /status/:reference`; adapt the two
small functions there if the paths/fields differ.

## Deploy online (single service, no PC needed)

The root `package.json` builds the React app and serves it from the Express server, and runs the mock operator
inside the same process (`START_MOCK=true`), so you only need one web service plus one MySQL database.

1. Create a free MySQL database (Aiven, TiDB Cloud Starter, or similar) and note host, port, user, password, db name.
2. Push this repo to GitHub, then create a **Web Service** on Render from it:
   - Build command: `npm run build`
   - Start command: `npm start`
3. Environment variables: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`,
   `WEBHOOK_SECRET` (any string), `NODE_VERSION=20`.
4. Open the Render URL. Tables are created automatically on first start.

Note: free instances sleep when idle and the bundled mock keeps its state in memory, so a restart makes the mock
forget in-flight orders (the reconciler then sees NOT_FOUND and refunds them, which is safe).

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/recharges` | Body `{number, operator, amount}` + header `Idempotency-Key`. 201 new, 200 replay (`Idempotent-Replay: true`), 402 insufficient balance, 422 key reused with different payload |
| GET | `/api/recharges`, `/api/recharges/:id` | History; single order with its status timeline |
| POST | `/api/webhooks/operator` | Operator callback `{reference, status: SUCCESS\|FAILED\|PENDING, eventId}` (header `x-webhook-secret`) |
| POST | `/api/admin/reconcile?olderThanSec=N` | Run the reconciliation pass on demand |
| GET | `/api/wallet` | Balance, ledger sum, `reconciled` flag, latest ledger rows |
| POST | `/api/wallet/topup` | Demo top-up |

## Design decisions

**State machine.** `INITIATED -> PENDING -> SUCCESS | FAILED -> REFUNDED`. Every transition is written to `order_events`
(from, to, source), so each order has an audit trail. `FAILED -> REFUNDED` happens in one DB transaction.

**One settlement function.** The webhook, the reconciler and the "operator rejected" path all call `settle()`.
It locks the order row (`SELECT ... FOR UPDATE`), and if the order is already terminal it does nothing.
So duplicate, late and out-of-order events all have exactly the same, safe behaviour, regardless of who delivers them.

**Idempotency.** `UNIQUE(wallet_id, idempotency_key)` on `orders`, and the check runs after taking the wallet row lock,
so two concurrent identical requests cannot both debit. Same key + same payload returns the original order;
same key + different payload returns 422 (request hash comparison). The UI keeps the same key until the form is edited.

**Money correctness.**
- Debit, ledger row and order creation are one transaction.
- Ledger is append-only, with signed amounts. `UNIQUE(order_id, entry_type)` makes a second DEBIT or second REFUND for
  the same order impossible even if application logic had a bug.
- `wallets.balance` is a cached running total with `CHECK (balance >= 0)`; `GET /api/wallet` compares it with `SUM(ledger)`
  and the UI shows "Ledger reconciled". Tests assert this invariant after every scenario.
- Amounts are integers (rupees) so there are no floating point errors.

**Timeouts are not failures.** If the operator call times out or returns 5xx, we do not know whether it was processed,
so the order goes to PENDING and is never refunded at that point. Only a definite signal refunds: failure webhook,
status check = FAILED, a 4xx rejection, or the operator reporting it has no record (NOT_FOUND) after the stuck threshold.
We send our order id as the operator `reference`, so the operator can de-duplicate on its side too.

**No locks over network calls.** The operator is called outside any DB transaction.

**Reconciliation.** A timer (every `RECON_INTERVAL_SEC`) plus `POST /api/admin/reconcile` finds orders in
INITIATED/PENDING older than `RECON_AFTER_SEC` and asks the operator for status. Including INITIATED also recovers from a
crash between "debit committed" and "operator called". It is safe to run concurrently or repeatedly because it uses `settle()`.

**Late contradicting events.** If the order was refunded and a SUCCESS arrives later (or vice-versa), money is *not* moved
automatically; the order gets an `anomaly` note shown in the UI for manual review, since that means the operator and our
books disagree and a human should decide.

**Webhook handling.** Always answers 200 for a well-formed payload (duplicates are normal; we don't want retries storms),
verifies a shared secret header, logs each callback in `webhook_events`. Correctness does not depend on `eventId`
de-duplication; the state machine is the guard, which also protects against callbacks with missing/changing event ids.

## Trade-offs

- Single wallet / single user (id 1), no authentication, to keep scope within the time box.
- Live status uses 2s polling, not WebSockets/SSE: simpler and robust, slightly less instant.
- Wallet row lock serialises all debits; fine for this scale, per-user wallets would remove the global contention
  (each user would only block themselves).
- `POST /recharges` waits up to the operator timeout (3s) before replying. Alternative: reply immediately with INITIATED
  and dispatch from a queue.
- Operator call happens in the request handler. If the process dies right after the debit, the reconciler recovers it,
  but only after the threshold.
- Tests hit a real MySQL (slower, but they test the real locking and unique constraints, which mocks cannot).

## What I would do with more time

- Transactional outbox + worker to call the operator (retries with backoff, no work in the request path).
- Auth, per-user wallets, wallet top-ups through a payment gateway; paise-based money type and multi-currency.
- Webhook HMAC signatures with timestamp (replay protection) instead of a static secret.
- Operator-side status "NOT_FOUND" grace period tuning, alerting on stuck orders and on `anomaly` rows, metrics
  (order latency, % pending, refund rate), structured logs with correlation ids.
- Idempotency-key expiry/cleanup, rate limiting, pagination on history, DB migrations tool (Knex/Prisma).
- Circuit breaker for the operator; per-operator timeouts.
- Concurrency/chaos tests against the real mock operator, and frontend tests.
