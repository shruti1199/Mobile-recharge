// Thin client for the (unreliable) operator API.
// Outcomes are deliberately coarse: ACCEPTED | REJECTED (definite 4xx) | UNKNOWN (timeout / 5xx / network).
const baseUrl = () => process.env.OPERATOR_BASE_URL || 'http://localhost:4000';
const timeout = () => AbortSignal.timeout(Number(process.env.OPERATOR_TIMEOUT_MS || 3000));

async function submit(order) {
  try {
    const res = await fetch(`${baseUrl()}/recharge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: order.id, // our order id doubles as the operator-side idempotency reference
        number: order.number,
        operator: order.operator,
        amount: order.amount,
        callbackUrl: `${process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/api/webhooks/operator`,
      }),
      signal: timeout(),
    });
    if (res.status >= 200 && res.status < 300) return 'ACCEPTED';
    if (res.status >= 400 && res.status < 500) return 'REJECTED';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN'; // we do NOT know whether the operator processed it
  }
}

// -> { status: 'PENDING'|'SUCCESS'|'FAILED'|'NOT_FOUND'|'UNKNOWN' }
async function status(reference) {
  try {
    const res = await fetch(`${baseUrl()}/status/${reference}`, { signal: timeout() });
    if (res.status === 404) return { status: 'NOT_FOUND' };
    if (!res.ok) return { status: 'UNKNOWN' };
    return await res.json();
  } catch {
    return { status: 'UNKNOWN' };
  }
}

module.exports = { submit, status };
