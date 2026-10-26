// Needs a running MySQL (same credentials as .env). Uses a separate DB: recharge_test.
process.env.DB_NAME = 'recharge_test';
process.env.WEBHOOK_SECRET = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const request = require('supertest');
const { migrate } = require('../src/migrate');
const { pool } = require('../src/db');
const { createApp } = require('../src/app');
const svc = require('../src/service');

let stub, app, stubStatus = 'PENDING';

before(async () => {
  // Deterministic fake operator: always accepts; status-check answer is controlled by the test.
  stub = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') { res.statusCode = 202; return res.end('{"status":"PENDING"}'); }
    res.end(JSON.stringify({ status: stubStatus }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.OPERATOR_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
  app = createApp();
});

after(async () => { await pool.end(); stub.close(); });
beforeEach(async () => { stubStatus = 'PENDING'; await migrate({ reset: true }); });

const payload = { number: '9876543210', operator: 'JIO', amount: 100 };
const create = (key, body = payload) => request(app).post('/api/recharges').set('Idempotency-Key', key).send(body);
const hook = (reference, status) =>
  request(app).post('/api/webhooks/operator').set('x-webhook-secret', 'test').send({ reference, status, eventId: Math.random().toString() });

async function count(type, orderId) {
  const [[r]] = await pool.query('SELECT COUNT(*) n FROM ledger WHERE order_id=? AND entry_type=?', [orderId, type]);
  return r.n;
}
// Invariant checked in every test: wallet balance == sum of ledger.
async function balance() {
  const w = await svc.getWallet();
  assert.equal(w.balance, w.ledgerSum, 'ledger must reconcile with balance');
  return w.balance;
}

test('double submit with same idempotency key debits once', async () => {
  const [a, b] = await Promise.all([create('k1'), create('k1')]);
  assert.equal(a.body.id, b.body.id);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(await balance(), 900);
  assert.equal(await count('DEBIT', a.body.id), 1);
  assert.equal(a.body.status === 'PENDING' || b.body.status === 'PENDING', true);
});

test('same key with a different payload is rejected', async () => {
  await create('k2');
  const r = await create('k2', { ...payload, amount: 200 });
  assert.equal(r.status, 422);
  assert.equal(await balance(), 900);
});

test('insufficient balance is rejected and nothing is debited', async () => {
  assert.equal((await create('a', { ...payload, amount: 600 })).status, 201);
  assert.equal((await create('b', { ...payload, amount: 600 })).status, 402);
  assert.equal(await balance(), 400);
});

test('duplicate / concurrent FAILED webhooks refund exactly once', async () => {
  const { body: order } = await create('k3');
  await Promise.all([hook(order.id, 'FAILED'), hook(order.id, 'FAILED')]);
  await hook(order.id, 'FAILED');
  const o = await svc.getOrder(order.id);
  assert.equal(o.status, 'REFUNDED');
  assert.equal(await count('REFUND', order.id), 1);
  assert.equal(await balance(), 1000);
});

test('late SUCCESS after refund does not change money, but is flagged', async () => {
  const { body: order } = await create('k4');
  await hook(order.id, 'FAILED');
  await hook(order.id, 'SUCCESS');
  const o = await svc.getOrder(order.id);
  assert.equal(o.status, 'REFUNDED');
  assert.match(o.anomaly, /Late SUCCESS/);
  assert.equal(await balance(), 1000);
});

test('stale PENDING callback after SUCCESS is ignored (out of order)', async () => {
  const { body: order } = await create('k5');
  await hook(order.id, 'SUCCESS');
  await hook(order.id, 'PENDING');
  assert.equal((await svc.getOrder(order.id)).status, 'SUCCESS');
  assert.equal(await balance(), 900);
});

test('reconciler resolves a stuck PENDING order via status check (FAILED -> refund)', async () => {
  const { body: order } = await create('k6');
  stubStatus = 'FAILED';
  await svc.reconcile(0);
  await svc.reconcile(0); // running twice must be harmless
  assert.equal((await svc.getOrder(order.id)).status, 'REFUNDED');
  assert.equal(await count('REFUND', order.id), 1);
  assert.equal(await balance(), 1000);
});

test('reconciler marks SUCCESS and leaves still-pending orders alone', async () => {
  const { body: o1 } = await create('k7');
  stubStatus = 'PENDING';
  await svc.reconcile(0);
  assert.equal((await svc.getOrder(o1.id)).status, 'PENDING');
  stubStatus = 'SUCCESS';
  await svc.reconcile(0);
  assert.equal((await svc.getOrder(o1.id)).status, 'SUCCESS');
  assert.equal(await balance(), 900);
});
