// Deliberately unreliable operator. Behaviour per POST /recharge:
//   10%  -> 503, request NOT processed
//   20%  -> processed, but responds after 8s (client times out and doesn't know the result)
//   rest -> processed, 202 immediately
// For processed orders the final result (60% SUCCESS / 40% FAILED) is ready after 1-8s, and the callback:
//   15% never sent (reconciler needed) | 30% duplicated | 15% repeated very late (20-40s) | 20% followed by a stale PENDING
// GET /status/:reference -> PENDING | SUCCESS | FAILED, 404 if never received, and 10% random 500s.
const express = require('express');
const app = express();
app.use(express.json());

const SECRET = process.env.WEBHOOK_SECRET || 'dev-secret';
const orders = new Map(); // reference -> { finalStatus, readyAt }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function callback(url, reference, status) {
  const body = JSON.stringify({ eventId: `${reference}-${Math.random().toString(36).slice(2, 8)}`, reference, status });
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET }, body })
    .then(() => log('callback', status, reference.slice(0, 8)))
    .catch((e) => log('callback failed', e.message));
}

app.post('/recharge', async (req, res) => {
  const { reference, callbackUrl } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference required' });
  const r = Math.random();
  if (r < 0.1) { log('503', reference.slice(0, 8)); return res.status(503).json({ error: 'operator unavailable' }); }

  if (!orders.has(reference)) { // idempotent on reference
    const delay = rnd(1000, 8000);
    const finalStatus = Math.random() < 0.6 ? 'SUCCESS' : 'FAILED';
    orders.set(reference, { finalStatus, readyAt: Date.now() + delay });
    log('accepted', reference.slice(0, 8), '->', finalStatus, `in ${Math.round(delay)}ms`);
    if (callbackUrl && Math.random() >= 0.15) {
      setTimeout(() => {
        callback(callbackUrl, reference, finalStatus);
        if (Math.random() < 0.3) setTimeout(() => callback(callbackUrl, reference, finalStatus), rnd(300, 3000));
        if (Math.random() < 0.15) setTimeout(() => callback(callbackUrl, reference, finalStatus), rnd(20000, 40000));
        if (Math.random() < 0.2) setTimeout(() => callback(callbackUrl, reference, 'PENDING'), rnd(500, 2000));
      }, delay);
    }
  }
  if (r < 0.3) await sleep(8000);
  res.status(202).json({ reference, status: 'PENDING' });
});

app.get('/status/:reference', (req, res) => {
  const o = orders.get(req.params.reference);
  if (!o) return res.status(404).json({ status: 'NOT_FOUND' });
  if (Math.random() < 0.1) return res.status(500).json({ error: 'random failure' });
  res.json({ status: Date.now() < o.readyAt ? 'PENDING' : o.finalStatus });
});

const MOCK_PORT = Number(process.env.MOCK_PORT || 4000);
app.listen(MOCK_PORT, () => log(`Mock operator on http://localhost:${MOCK_PORT}`));
