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
  // ترقية بيانات تجريبية قديمة (قبل اعتماد الجوال كمعرف أساسي): إضافة أرقام للضيوف التجريبيين
  const backfill = [['demo.guest@menzal.local', '966500000001'], ['reem.demo@menzal.local', '966500000002'], ['fahad.demo@menzal.local', '966500000003'], ['mona.demo@menzal.local', '966500000004'], ['abdullah.demo@menzal.local', '966500000005']];
  for (const [email, phone] of backfill) {
    await pool.query(`UPDATE guests SET phone = $2, phone_verified_at = now() WHERE email = $1 AND phone IS NULL
                        AND NOT EXISTS (SELECT 1 FROM guests WHERE phone = $2)`, [email, phone]);
  }
  if ((await pool.query(`SELECT 1 FROM guests WHERE email = 'demo.guest@menzal.local'`)).rowCount) return;
  const units = (await pool.query('SELECT id FROM units ORDER BY id')).rows.map((u) => u.id);
  const people = [
    ['ضيف تجريبي', 'demo.guest@menzal.local', '0500000001', 'الدمام', [[0, -200, 2], [3, -90, 3], [1, -20, 2]]],
    ['ريم الشهري', 'reem.demo@menzal.local', '0500000002', 'الخبر', [[5, -400, 2]]],
    ['فهد القحطاني', 'fahad.demo@menzal.local', '0500000003', 'القصيم', [[2, -60, 1], [2, -300, 2], [0, -150, 2], [4, -35, 3]]],
    ['منى الزهراني', 'mona.demo@menzal.local', '0500000004', 'الطائف', []],
  ];
  const ids = {};
  for (const [name, email, phone, city, stays] of people) {
    const g = await tx((c) => signup(c, { fullName: name, email, phone, homeCity: city, consents: { email_marketing: true, whatsapp: true } }));
    await pool.query('UPDATE guests SET email_verified_at = now(), phone_verified_at = now() WHERE id = $1', [g.id]);
    ids[email] = g;
    for (const [ui, offset, nights] of stays.sort((a, b) => a[1] - b[1])) {
      await tx((c) => recordBooking(c, { contactName: name, contactEmail: email, contactPhone: phone, unitId: units[ui], checkIn: day(offset - nights), checkOut: day(offset), status: 'completed' }, { actor: 'demo' }));
    }
  }
  // صديق أحاله الضيف التجريبي وأكمل إقامته
  const friend = await tx((c) => signup(c, { fullName: 'عبدالله الدوسري', phone: '0500000005', referralCode: ids['demo.guest@menzal.local'].referral_code }));
  await pool.query('UPDATE guests SET phone_verified_at = now() WHERE id = $1', [friend.id]);
  await tx((c) => recordBooking(c, { contactName: 'عبدالله', contactPhone: '0500000005', unitId: units[1], checkIn: day(-12), checkOut: day(-10), status: 'completed' }, { actor: 'demo' }));
  // استبدال لدى فهد
  const r = (await pool.query(`SELECT id FROM rewards WHERE points_cost = 1000 LIMIT 1`)).rows[0];
  if (r) await tx((c) => redeemPoints(c, { guestId: ids['fahad.demo@menzal.local'].id, rewardId: r.id, requestId: 'demo' }));
  // حجز سابق بدون حساب برقم 0500000006 (يُربط تلقائيًا عند تسجيل صاحبه بنفس الرقم)
  await tx((c) => recordBooking(c, { contactName: 'سلمان', contactPhone: '0500000006', unitId: units[4], checkIn: day(-50), checkOut: day(-47), status: 'completed' }, { actor: 'demo' }));
}
