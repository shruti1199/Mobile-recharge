const path = require('path');
const fs = require('fs');
const express = require('express');
const { pool } = require('./db');
const svc = require('./service');

const OPERATORS = ['AIRTEL', 'JIO', 'VI', 'BSNL'];
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function createApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/recharges', wrap(async (req, res) => {
    const key = req.get('Idempotency-Key') || (req.body && req.body.idempotencyKey);
    const { number, operator, amount } = req.body || {};
    if (!key || String(key).length > 100) throw new svc.HttpError(400, 'Idempotency-Key is required');
    if (!/^[6-9]\d{9}$/.test(String(number))) throw new svc.HttpError(400, 'number must be a 10 digit mobile number');
    if (!OPERATORS.includes(operator)) throw new svc.HttpError(400, `operator must be one of ${OPERATORS.join(', ')}`);
    if (!Number.isInteger(amount) || amount < 10 || amount > 1000) throw new svc.HttpError(400, 'amount must be an integer between 10 and 1000');

    const { order, created } = await svc.createRecharge({ number: String(number), operator, amount, idempotencyKey: String(key) });
    if (!created) res.set('Idempotent-Replay', 'true');
    res.status(created ? 201 : 200).json(order);
  }));

  app.get('/api/recharges', wrap(async (req, res) => {
    const [rows] = await pool.query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 50');
    res.json(rows);
  }));

  app.get('/api/recharges/:id', wrap(async (req, res) => {
    const order = await svc.getOrder(req.params.id);
    if (!order) throw new svc.HttpError(404, 'Order not found');
    const [events] = await pool.query('SELECT from_status, to_status, source, created_at FROM order_events WHERE order_id=? ORDER BY id', [order.id]);
    res.json({ ...order, events });
  }));

  // Operator callback. Always 200 for a well-formed payload (duplicates are expected, don't make operator retry).
  app.post('/api/webhooks/operator', wrap(async (req, res) => {
    const secret = process.env.WEBHOOK_SECRET;
    if (secret && req.get('x-webhook-secret') !== secret) throw new svc.HttpError(401, 'Invalid webhook secret');
    const { reference, status, eventId } = req.body || {};
    if (!reference || !['SUCCESS', 'FAILED', 'PENDING'].includes(status)) throw new svc.HttpError(400, 'Invalid payload');
    const result = await svc.handleWebhook({ reference, status, eventId });
    res.json({ ok: true, result });
  }));

  app.get('/api/wallet', wrap(async (req, res) => res.json(await svc.getWallet())));

  app.post('/api/wallet/topup', wrap(async (req, res) => {
    const amount = req.body && req.body.amount;
    if (!Number.isInteger(amount) || amount <= 0 || amount > 10000) throw new svc.HttpError(400, 'amount must be an integer 1-10000');
    res.json({ balance: await svc.topup(amount) });
  }));

  // Manual trigger for the reconciliation job (also runs on a timer, see server.js)
  app.post('/api/admin/reconcile', wrap(async (req, res) => {
    const secs = req.query.olderThanSec !== undefined ? Number(req.query.olderThanSec) : undefined;
    res.json(await svc.reconcile(secs));
  }));

  // Production: serve the built React app from the same server (one deployable service)
  const dist = path.join(__dirname, '../../frontend/dist');
  if (fs.existsSync(dist)) app.use(express.static(dist));

  app.use((err, req, res, next) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
