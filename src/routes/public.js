import { Router } from 'express';
import { pool, tx } from '../db.js';
import { h, flash } from '../lib/web.js';
import { setConsent } from '../services/guests.js';
import { cardSummary } from '../services/loyalty.js';
import { getSettingSync } from '../services/settings.js';

const r = Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

r.get('/', h(async (req, res) => {
  if (req.guest) return res.redirect('/account');
  const program = (await pool.query('SELECT * FROM loyalty_programs WHERE active LIMIT 1')).rows[0];
  const tiers = program ? (await pool.query('SELECT * FROM tiers WHERE program_id = $1 ORDER BY sort_order', [program.id])).rows : [];
  const rewards = (await pool.query(`SELECT * FROM rewards WHERE active AND points_cost IS NOT NULL ORDER BY points_cost LIMIT 4`)).rows;
  res.render('guest/landing', { title: 'نادي ضيوف منزال', program, tiers, rewards });
}));

// رابط الإحالة: يحفظ الكود في ملف تعريف ارتباط ثم يوجه للتسجيل
r.get('/r/:code', h(async (req, res) => {
  const code = String(req.params.code).toUpperCase().slice(0, 16);
  const referrer = (await pool.query(`SELECT split_part(full_name,' ',1) AS first FROM guests WHERE referral_code = $1 AND status='active'`, [code])).rows[0];
  if (referrer) res.cookie('mz_ref', code, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400000 });
  res.render('guest/referral-landing', { title: 'دعوة من صديق', referrer, code });
}));

// بطاقة الولاء العامة للمشاركة: لا تعرض أي بيانات تواصل
r.get('/card/:token', h(async (req, res) => {
  const g = (await pool.query('SELECT id FROM guests WHERE card_token = $1', [req.params.token])).rows[0];
  if (!g) return res.status(404).render('error', { title: 'غير موجود', status: 404, message: 'البطاقة غير موجودة' });
  const s = await cardSummary(g.id);
  res.render('guest/card-public', { title: 'بطاقة ولاء منزال', s, firstName: s.guest.full_name.split(' ')[0] });
}));

// تتبع فتح البريد
r.get('/t/:token.gif', h(async (req, res) => {
  await pool.query('UPDATE notifications SET opened_at = COALESCE(opened_at, now()) WHERE tracking_token = $1', [req.params.token]);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
}));

// تتبع النقر + إسناد الحملة
r.get('/t/:token', h(async (req, res) => {
  const n = (await pool.query(
    `UPDATE notifications SET clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now())
      WHERE tracking_token = $1 RETURNING link, campaign_id`, [req.params.token],
  )).rows[0];
  if (n?.campaign_id) {
    const days = Number(getSettingSync('campaign_attribution_days', 30));
    res.cookie('mz_cmp', String(n.campaign_id), { httpOnly: true, sameSite: 'lax', maxAge: days * 86400000 });
  }
  const dest = n?.link && n.link.startsWith('/') && !n.link.startsWith('//') ? n.link : '/account';
  res.redirect(dest);
}));

// إلغاء الاشتراك بنقرة واحدة (بدون تسجيل دخول)
r.get('/unsubscribe/:token', h(async (req, res) => {
  const g = (await pool.query('SELECT id, consent_email_marketing, consent_whatsapp_marketing FROM guests WHERE unsubscribe_token = $1', [req.params.token])).rows[0];
  if (!g) return res.status(404).render('error', { title: 'رابط غير صالح', status: 404, message: 'رابط إلغاء الاشتراك غير صالح.' });
  res.render('guest/unsubscribe', { title: 'إلغاء الاشتراك', token: req.params.token, done: false });
}));
async function unsubscribe(token) {
  const g = (await pool.query('SELECT id FROM guests WHERE unsubscribe_token = $1', [token])).rows[0];
  if (!g) return false;
  await tx(async (c) => {
    await setConsent(c, g.id, 'email_marketing', false, 'unsubscribe_link');
    await setConsent(c, g.id, 'whatsapp_marketing', false, 'unsubscribe_link');
    await c.query(`UPDATE notifications SET status = 'skipped', skip_reason = 'ألغى الضيف الاشتراك' WHERE guest_id = $1 AND status = 'queued' AND category = 'marketing'`, [g.id]);
  });
  return true;
}
r.post('/unsubscribe/:token', h(async (req, res) => {
  if (!(await unsubscribe(req.params.token))) return res.status(404).send('invalid');
  res.render('guest/unsubscribe', { title: 'إلغاء الاشتراك', token: req.params.token, done: true });
}));

// تصفح الوحدات
r.get('/units', h(async (req, res) => {
  const city = req.query.city || null;
  const units = (await pool.query(`SELECT * FROM units WHERE active AND ($1::text IS NULL OR city = $1) ORDER BY city, nightly_price`, [city])).rows;
  const cities = (await pool.query('SELECT DISTINCT city FROM units WHERE active ORDER BY city')).rows.map((x) => x.city);
  res.render('guest/units', { title: 'الوحدات', units, cities, city });
}));

r.get('/healthz', (req, res) => res.json({ ok: true }));
export default r;
