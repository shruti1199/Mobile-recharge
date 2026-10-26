const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { base, DB_NAME } = require('./db');

// Creates DB + tables, seeds wallet #1 with Rs 1000 (as a TOPUP ledger entry so books reconcile).
async function migrate({ reset = false } = {}) {
  const c = await mysql.createConnection({ ...base, multipleStatements: true });
  try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``); } catch { /* managed DBs may not allow it; DB already exists */ }
  await c.query(`USE \`${DB_NAME}\``);
  await c.query(fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8'));
  if (reset) {
    await c.query(
      'SET FOREIGN_KEY_CHECKS=0; TRUNCATE order_events; TRUNCATE webhook_events; TRUNCATE ledger; TRUNCATE orders; TRUNCATE wallets; SET FOREIGN_KEY_CHECKS=1;'
    );
  }
  const [w] = await c.query('SELECT id FROM wallets WHERE id=1');
  if (!w.length) {
    await c.query('INSERT INTO wallets (id, balance) VALUES (1, 1000)');
    await c.query(
      "INSERT INTO ledger (wallet_id, order_id, entry_type, amount, balance_after) VALUES (1, NULL, 'TOPUP', 1000, 1000)"
    );
  }
  await c.end();
}

if (require.main === module) {
  migrate()
    .then(() => { console.log('Database ready'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { migrate };
