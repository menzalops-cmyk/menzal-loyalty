import { pool } from '../db.js';

const DEFAULTS = {
  currency_code: 'SAR',
  currency_symbol: 'ر.س',
  brand_name: 'منزال',
  support_adjust_limit: 500,          // أقصى تعديل نقاط لموظف خدمة الضيوف في العملية الواحدة
  require_checkout_passed: true,      // لا يمكن إكمال الإقامة قبل تاريخ المغادرة
  campaign_attribution_days: 30,
};

let cache = { ...DEFAULTS };

export async function loadSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  cache = { ...DEFAULTS };
  for (const r of rows) cache[r.key] = r.value;
  return cache;
}
export const getSettingSync = (key, fallback) => (cache[key] ?? fallback);
export const allSettings = () => ({ ...cache });

export async function setSetting(key, value, client = pool) {
  await client.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  cache[key] = value;
}
