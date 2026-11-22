import { Router } from 'express';
import { pool, tx } from '../db.js';
import { h, flash, requireGuest } from '../lib/web.js';
import { randomToken } from '../lib/crypto.js';
import { normalizePhone } from '../lib/format.js';
import { cardSummary } from '../services/loyalty.js';
import { catalogForGuest, redeemPoints, computeVoucherEffect } from '../services/rewards.js';
import { createGuestBooking, quote, rebookSuggestions } from '../services/bookings.js';
import { referralsForGuest, getReferralRules } from '../services/referrals.js';
import { setConsent } from '../services/guests.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';

const r = Router();
r.use(requireGuest);

// كل الاستعلامات هنا مقيدة بـ req.guest.id — لا يمكن للضيف رؤية بيانات غيره
r.use(h(async (req, res, next) => {
  res.locals.path = req.path;
  res.locals.unread = (await pool.query(
    `SELECT count(*)::int AS c FROM notifications WHERE guest_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [req.guest.id],
  )).rows[0].c;
  next();
}));

r.get('/', h(async (req, res) => {
  const s = await cardSummary(req.guest.id);
  const upcoming = (await pool.query(
    `SELECT b.*, u.name AS unit_name, u.city FROM bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.guest_id = $1 AND b.status IN ('pending','confirmed','checked_in') ORDER BY b.check_in LIMIT 2`, [req.guest.id],
  )).rows;
  const lastStay = (await pool.query(
    `SELECT b.*, u.name AS unit_name, u.city FROM bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.guest_id = $1 AND b.status = 'completed' ORDER BY b.check_out DESC LIMIT 1`, [req.guest.id],
  )).rows[0];
  const affordable = (await pool.query(
    `SELECT count(*)::int AS c FROM rewards WHERE active AND points_cost IS NOT NULL AND points_cost <= $1
       AND (valid_until IS NULL OR valid_until >= current_date)`, [req.guest.points_balance],
  )).rows[0].c;
  res.render('guest/home', { title: 'حسابي', s, upcoming, lastStay, affordable });
}));

r.get('/card', h(async (req, res) => {
  const s = await cardSummary(req.guest.id);
  res.render('guest/card', { title: 'بطاقة الولاء', s, shareUrl: `${config.appUrl}/card/${req.guest.card_token}` });
}));

r.get('/points', h(async (req, res) => {
  const ledger = (await pool.query(
    `SELECT l.*, b.booking_ref FROM points_ledger l LEFT JOIN bookings b ON b.id = l.booking_id
      WHERE l.guest_id = $1 ORDER BY l.id DESC LIMIT 200`, [req.guest.id],
  )).rows;
  const s = await cardSummary(req.guest.id);
  res.render('guest/points', { title: 'سجل النقاط', ledger, s });
}));

r.get('/rewards', h(async (req, res) => {
  const catalog = await catalogForGuest(req.guest);
  const vouchers = (await pool.query(
    `SELECT gr.*, r.name, r.reward_type, r.value, r.description, r.min_booking_amount FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id
      WHERE gr.guest_id = $1 ORDER BY (gr.status = 'available') DESC, gr.issued_at DESC LIMIT 100`, [req.guest.id],
  )).rows;
  res.render('guest/rewards', { title: 'المكافآت', catalog, vouchers, requestId: randomToken(12) });
}));

r.post('/rewards/:id/redeem', h(async (req, res) => {
  const { voucher, reward, duplicate } = await tx((c) => redeemPoints(c, {
    guestId: req.guest.id, rewardId: Number(req.params.id), requestId: String(req.body.request_id || '').slice(0, 64),
  }));
  if (!duplicate) flash(res, 'success', `تم الاستبدال! رمز مكافأتك ${voucher.code} — «${reward.name}». استخدمها عند حجزك القادم.`);
  res.redirect('/account/rewards');
}));

r.get('/bookings', h(async (req, res) => {
  const bookings = (await pool.query(
    `SELECT b.*, u.name AS unit_name, u.city, u.active AS unit_active,
            (SELECT points FROM points_ledger l WHERE l.booking_id = b.id AND l.entry_type = 'earn') AS points_earned
       FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.guest_id = $1 ORDER BY b.check_in DESC`, [req.guest.id],
  )).rows;
  res.render('guest/bookings', { title: 'حجوزاتي', bookings });
}));

r.get('/bookings/:ref', h(async (req, res) => {
  const b = (await pool.query(
    `SELECT b.*, u.name AS unit_name, u.city, u.district, gr.code AS voucher_code, rw.name AS voucher_name
       FROM bookings b JOIN units u ON u.id = b.unit_id
       LEFT JOIN guest_rewards gr ON gr.used_booking_id = b.id LEFT JOIN rewards rw ON rw.id = gr.reward_id
      WHERE b.booking_ref = $1 AND b.guest_id = $2`, [req.params.ref, req.guest.id],
  )).rows[0];
  if (!b) throw new AppError('الحجز غير موجود', { status: 404 });
  const ledger = (await pool.query('SELECT * FROM points_ledger WHERE booking_id = $1 AND guest_id = $2 ORDER BY id', [b.id, req.guest.id])).rows;
  res.render('guest/booking', { title: `حجز ${b.booking_ref}`, b, ledger });
}));

// إعادة الحجز: الوحدات السابقة + المقترحة + المكافآت المتاحة
r.get('/rebook', h(async (req, res) => {
  const { stayed, similar } = await rebookSuggestions(req.guest.id);
  const s = await cardSummary(req.guest.id);
  res.render('guest/rebook', { title: 'احجز من جديد', stayed, similar, s });
}));

r.get('/book/:unitId', h(async (req, res) => {
  const unit = (await pool.query('SELECT * FROM units WHERE id = $1 AND active', [req.params.unitId])).rows[0];
  if (!unit) throw new AppError('الوحدة غير متاحة', { status: 404 });
  const vouchers = (await pool.query(
    `SELECT gr.*, r.name, r.reward_type, r.value, r.min_booking_amount, r.unit_ids, r.stay_from, r.stay_until, r.max_discount
       FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id
      WHERE gr.guest_id = $1 AND gr.status = 'available' AND (gr.expires_at IS NULL OR gr.expires_at > now())
      ORDER BY gr.expires_at NULLS LAST`, [req.guest.id],
  )).rows;
  const form = { check_in: req.query.check_in || '', check_out: req.query.check_out || '', guests: req.query.guests || '2', voucher_id: req.query.voucher_id || '' };
  let q = null; let quoteError = null;
  if (form.check_in && form.check_out) {
    try {
      q = await tx((c) => quote(c, { guestId: req.guest.id, unitId: unit.id, checkIn: form.check_in, checkOut: form.check_out, voucherId: form.voucher_id || null }));
    } catch (e) { if (!(e instanceof AppError)) throw e; quoteError = e.message; }
  }
  // تقييم كل قسيمة على هذا الحجز لعرض ما يصلح منها
  const evaluated = vouchers.map((v) => {
    const subtotal = q ? q.subtotal : Number(unit.nightly_price);
    const eff = computeVoucherEffect(v, v, { unitId: unit.id, checkIn: form.check_in || new Date().toISOString().slice(0, 10), subtotal });
    return { ...v, usable: !eff.error, reason: eff.error, discount: eff.discount };
  });
  res.render('guest/book', { title: `حجز ${unit.name}`, unit, form, q, quoteError, vouchers: evaluated });
}));

r.post('/book/:unitId', h(async (req, res) => {
  const campaignId = Number(req.cookies.mz_cmp) || null;
  const { booking } = await tx((c) => createGuestBooking(c, {
    guestId: req.guest.id, unitId: Number(req.params.unitId), checkIn: req.body.check_in, checkOut: req.body.check_out,
    guestsCount: Math.max(1, Number(req.body.guests) || 1), voucherId: Number(req.body.voucher_id) || null, campaignId,
    notes: String(req.body.notes || '').slice(0, 500) || null,
  }));
  flash(res, 'success', 'تم إرسال طلب الحجز بنجاح! سيتواصل معك فريق منزال لتأكيده.');
  res.redirect(`/account/bookings/${booking.booking_ref}`);
}));

r.get('/referrals', h(async (req, res) => {
  const list = await referralsForGuest(req.guest.id);
  const rules = await getReferralRules();
  const rewards = rules ? (await pool.query('SELECT id, name FROM rewards WHERE id = ANY($1)', [[rules.referrer_reward_id, rules.referee_reward_id].filter(Boolean)])).rows : [];
  const nameOf = (id) => rewards.find((x) => x.id === id)?.name;
  res.render('guest/referrals', {
    title: 'ادعُ أصدقاءك', list, rules, link: `${config.appUrl}/r/${req.guest.referral_code}`,
    referrerReward: nameOf(rules?.referrer_reward_id), refereeReward: nameOf(rules?.referee_reward_id),
  });
}));

r.get('/notifications', h(async (req, res) => {
  const list = (await pool.query(
    `SELECT * FROM notifications WHERE guest_id = $1 AND channel = 'in_app' ORDER BY id DESC LIMIT 100`, [req.guest.id],
  )).rows;
  await pool.query(`UPDATE notifications SET read_at = now() WHERE guest_id = $1 AND channel = 'in_app' AND read_at IS NULL`, [req.guest.id]);
  res.render('guest/notifications', { title: 'الإشعارات', list });
}));

r.get('/preferences', h(async (req, res) => {
  res.render('guest/preferences', { title: 'التفضيلات والخصوصية' });
}));
r.post('/preferences', h(async (req, res) => {
  await tx(async (c) => {
    const b = req.body;
    await setConsent(c, req.guest.id, 'email_marketing', b.consent_email_marketing === 'on', 'preferences');
    await setConsent(c, req.guest.id, 'whatsapp', b.consent_whatsapp === 'on', 'preferences');
    await setConsent(c, req.guest.id, 'whatsapp_marketing', b.consent_whatsapp === 'on' && b.consent_whatsapp_marketing === 'on', 'preferences');
    if (b.home_city !== undefined) await c.query('UPDATE guests SET home_city = $2 WHERE id = $1', [req.guest.id, String(b.home_city).slice(0, 80) || null]);
    if (b.phone !== undefined) {
      const phone = normalizePhone(b.phone);
      if (phone !== req.guest.phone) {
        if (b.phone && !phone) throw new AppError('رقم الجوال غير صحيح');
        const taken = phone && (await c.query('SELECT 1 FROM guests WHERE phone = $1 AND id <> $2', [phone, req.guest.id])).rowCount;
        if (taken) throw new AppError('رقم الجوال مستخدم في حساب آخر');
        await c.query('UPDATE guests SET phone = $2, phone_verified_at = NULL WHERE id = $1', [req.guest.id, phone]);
      }
    }
  });
  flash(res, 'success', 'تم حفظ تفضيلاتك');
  res.redirect('/account/preferences');
}));

export default r;
