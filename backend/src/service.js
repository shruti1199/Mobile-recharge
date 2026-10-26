const crypto = require('crypto');
const { pool, tx } = require('./db');
const operator = require('./operator');

const WALLET_ID = 1;
const TERMINAL = ['SUCCESS', 'FAILED', 'REFUNDED'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const hashRequest = (b) =>
  crypto.createHash('sha256').update(`${b.number}|${b.operator}|${b.amount}`).digest('hex');

// Every status change goes through here so order_events is a complete audit trail.
async function setStatus(c, order, to, source, reason = null) {
  await c.query('UPDATE orders SET status=?, failure_reason=COALESCE(?, failure_reason) WHERE id=?', [to, reason, order.id]);
  await c.query('INSERT INTO order_events (order_id, from_status, to_status, source) VALUES (?,?,?,?)', [order.id, order.status, to, source]);
  order.status = to;
}

// 1) Idempotent create: debit wallet + ledger + order(INITIATED) in ONE transaction, then call operator.
async function createRecharge({ number, operator: op, amount, idempotencyKey }) {
  const requestHash = hashRequest({ number, operator: op, amount });

  const { order, created } = await tx(async (c) => {
    // Locking the wallet row serialises concurrent requests -> idempotency check below is race-free.
    const [[w]] = await c.query('SELECT balance FROM wallets WHERE id=? FOR UPDATE', [WALLET_ID]);
    const [existing] = await c.query('SELECT * FROM orders WHERE wallet_id=? AND idempotency_key=?', [WALLET_ID, idempotencyKey]);
    if (existing.length) {
      if (existing[0].request_hash !== requestHash) throw new HttpError(422, 'Idempotency-Key reused with a different request');
      return { order: existing[0], created: false };
    }
    if (w.balance < amount) throw new HttpError(402, 'Insufficient wallet balance');

    const id = crypto.randomUUID();
    await c.query(
      `INSERT INTO orders (id, wallet_id, idempotency_key, request_hash, number, operator, amount, status)
       VALUES (?,?,?,?,?,?,?, 'INITIATED')`,
      [id, WALLET_ID, idempotencyKey, requestHash, number, op, amount]
    );
    const newBalance = w.balance - amount;
    await c.query('UPDATE wallets SET balance=? WHERE id=?', [newBalance, WALLET_ID]);
    await c.query(
      "INSERT INTO ledger (wallet_id, order_id, entry_type, amount, balance_after) VALUES (?,?, 'DEBIT', ?, ?)",
      [WALLET_ID, id, -amount, newBalance]
    );
    await c.query("INSERT INTO order_events (order_id, from_status, to_status, source) VALUES (?, NULL, 'INITIATED', 'api')", [id]);
    const [[row]] = await c.query('SELECT * FROM orders WHERE id=?', [id]);
    return { order: row, created: true };
  });

  if (created) await dispatch(order);
  return { order: await getOrder(order.id), created };
}

// 2) Call the operator (outside any DB transaction - never hold locks over a network call).
async function dispatch(order) {
  const outcome = await operator.submit(order);
  if (outcome === 'REJECTED') return settle(order.id, 'FAILED', 'operator-reject', 'Operator rejected the request');
  // ACCEPTED or UNKNOWN (timeout etc.) -> PENDING. A timeout is NOT a failure: the operator may still
  // process it, so we never refund here. The webhook or reconciler decides the outcome.
  return markPending(order.id, 'api');
}

async function markPending(orderId, source) {
  return tx(async (c) => {
    const [[o]] = await c.query('SELECT * FROM orders WHERE id=? FOR UPDATE', [orderId]);
    if (o && o.status === 'INITIATED') { await setStatus(c, o, 'PENDING', source); return 'pending'; }
    return 'noop';
  });
}

// 3) THE single place where an order becomes SUCCESS or FAILED->REFUNDED.
// Used by webhook, reconciler and reject path, so duplicates / late / out-of-order events all behave the same.
async function settle(orderId, outcome, source, reason = null) {
  return tx(async (c) => {
    const [[o]] = await c.query('SELECT * FROM orders WHERE id=? FOR UPDATE', [orderId]);
    if (!o) return 'unknown_order';

    if (TERMINAL.includes(o.status)) {
      // Duplicate (same outcome) is silently ignored. A *contradicting* late event is flagged for humans.
      const contradicts = (outcome === 'SUCCESS') !== (o.status === 'SUCCESS');
      if (contradicts) {
        await c.query('UPDATE orders SET anomaly=? WHERE id=?', [`Late ${outcome} from ${source} after order was ${o.status}`, o.id]);
        return 'conflict';
      }
      return 'duplicate';
    }

    if (outcome === 'SUCCESS') {
      await setStatus(c, o, 'SUCCESS', source);
      return 'success';
    }

    // FAILED -> REFUNDED in the same transaction. Exactly-once is enforced by the order row lock
    // AND by UNIQUE(order_id, entry_type) on the ledger.
    await setStatus(c, o, 'FAILED', source, reason);
    const [[w]] = await c.query('SELECT balance FROM wallets WHERE id=? FOR UPDATE', [o.wallet_id]);
    const newBalance = w.balance + o.amount;
    await c.query(
      "INSERT INTO ledger (wallet_id, order_id, entry_type, amount, balance_after) VALUES (?,?, 'REFUND', ?, ?)",
      [o.wallet_id, o.id, o.amount, newBalance]
    );
    await c.query('UPDATE wallets SET balance=? WHERE id=?', [newBalance, o.wallet_id]);
    await setStatus(c, o, 'REFUNDED', source);
    return 'refunded';
  });
}

async function handleWebhook({ reference, status, eventId }) {
  let result;
  if (status === 'PENDING') result = await markPending(reference, 'webhook'); // harmless / possibly stale
  else result = await settle(reference, status, 'webhook', status === 'FAILED' ? 'Operator reported failure' : null);
  await pool.query('INSERT INTO webhook_events (event_id, reference, status, result) VALUES (?,?,?,?)', [eventId || null, reference, status, result]);
  return result;
}

// 4) Reconciliation: resolve orders stuck in INITIATED/PENDING using the operator's status-check call.
async function reconcile(olderThanSec = Number(process.env.RECON_AFTER_SEC || 30)) {
  const [rows] = await pool.query(
    "SELECT id FROM orders WHERE status IN ('INITIATED','PENDING') AND created_at <= NOW(3) - INTERVAL ? SECOND",
    [olderThanSec]
  );
  const report = [];
  for (const { id } of rows) {
    const r = await operator.status(id);
    let result = 'still_pending';
    if (r.status === 'SUCCESS') result = await settle(id, 'SUCCESS', 'reconcile');
    else if (r.status === 'FAILED') result = await settle(id, 'FAILED', 'reconcile', 'Operator status check: failed');
    else if (r.status === 'NOT_FOUND') result = await settle(id, 'FAILED', 'reconcile', 'Operator has no record of this order');
    report.push({ id, operatorStatus: r.status, result });
  }
  return report;
}

async function getOrder(id) {
  const [[o]] = await pool.query('SELECT * FROM orders WHERE id=?', [id]);
  return o || null;
}

async function getWallet() {
  const [[w]] = await pool.query('SELECT balance FROM wallets WHERE id=?', [WALLET_ID]);
  const [[s]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM ledger WHERE wallet_id=?', [WALLET_ID]);
  const [ledger] = await pool.query('SELECT * FROM ledger WHERE wallet_id=? ORDER BY id DESC LIMIT 20', [WALLET_ID]);
  return { balance: Number(w.balance), ledgerSum: Number(s.total), reconciled: Number(w.balance) === Number(s.total), ledger };
}

async function topup(amount) {
  return tx(async (c) => {
    const [[w]] = await c.query('SELECT balance FROM wallets WHERE id=? FOR UPDATE', [WALLET_ID]);
    const nb = w.balance + amount;
    await c.query('UPDATE wallets SET balance=? WHERE id=?', [nb, WALLET_ID]);
    await c.query("INSERT INTO ledger (wallet_id, order_id, entry_type, amount, balance_after) VALUES (?, NULL, 'TOPUP', ?, ?)", [WALLET_ID, amount, nb]);
    return nb;
  });
}

module.exports = { HttpError, createRecharge, handleWebhook, reconcile, settle, getOrder, getWallet, topup, WALLET_ID };
