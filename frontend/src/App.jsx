import { useCallback, useEffect, useState } from 'react';

const OPERATORS = ['AIRTEL', 'JIO', 'VI', 'BSNL'];
const newKey = () => crypto.randomUUID();

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export default function App() {
  const [wallet, setWallet] = useState(null);
  const [orders, setOrders] = useState([]);
  const [form, setForm] = useState({ number: '', operator: 'JIO', amount: 100 });
  // The idempotency key stays the same while the form is unchanged, so a retry/double click
  // after a network error can never create a second order. Editing the form = new intent = new key.
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [w, o] = await Promise.all([api('/wallet'), api('/recharges')]);
      setWallet(w);
      setOrders(o);
    } catch { /* keep last known state; next poll will retry */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000); // live status via polling
    return () => clearInterval(t);
  }, [refresh]);

  const update = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: field === 'amount' ? Number(e.target.value) : e.target.value }));
    setKey(newKey());
  };

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const order = await api('/recharges', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(form),
      });
      setMsg({ ok: true, text: `Order ${order.id.slice(0, 8)} is ${order.status}` });
      setKey(newKey());
      refresh();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const action = async (fn) => { try { await fn(); } catch (e) { setMsg({ ok: false, text: e.message }); } refresh(); };
  const topup = () => action(() => api('/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 500 }) }));
  const reconcile = () => action(async () => {
    const r = await api('/admin/reconcile?olderThanSec=10', { method: 'POST' });
    setMsg({ ok: true, text: `Reconciler checked ${r.length} stuck order(s)` });
  });

  return (
    <div className="wrap">
      <h1>Mobile Recharge</h1>

      <section className="card">
        <div className="row">
          <div>
            <small>Wallet balance</small>
            <div className="balance">₹{wallet ? wallet.balance : '…'}</div>
          </div>
          {wallet && (
            <span className={`badge ${wallet.reconciled ? 'SUCCESS' : 'FAILED'}`}>
              {wallet.reconciled ? 'Ledger reconciled' : 'LEDGER MISMATCH'}
            </span>
          )}
        </div>
        <div className="row gap">
          <button className="ghost" onClick={topup}>+ ₹500 (demo)</button>
          <button className="ghost" onClick={reconcile}>Run reconciliation</button>
        </div>
      </section>

      <form className="card" onSubmit={submit}>
        <label>Mobile number
          <input value={form.number} onChange={update('number')} inputMode="numeric" maxLength={10} placeholder="9876543210" required />
        </label>
        <label>Operator
          <select value={form.operator} onChange={update('operator')}>
            {OPERATORS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <label>Amount (₹10 – ₹1000)
          <input type="number" min="10" max="1000" value={form.amount} onChange={update('amount')} required />
        </label>
        <button disabled={busy}>{busy ? 'Processing…' : 'Recharge'}</button>
        {msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
      </form>

      <section className="card">
        <h2>Order history</h2>
        {orders.length === 0 && <p className="muted">No orders yet.</p>}
        {orders.map((o) => (
          <div className="order" key={o.id}>
            <div className="row">
              <strong>{o.number} · {o.operator}</strong>
              <span className={`badge ${o.status}`}>{o.status}</span>
            </div>
            <div className="row muted">
              <span>₹{o.amount} · {new Date(o.created_at).toLocaleTimeString()}</span>
              <span>{o.id.slice(0, 8)}</span>
            </div>
            {o.failure_reason && <div className="muted">{o.failure_reason}</div>}
            {o.anomaly && <div className="err">⚠ {o.anomaly}</div>}
          </div>
        ))}
      </section>

      {wallet && (
        <section className="card">
          <h2>Ledger (latest 20)</h2>
          {wallet.ledger.map((l) => (
            <div className="row muted" key={l.id}>
              <span>{l.entry_type}{l.order_id ? ` · ${l.order_id.slice(0, 8)}` : ''}</span>
              <span className={l.amount < 0 ? 'err' : 'ok'}>{l.amount > 0 ? '+' : ''}{l.amount} → ₹{l.balance_after}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
