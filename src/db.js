import pg from 'pg';
import { config } from './config.js';

// إرجاع numeric و bigint كأرقام JavaScript (القيم المالية ضمن نطاق آمن)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v); // date كنص YYYY-MM-DD

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

export async function one(text, params, client = pool) {
  const { rows } = await client.query(text, params);
  return rows[0] || null;
}

export async function many(text, params, client = pool) {
  const { rows } = await client.query(text, params);
  return rows;
}

/** تنفيذ دالة داخل معاملة واحدة؛ تُلغى كاملة عند أي خطأ */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
