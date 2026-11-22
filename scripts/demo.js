// بيانات تجريبية لاستكشاف النظام فقط (npm run seed -- --demo). لا تُستخدم في الإنتاج.
// تمر كل العمليات عبر نفس خدمات النظام الحقيقية (تسجيل، حجوزات، اكتمال، استبدال، إحالة).
import { tx, pool } from '../src/db.js';
import { signup } from '../src/services/guests.js';
import { recordBooking } from '../src/services/bookings.js';
import { redeemPoints } from '../src/services/rewards.js';
import { loadSettings } from '../src/services/settings.js';

const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

export async function seedDemo() {
  await loadSettings();
  if ((await pool.query(`SELECT 1 FROM guests WHERE email = 'demo.guest@menzal.local'`)).rowCount) return;
  const units = (await pool.query('SELECT id FROM units ORDER BY id')).rows.map((u) => u.id);
  const people = [
    ['ضيف تجريبي', 'demo.guest@menzal.local', 'الدمام', [[0, -200, 2], [3, -90, 3], [1, -20, 2]]],
    ['ريم الشهري', 'reem.demo@menzal.local', 'الخبر', [[5, -400, 2]]],
    ['فهد القحطاني', 'fahad.demo@menzal.local', 'القصيم', [[2, -60, 1], [2, -300, 2], [0, -150, 2], [4, -35, 3]]],
    ['منى الزهراني', 'mona.demo@menzal.local', 'الطائف', []],
  ];
  const ids = {};
  for (const [name, email, city, stays] of people) {
    const g = await tx((c) => signup(c, { fullName: name, email, password: 'Demo@12345', homeCity: city, consents: { email_marketing: true } }));
    await pool.query('UPDATE guests SET email_verified_at = now() WHERE id = $1', [g.id]);
    ids[email] = g;
    for (const [ui, offset, nights] of stays.sort((a, b) => a[1] - b[1])) {
      await tx((c) => recordBooking(c, { contactName: name, contactEmail: email, unitId: units[ui], checkIn: day(offset - nights), checkOut: day(offset), status: 'completed' }, { actor: 'demo' }));
    }
  }
  // صديق أحاله الضيف التجريبي وأكمل إقامته
  const friend = await tx((c) => signup(c, { fullName: 'عبدالله الدوسري', email: 'abdullah.demo@menzal.local', password: 'Demo@12345', referralCode: ids['demo.guest@menzal.local'].referral_code }));
  await pool.query('UPDATE guests SET email_verified_at = now() WHERE id = $1', [friend.id]);
  await tx((c) => recordBooking(c, { contactName: 'عبدالله', contactEmail: 'abdullah.demo@menzal.local', unitId: units[1], checkIn: day(-12), checkOut: day(-10), status: 'completed' }, { actor: 'demo' }));
  // استبدال لدى فهد
  const r = (await pool.query(`SELECT id FROM rewards WHERE points_cost = 1000 LIMIT 1`)).rows[0];
  if (r) await tx((c) => redeemPoints(c, { guestId: ids['fahad.demo@menzal.local'].id, rewardId: r.id, requestId: 'demo' }));
  // حجز سابق بدون حساب (يُربط عند تسجيل صاحبه)
  await tx((c) => recordBooking(c, { contactName: 'سلمان', contactEmail: 'salman.demo@menzal.local', unitId: units[4], checkIn: day(-50), checkOut: day(-47), status: 'completed' }, { actor: 'demo' }));
}
