require('dotenv').config();
const mysql = require('mysql2/promise');

const DB_NAME = process.env.DB_NAME || 'recharge_db';
const base = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  // Managed cloud MySQL (Aiven, TiDB Cloud, ...) needs TLS: set DB_SSL=true
  ...(process.env.DB_SSL === 'true' ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false } } : {}),
};
const pool = mysql.createPool({ ...base, database: DB_NAME, connectionLimit: 10 });

// Run fn inside a transaction (READ COMMITTED + explicit row locks in callers).
async function tx(fn) {
  const c = await pool.getConnection();
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await c.beginTransaction();
    const result = await fn(c);
    await c.commit();
    return result;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, tx, base, DB_NAME };
