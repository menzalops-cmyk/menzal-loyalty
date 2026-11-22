import { migrate } from '../scripts/migrate.js';
import { seedBase } from '../scripts/seed.js';
import { pool, tx } from '../src/db.js';
import { loadSettings } from '../src/services/settings.js';
import { signup } from '../src/services/guests.js';

export async function resetDb() {
  await migrate({ reset: true, quiet: true });
  await tx((c) => seedBase(c, { adminEmail: 'admin@test.local', adminPassword: 'Admin@12345' }));
  await loadSettings();
}

let n = 0;
export async function makeGuest(overrides = {}) {
  n++;
  const g = await tx((c) => signup(c, {
    fullName: overrides.fullName || `ضيف تجريبي ${n}`,
    email: overrides.email || `guest${n}_${Date.now()}@test.local`,
    phone: overrides.phone || `05${String(10000000 + Math.floor(Math.random() * 89999999)).slice(0, 8)}`,
    referralCode: overrides.referralCode,
    consents: overrides.consents || { email_marketing: true },
  }));
  if (overrides.verified !== false) await pool.query('UPDATE guests SET email_verified_at = now(), phone_verified_at = now() WHERE id = $1', [g.id]);
  return (await pool.query('SELECT * FROM guests WHERE id = $1', [g.id])).rows[0];
}

export const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
export const guest = async (id) => (await pool.query('SELECT * FROM guests WHERE id = $1', [id])).rows[0];
export const unitId = async (i = 0) => (await pool.query('SELECT id FROM units ORDER BY id OFFSET $1 LIMIT 1', [i])).rows[0].id;
export { pool, tx };
