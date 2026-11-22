import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, tx } from '../db.js';
import { h, flash, createSession, destroySession, requireStaff, requirePerm, clientIp } from '../lib/web.js';
import { can, isLimitedAdjuster } from '../lib/permissions.js';
import { AppError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { normalizeEmail, normalizePhone } from '../lib/format.js';
import { dashboardKpis, SEGMENT_SQL, SEGMENT_LABELS } from '../services/kpis.js';
import { adjustPoints, recomputeTier, cardSummary } from '../services/loyalty.js';
import { issueVoucher, revokeVoucher } from '../services/rewards.js';
import { recordBooking, transition } from '../services/bookings.js';
import { previewAudience, sendCampaign, campaignStats } from '../services/campaigns.js';
import { providerStatus } from '../services/notifications.js';
import { getSettingSync, setSetting, allSettings } from '../services/settings.js';
import { runJobsOnce } from '../worker.js';
import { config } from '../config.js';

const r = Router();

// ---------- أدوات تحويل مدخلات النماذج ----------
const int = (v) => (v === '' || v == null ? null : Number.parseInt(v, 10));
const num = (v) => (v === '' || v == null ? null : Number(v));
const str = (v, max = 500) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const ids = (v) => {
  const arr = (Array.isArray(v) ? v : v ? [v] : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  return arr.length ? arr : null;
};
const bool = (v) => v === 'on' || v === 'true' || v === true;
const staffActor = (req) => `staff:${req.staff.id}`;

// ---------- الدخول ----------
r.get('/login', (req, res) => (req.staff ? res.redirect('/admin') : res.render('admin/login', { title: 'دخول فريق منزال' })));
r.post('/login', h(async (req, res) => {
  const u = (await pool.query('SELECT * FROM staff_users WHERE email = $1 AND active', [normalizeEmail(req.body.email)])).rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    await audit({ actorType: 'staff', action: 'staff.login_failed', entity: 'staff', data: { email: normalizeEmail(req.body.email) }, ip: clientIp(req) });
    return res.status(401).render('admin/login', { title: 'دخول فريق منزال', error: 'بيانات الدخول غير صحيحة' });
  }
  await createSession(res, 'staff', u.id);
  await audit({ actorType: 'staff', actorId: u.id, action: 'staff.login', entity: 'staff', entityId: u.id, ip: clientIp(req) });
  res.redirect('/admin');
}));
r.post('/logout', h(async (req, res) => { await destroySession(req, res, 'staff'); res.redirect('/admin/login'); }));

r.use(requireStaff);
r.use((req, res, next) => { res.locals.providers = providerStatus(); res.locals.isProd = config.isProd; next(); });

// ---------- لوحة المؤشرات ----------
r.get('/', requirePerm('dashboard.view'), h(async (req, res) => {
  const days = [30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : null;
  const k = await dashboardKpis({ days });
  const program = (await pool.query('SELECT * FROM loyalty_programs WHERE active LIMIT 1')).rows[0];
  const recent = (await pool.query(
    `SELECT l.*, g.full_name, g.member_no FROM points_ledger l JOIN guests g ON g.id = l.guest_id ORDER BY l.id DESC LIMIT 8`,
  )).rows;
  const topCampaigns = (await pool.query(`SELECT * FROM campaigns WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 3`)).rows;
  for (const c of topCampaigns) c.stats = await campaignStats(c.id);
  res.render('admin/dashboard', { title: 'لوحة المؤشرات', k, days, program, recent, topCampaigns });
}));

// ---------- الضيوف ----------
r.get('/guests', requirePerm('guests.view'), h(async (req, res) => {
  const q = str(req.query.q, 100);
  const seg = SEGMENT_LABELS[req.query.segment] ? req.query.segment : null;
  const sort = { spend: 's.spend DESC NULLS LAST', points: 'g.points_balance DESC', last: 's.last_stay DESC NULLS LAST' }[req.query.sort] || 'g.created_at DESC';
  const rows = (await pool.query(
    `SELECT * FROM (
       SELECT g.id, g.member_no, g.full_name, g.email, g.phone, g.points_balance, g.completed_stays, g.created_at, g.home_city,
              t.name AS tier_name, s.spend, s.last_stay, s.last_booking, ${SEGMENT_SQL} AS segment
         FROM guests g LEFT JOIN tiers t ON t.id = g.tier_id
         LEFT JOIN LATERAL (SELECT SUM(total_amount - refunded_amount) FILTER (WHERE status = 'completed') AS spend,
                                   MAX(check_out) FILTER (WHERE status = 'completed') AS last_stay, MAX(created_at) AS last_booking
                              FROM bookings WHERE guest_id = g.id) s ON true
        WHERE ($1::text IS NULL OR g.full_name ILIKE '%' || $1 || '%' OR g.email ILIKE '%' || $1 || '%' OR g.phone LIKE '%' || $1 || '%' OR g.member_no ILIKE '%' || $1 || '%')
        ORDER BY ${sort} LIMIT 300) x
      WHERE ($2::text IS NULL OR segment = $2)`, [q, seg],
  )).rows;
  const counts = (await pool.query(
    `SELECT ${SEGMENT_SQL} AS segment, count(*)::int AS c FROM guests g
       LEFT JOIN LATERAL (SELECT SUM(total_amount - refunded_amount) FILTER (WHERE status='completed') AS spend, MAX(check_out) FILTER (WHERE status='completed') AS last_stay FROM bookings WHERE guest_id = g.id) s ON true
      GROUP BY 1`,
  )).rows;
  res.render('admin/guests', { title: 'الضيوف', rows, q, seg, counts, SEGMENT_LABELS, sort: req.query.sort || '' });
}));

r.get('/guests/:id', requirePerm('guests.view'), h(async (req, res) => {
  const s = await cardSummary(Number(req.params.id));
  if (!s) throw new AppError('الضيف غير موجود', { status: 404 });
  const id = s.guest.id;
  const [bookings, ledger, vouchers, referrals, consents, notes, stats] = await Promise.all([
    pool.query(`SELECT b.*, u.name AS unit_name FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.guest_id = $1 ORDER BY b.check_in DESC`, [id]),
    pool.query(`SELECT l.*, s.name AS staff_name, b.booking_ref FROM points_ledger l LEFT JOIN staff_users s ON s.id = l.staff_id LEFT JOIN bookings b ON b.id = l.booking_id WHERE l.guest_id = $1 ORDER BY l.id DESC LIMIT 200`, [id]),
    pool.query(`SELECT gr.*, r.name FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id WHERE gr.guest_id = $1 ORDER BY gr.id DESC`, [id]),
    pool.query(`SELECT r.*, a.full_name AS referee_name, b.full_name AS referrer_name FROM referrals r JOIN guests a ON a.id = r.referee_id JOIN guests b ON b.id = r.referrer_id WHERE r.referrer_id = $1 OR r.referee_id = $1 ORDER BY r.id DESC`, [id]),
    pool.query(`SELECT * FROM consent_log WHERE guest_id = $1 ORDER BY id DESC LIMIT 30`, [id]),
    pool.query(`SELECT * FROM notifications WHERE guest_id = $1 ORDER BY id DESC LIMIT 30`, [id]),
    pool.query(`SELECT COALESCE(SUM(total_amount - refunded_amount) FILTER (WHERE status = 'completed'),0) AS spend,
                       MAX(created_at) AS last_booking, count(*)::int AS bookings FROM bookings WHERE guest_id = $1`, [id]),
  ]);
  const rewards = (await pool.query('SELECT id, name FROM rewards WHERE active ORDER BY name')).rows;
  const showContact = can(req.staff.role, 'guests.contact');
  res.render('admin/guest', {
    title: s.guest.full_name, s, g: s.guest, bookings: bookings.rows, ledger: ledger.rows, vouchers: vouchers.rows, referrals: referrals.rows,
    consents: consents.rows, notes: notes.rows, stats: stats.rows[0], rewards, showContact,
    adjustLimit: isLimitedAdjuster(req.staff.role) ? Number(getSettingSync('support_adjust_limit', 500)) : null,
  });
}));

r.post('/guests/:id/adjust', requirePerm('points.adjust'), h(async (req, res) => {
  const limit = isLimitedAdjuster(req.staff.role) ? Number(getSettingSync('support_adjust_limit', 500)) : null;
  const sign = req.body.direction === 'deduct' ? -1 : 1;
  await tx((c) => adjustPoints(c, { guestId: Number(req.params.id), points: sign * Math.abs(int(req.body.points) || 0), reason: req.body.reason, staff: req.staff, limit, ip: clientIp(req) }));
  flash(res, 'success', 'تم تعديل الرصيد وتسجيل العملية');
  res.redirect(`/admin/guests/${req.params.id}`);
}));

r.post('/guests/:id/issue', requirePerm('rewards.issue'), h(async (req, res) => {
  if (!str(req.body.reason)) throw new AppError('سبب منح المكافأة إلزامي');
  await tx(async (c) => {
    const { voucher } = await issueVoucher(c, { guestId: Number(req.params.id), rewardId: int(req.body.reward_id), source: 'manual', skipEligibility: true });
    await audit({ actorType: 'staff', actorId: req.staff.id, action: 'reward.issue_manual', entity: 'guest_reward', entityId: voucher?.id, data: { reason: req.body.reason }, ip: clientIp(req) }, c);
  });
  flash(res, 'success', 'تم منح المكافأة للضيف');
  res.redirect(`/admin/guests/${req.params.id}`);
}));

r.post('/guests/:id/status', requirePerm('loyalty.manage'), h(async (req, res) => {
  const status = req.body.status === 'suspended' ? 'suspended' : 'active';
  await tx(async (c) => {
    await c.query('UPDATE guests SET status = $2 WHERE id = $1', [req.params.id, status]);
    if (status === 'suspended') await c.query(`DELETE FROM sessions WHERE actor_type = 'guest' AND actor_id = $1`, [req.params.id]);
    await audit({ actorType: 'staff', actorId: req.staff.id, action: `guest.${status}`, entity: 'guest', entityId: req.params.id, data: { reason: req.body.reason } }, c);
  });
  flash(res, 'success', status === 'suspended' ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب');
  res.redirect(`/admin/guests/${req.params.id}`);
}));

r.post('/vouchers/:id/revoke', requirePerm('rewards.issue'), h(async (req, res) => {
  if (!str(req.body.reason)) throw new AppError('سبب الإلغاء إلزامي');
  const v = await tx(async (c) => {
    const voucher = await revokeVoucher(c, Number(req.params.id), req.body.reason);
    if (!voucher) throw new AppError('لا يمكن إلغاء مكافأة مستخدمة أو منتهية');
    // إذا كانت مستبدلة بالنقاط تُعاد النقاط بقيد موثق
    if (voucher.points_spent > 0) {
      const { postEntry } = await import('../services/ledger.js');
      await postEntry(c, { guestId: voucher.guest_id, type: 'restore', points: voucher.points_spent, guestRewardId: voucher.id, idempotencyKey: `restore:voucher:${voucher.id}`, reason: `استرجاع نقاط مكافأة ملغاة: ${req.body.reason}`, staffId: req.staff.id });
    }
    await audit({ actorType: 'staff', actorId: req.staff.id, action: 'reward.revoke', entity: 'guest_reward', entityId: voucher.id, data: { reason: req.body.reason } }, c);
    return voucher;
  });
  flash(res, 'success', 'تم إلغاء المكافأة');
  res.redirect(`/admin/guests/${v.guest_id}`);
}));

// ---------- الحجوزات ----------
r.get('/bookings', requirePerm('bookings.view'), h(async (req, res) => {
  const status = req.query.status || null;
  const q = str(req.query.q, 100);
  const rows = (await pool.query(
    `SELECT b.*, u.name AS unit_name, g.member_no FROM bookings b JOIN units u ON u.id = b.unit_id LEFT JOIN guests g ON g.id = b.guest_id
      WHERE ($1::text IS NULL OR b.status = $1)
        AND ($2::text IS NULL OR b.booking_ref ILIKE '%' || $2 || '%' OR b.contact_name ILIKE '%' || $2 || '%' OR b.contact_email ILIKE '%' || $2 || '%' OR b.contact_phone LIKE '%' || $2 || '%')
      ORDER BY b.created_at DESC LIMIT 300`, [status, q],
  )).rows;
  res.render('admin/bookings', { title: 'الحجوزات', rows, status, q });
}));

r.get('/bookings/new', requirePerm('bookings.manage'), h(async (req, res) => {
  const units = (await pool.query('SELECT * FROM units WHERE active ORDER BY name')).rows;
  res.render('admin/booking-new', { title: 'تسجيل حجز', units });
}));

r.post('/bookings', requirePerm('bookings.manage'), h(async (req, res) => {
  const b = req.body;
  const booking = await tx((c) => recordBooking(c, {
    contactName: str(b.contact_name, 120), contactEmail: str(b.contact_email, 200), contactPhone: str(b.contact_phone, 30),
    unitId: int(b.unit_id), checkIn: date(b.check_in), checkOut: date(b.check_out), guestsCount: int(b.guests_count) || 1,
    total: num(b.total), status: ['pending', 'confirmed', 'checked_in', 'completed'].includes(b.status) ? b.status : 'pending',
    externalRef: str(b.external_ref, 80), notes: str(b.notes),
  }, { actor: staffActor(req) }));
  flash(res, 'success', `تم تسجيل الحجز ${booking.booking_ref}${booking.guest_id ? ' وربطه بحساب الضيف' : ' — سيُربط تلقائيًا عند إنشاء الضيف حسابه وتأكيد بياناته'}`);
  res.redirect(`/admin/bookings/${booking.id}`);
}));

r.get('/bookings/:id', requirePerm('bookings.view'), h(async (req, res) => {
  const b = (await pool.query(
    `SELECT b.*, u.name AS unit_name, g.full_name AS guest_name, g.member_no, c.name AS campaign_name
       FROM bookings b JOIN units u ON u.id = b.unit_id LEFT JOIN guests g ON g.id = b.guest_id LEFT JOIN campaigns c ON c.id = b.campaign_id
      WHERE b.id = $1`, [req.params.id],
  )).rows[0];
  if (!b) throw new AppError('الحجز غير موجود', { status: 404 });
  const [history, ledger, voucher] = await Promise.all([
    pool.query('SELECT * FROM booking_status_history WHERE booking_id = $1 ORDER BY id', [b.id]),
    pool.query('SELECT * FROM points_ledger WHERE booking_id = $1 ORDER BY id', [b.id]),
    pool.query('SELECT gr.*, r.name FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id WHERE gr.used_booking_id = $1', [b.id]),
  ]);
  res.render('admin/booking', { title: `حجز ${b.booking_ref}`, b, history: history.rows, ledger: ledger.rows, voucher: voucher.rows[0] });
}));

r.post('/bookings/:id/transition', requirePerm('bookings.manage'), h(async (req, res) => {
  const to = String(req.body.to);
  if (['refunded', 'partial_refund'].includes(to) && !str(req.body.note)) throw new AppError('سبب الاسترداد إلزامي');
  const force = bool(req.body.force) && req.staff.role === 'admin';
  await tx((c) => transition(c, Number(req.params.id), to, { actor: staffActor(req), note: str(req.body.note), refundAmount: num(req.body.refund_amount), force }));
  flash(res, 'success', to === 'completed' ? 'تم تسجيل اكتمال الإقامة ومنح النقاط تلقائيًا' : 'تم تحديث حالة الحجز');
  res.redirect(`/admin/bookings/${req.params.id}`);
}));

// ---------- الوحدات ----------
r.get('/units', requirePerm('units.manage'), h(async (req, res) => {
  const rows = (await pool.query(`SELECT u.*, (SELECT count(*)::int FROM bookings b WHERE b.unit_id = u.id AND b.status = 'completed') AS stays FROM units u ORDER BY u.active DESC, u.city, u.name`)).rows;
  const edit = req.query.edit ? (await pool.query('SELECT * FROM units WHERE id = $1', [req.query.edit])).rows[0] : null;
  res.render('admin/units', { title: 'الوحدات', rows, edit });
}));
r.post('/units', requirePerm('units.manage'), h(async (req, res) => {
  const b = req.body;
  const vals = [str(b.name, 120), str(b.city, 80), str(b.district, 80), str(b.unit_type, 40), int(b.bedrooms) || 1, int(b.capacity) || 2, num(b.nightly_price), str(b.image_url, 500), str(b.description, 2000), bool(b.active), str(b.external_id, 80)];
  if (!vals[0] || !vals[1] || !vals[3] || !(vals[6] > 0)) throw new AppError('الاسم والمدينة والنوع والسعر حقول إلزامية');
  if (vals[7] && !/^https:\/\//.test(vals[7])) throw new AppError('رابط الصورة يجب أن يبدأ بـ https://');
  const id = int(b.id);
  if (id) {
    await pool.query(`UPDATE units SET name=$1, city=$2, district=$3, unit_type=$4, bedrooms=$5, capacity=$6, nightly_price=$7, image_url=$8, description=$9, active=$10, external_id=$11 WHERE id=$12`, [...vals, id]);
  } else {
    await pool.query(`INSERT INTO units (name, city, district, unit_type, bedrooms, capacity, nightly_price, image_url, description, active, external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, vals);
  }
  await audit({ actorType: 'staff', actorId: req.staff.id, action: id ? 'unit.update' : 'unit.create', entity: 'unit', entityId: id, data: { name: vals[0] } });
  flash(res, 'success', 'تم حفظ الوحدة');
  res.redirect('/admin/units');
}));

// ---------- برنامج الولاء: القواعد والمستويات ----------
r.get('/loyalty', requirePerm('loyalty.manage'), h(async (req, res) => {
  const programs = (await pool.query('SELECT * FROM loyalty_programs ORDER BY active DESC, id')).rows;
  const program = req.query.program === 'new' ? null : (programs.find((p) => String(p.id) === req.query.program) || programs[0]);
  const tiers = program ? (await pool.query('SELECT t.*, (SELECT count(*)::int FROM guests g WHERE g.tier_id = t.id) AS members FROM tiers t WHERE program_id = $1 ORDER BY sort_order', [program.id])).rows : [];
  const rules = program ? (await pool.query('SELECT * FROM earning_rules WHERE program_id = $1 ORDER BY id DESC', [program.id])).rows : [];
  const rewards = (await pool.query('SELECT id, name FROM rewards ORDER BY name')).rows;
  const units = (await pool.query('SELECT id, name FROM units ORDER BY name')).rows;
  res.render('admin/loyalty', { title: 'برنامج الولاء', programs, program, tiers, rules, rewards, units, settings: allSettings() });
}));

r.post('/loyalty/program', requirePerm('loyalty.manage'), h(async (req, res) => {
  const b = req.body;
  const id = int(b.id);
  const vals = [str(b.name, 120) || 'برنامج ولاء منزال', num(b.points_per_currency) ?? 1, int(b.points_per_stay) ?? 0, int(b.points_per_night) ?? 0,
    num(b.point_value) ?? 0.05, int(b.points_expiry_months), int(b.stamp_goal) ?? 0, int(b.stamp_reward_id), int(b.claim_window_days) ?? 365];
  if (vals[1] < 0 || vals[2] < 0 || vals[3] < 0) throw new AppError('القيم لا يمكن أن تكون سالبة');
  const saved = await tx(async (c) => {
    let p;
    if (id) {
      p = (await c.query(`UPDATE loyalty_programs SET name=$1, points_per_currency=$2, points_per_stay=$3, points_per_night=$4, point_value=$5, points_expiry_months=$6, stamp_goal=$7, stamp_reward_id=$8, claim_window_days=$9, updated_at=now() WHERE id=$10 RETURNING *`, [...vals, id])).rows[0];
    } else {
      p = (await c.query(`INSERT INTO loyalty_programs (name, points_per_currency, points_per_stay, points_per_night, point_value, points_expiry_months, stamp_goal, stamp_reward_id, claim_window_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, vals)).rows[0];
    }
    await audit({ actorType: 'staff', actorId: req.staff.id, action: id ? 'program.update' : 'program.create', entity: 'loyalty_program', entityId: p.id, data: req.body }, c);
    return p;
  });
  flash(res, 'success', 'تم حفظ قواعد البرنامج — تُطبق على الإقامات المكتملة من الآن');
  res.redirect(`/admin/loyalty?program=${saved.id}`);
}));

r.post('/loyalty/program/:id/toggle', requirePerm('loyalty.manage'), h(async (req, res) => {
  const activate = req.body.active === 'true';
  await tx(async (c) => {
    if (activate) await c.query('UPDATE loyalty_programs SET active = false WHERE active');
    await c.query('UPDATE loyalty_programs SET active = $2 WHERE id = $1', [req.params.id, activate]);
    await audit({ actorType: 'staff', actorId: req.staff.id, action: activate ? 'program.activate' : 'program.deactivate', entity: 'loyalty_program', entityId: req.params.id }, c);
  });
  flash(res, 'success', activate ? 'تم تفعيل البرنامج' : 'تم إيقاف البرنامج — لن تُمنح نقاط جديدة حتى إعادة تفعيله');
  res.redirect(`/admin/loyalty?program=${req.params.id}`);
}));

r.post('/loyalty/tiers', requirePerm('loyalty.manage'), h(async (req, res) => {
  const b = req.body;
  const id = int(b.id);
  if (b._action === 'delete' && id) {
    await pool.query('DELETE FROM tiers WHERE id = $1', [id]);
  } else {
    const vals = [str(b.name, 60), int(b.min_stays) ?? 0, int(b.min_points) ?? 0, num(b.earn_multiplier) ?? 1, str(b.perks), str(b.color, 20) || '#640211', int(b.sort_order) ?? 0];
    if (!vals[0]) throw new AppError('اسم المستوى إلزامي');
    if (id) await pool.query('UPDATE tiers SET name=$1, min_stays=$2, min_points=$3, earn_multiplier=$4, perks=$5, color=$6, sort_order=$7 WHERE id=$8', [...vals, id]);
    else await pool.query('INSERT INTO tiers (name, min_stays, min_points, earn_multiplier, perks, color, sort_order, program_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [...vals, int(b.program_id)]);
  }
  // إعادة احتساب مستويات الأعضاء
  const guests = (await pool.query('SELECT id FROM guests')).rows;
  await tx(async (c) => { for (const g of guests) await recomputeTier(c, g.id); });
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'tiers.update', entity: 'tier', entityId: id, data: req.body });
  flash(res, 'success', 'تم حفظ المستويات وإعادة احتساب مستويات الأعضاء');
  res.redirect(`/admin/loyalty?program=${b.program_id}`);
}));

r.post('/loyalty/rules', requirePerm('loyalty.manage'), h(async (req, res) => {
  const b = req.body;
  const id = int(b.id);
  if (b._action === 'toggle' && id) {
    await pool.query('UPDATE earning_rules SET active = NOT active WHERE id = $1', [id]);
  } else {
    const vals = [int(b.program_id), str(b.name, 120), b.rule_type === 'bonus_points' ? 'bonus_points' : 'multiplier', num(b.value), ids(b.unit_ids), date(b.valid_from), date(b.valid_until)];
    if (!vals[1] || !(vals[3] > 0)) throw new AppError('الاسم والقيمة إلزاميان');
    await pool.query('INSERT INTO earning_rules (program_id, name, rule_type, value, unit_ids, valid_from, valid_until) VALUES ($1,$2,$3,$4,$5,$6,$7)', vals);
  }
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'earning_rule.update', entity: 'earning_rule', entityId: id, data: req.body });
  flash(res, 'success', 'تم حفظ قاعدة الاكتساب');
  res.redirect(`/admin/loyalty?program=${b.program_id}`);
}));

r.post('/settings', requirePerm('loyalty.manage'), h(async (req, res) => {
  const b = req.body;
  if (str(b.currency_symbol, 10)) await setSetting('currency_symbol', str(b.currency_symbol, 10));
  if (str(b.currency_code, 5)) await setSetting('currency_code', str(b.currency_code, 5).toUpperCase());
  if (int(b.support_adjust_limit) != null) await setSetting('support_adjust_limit', int(b.support_adjust_limit));
  if (int(b.campaign_attribution_days) != null) await setSetting('campaign_attribution_days', int(b.campaign_attribution_days));
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'settings.update', entity: 'settings', data: req.body });
  flash(res, 'success', 'تم حفظ الإعدادات');
  res.redirect('/admin/loyalty');
}));

// ---------- المكافآت والعروض ----------
r.get('/rewards', requirePerm('rewards.manage'), h(async (req, res) => {
  const rows = (await pool.query(
    `SELECT r.*, (SELECT count(*)::int FROM guest_rewards gr WHERE gr.reward_id = r.id AND gr.status = 'used') AS used_count,
            (SELECT COALESCE(SUM(discount_applied),0) FROM guest_rewards gr WHERE gr.reward_id = r.id AND gr.status = 'used') AS used_value
       FROM rewards r ORDER BY r.active DESC, r.category, r.points_cost NULLS LAST`,
  )).rows;
  res.render('admin/rewards', { title: 'المكافآت والعروض', rows });
}));
r.get('/rewards/:id', requirePerm('rewards.manage'), h(async (req, res) => {
  const reward = req.params.id === 'new' ? { active: true, reward_type: 'fixed_discount', category: 'catalog', voucher_validity_days: 90, min_booking_amount: 0, value: 0 }
    : (await pool.query('SELECT * FROM rewards WHERE id = $1', [req.params.id])).rows[0];
  if (!reward) throw new AppError('المكافأة غير موجودة', { status: 404 });
  const units = (await pool.query('SELECT id, name, city FROM units ORDER BY city, name')).rows;
  const tiers = (await pool.query('SELECT id, name FROM tiers ORDER BY sort_order')).rows;
  res.render('admin/reward-form', { title: reward.id ? `تعديل: ${reward.name}` : 'مكافأة جديدة', reward, units, tiers });
}));
r.post('/rewards', requirePerm('rewards.manage'), h(async (req, res) => {
  const b = req.body;
  const id = int(b.id);
  const type = ['percent_discount', 'fixed_discount', 'free_upgrade', 'late_checkout'].includes(b.reward_type) ? b.reward_type : null;
  const category = ['catalog', 'seasonal', 'repeat_guest', 'referral', 'stamp', 'campaign'].includes(b.category) ? b.category : 'catalog';
  const vals = [str(b.name, 120), str(b.description, 1000), type, category, num(b.value) ?? 0, num(b.max_discount), int(b.points_cost),
    num(b.min_booking_amount) ?? 0, ids(b.unit_ids), int(b.min_tier_id), int(b.min_completed_stays) ?? 0, date(b.valid_from), date(b.valid_until),
    date(b.stay_from), date(b.stay_until), int(b.voucher_validity_days) ?? 90, int(b.per_guest_limit), int(b.total_stock), bool(b.active)];
  if (!vals[0] || !type) throw new AppError('الاسم والنوع إلزاميان');
  if (type === 'percent_discount' && !(vals[4] > 0 && vals[4] <= 100)) throw new AppError('نسبة الخصم يجب أن تكون بين 1 و 100');
  if (type === 'fixed_discount' && !(vals[4] > 0)) throw new AppError('أدخل مبلغ الخصم');
  if (vals[6] != null && vals[6] <= 0) throw new AppError('تكلفة النقاط يجب أن تكون أكبر من صفر أو فارغة');
  const cols = 'name, description, reward_type, category, value, max_discount, points_cost, min_booking_amount, unit_ids, min_tier_id, min_completed_stays, valid_from, valid_until, stay_from, stay_until, voucher_validity_days, per_guest_limit, total_stock, active';
  let savedId = id;
  if (id) {
    await pool.query(`UPDATE rewards SET (${cols}, updated_at) = ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now()) WHERE id = $20`, [...vals, id]);
  } else {
    savedId = (await pool.query(`INSERT INTO rewards (${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`, vals)).rows[0].id;
  }
  await audit({ actorType: 'staff', actorId: req.staff.id, action: id ? 'reward.update' : 'reward.create', entity: 'reward', entityId: savedId, data: req.body });
  flash(res, 'success', 'تم حفظ المكافأة');
  res.redirect('/admin/rewards');
}));

// ---------- الإحالات ----------
r.get('/referrals', requirePerm('referrals.view'), h(async (req, res) => {
  const rules = (await pool.query('SELECT * FROM referral_rules WHERE id = 1')).rows[0];
  const rows = (await pool.query(
    `SELECT r.*, a.full_name AS referrer_name, a.id AS referrer_gid, b.full_name AS referee_name, b.id AS referee_gid, bk.booking_ref
       FROM referrals r JOIN guests a ON a.id = r.referrer_id JOIN guests b ON b.id = r.referee_id LEFT JOIN bookings bk ON bk.id = r.booking_id
      ORDER BY r.id DESC LIMIT 300`,
  )).rows;
  const rewards = (await pool.query('SELECT id, name FROM rewards ORDER BY name')).rows;
  res.render('admin/referrals', { title: 'الإحالات', rules, rows, rewards });
}));
r.post('/referrals/rules', requirePerm('referrals.manage'), h(async (req, res) => {
  const b = req.body;
  await pool.query(
    `INSERT INTO referral_rules (id, active, referrer_points, referrer_reward_id, referee_reward_id, min_booking_amount, max_per_referrer_month, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (id) DO UPDATE SET active=$1, referrer_points=$2, referrer_reward_id=$3, referee_reward_id=$4, min_booking_amount=$5, max_per_referrer_month=$6, updated_at=now()`,
    [bool(b.active), int(b.referrer_points) ?? 0, int(b.referrer_reward_id), int(b.referee_reward_id), num(b.min_booking_amount) ?? 0, int(b.max_per_referrer_month) ?? 10],
  );
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'referral_rules.update', entity: 'referral_rules', data: req.body });
  flash(res, 'success', 'تم حفظ قواعد الإحالة');
  res.redirect('/admin/referrals');
}));
r.post('/referrals/:id/reject', requirePerm('referrals.manage'), h(async (req, res) => {
  if (!str(req.body.reason)) throw new AppError('سبب الرفض إلزامي');
  const u = await pool.query(`UPDATE referrals SET status = 'rejected', reject_reason = $2 WHERE id = $1 AND status = 'pending'`, [req.params.id, `رفض إداري: ${req.body.reason}`]);
  if (!u.rowCount) throw new AppError('يمكن رفض الإحالات المعلقة فقط');
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'referral.reject', entity: 'referral', entityId: req.params.id, data: { reason: req.body.reason } });
  flash(res, 'success', 'تم رفض الإحالة');
  res.redirect('/admin/referrals');
}));

// ---------- الحملات ----------
r.get('/campaigns', requirePerm('campaigns.manage'), h(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM campaigns ORDER BY id DESC')).rows;
  for (const c of rows) if (c.status === 'sent') c.stats = await campaignStats(c.id);
  res.render('admin/campaigns', { title: 'الحملات التسويقية', rows });
}));
r.get('/campaigns/:id', requirePerm('campaigns.manage'), h(async (req, res) => {
  const c = req.params.id === 'new'
    ? { channels: ['email'], segment: { stayed_within_days: 365, no_rebook: true }, status: 'draft', body: 'مرحبًا {{name}}،\n' }
    : (await pool.query('SELECT * FROM campaigns WHERE id = $1', [req.params.id])).rows[0];
  if (!c) throw new AppError('الحملة غير موجودة', { status: 404 });
  const tiers = (await pool.query('SELECT id, name FROM tiers ORDER BY sort_order')).rows;
  const rewards = (await pool.query(`SELECT id, name FROM rewards WHERE active ORDER BY name`)).rows;
  const audience = await previewAudience(c.segment);
  const stats = c.id && c.status === 'sent' ? await campaignStats(c.id) : null;
  res.render('admin/campaign', { title: c.id ? c.name : 'حملة جديدة', c, tiers, rewards, audience, stats });
}));
function segmentFromBody(b) {
  const seg = {};
  for (const k of ['stayed_within_days', 'inactive_days', 'min_stays', 'max_stays', 'tier_id', 'min_points']) if (int(b[k]) != null) seg[k] = int(b[k]);
  if (bool(b.no_rebook)) seg.no_rebook = true;
  if (bool(b.never_stayed)) seg.never_stayed = true;
  if (str(b.home_city, 80)) seg.home_city = str(b.home_city, 80);
  if (str(b.link, 200) && b.link.startsWith('/')) seg.link = str(b.link, 200);
  if (str(b.whatsapp_template_name, 120)) seg.whatsapp_template_name = str(b.whatsapp_template_name, 120);
  return seg;
}
r.post('/campaigns', requirePerm('campaigns.manage'), h(async (req, res) => {
  const b = req.body;
  const id = int(b.id);
  const channels = (Array.isArray(b.channels) ? b.channels : b.channels ? [b.channels] : []).filter((x) => ['email', 'whatsapp'].includes(x));
  if (!str(b.name) || !str(b.body, 5000)) throw new AppError('اسم الحملة ونص الرسالة إلزاميان');
  const vals = [str(b.name, 120), JSON.stringify(segmentFromBody(b)), channels, str(b.subject, 200), str(b.body, 5000), int(b.reward_id)];
  let cid = id;
  if (id) {
    const u = await pool.query(`UPDATE campaigns SET name=$1, segment=$2, channels=$3, subject=$4, body=$5, reward_id=$6 WHERE id=$7 AND status IN ('draft','scheduled')`, [...vals, id]);
    if (!u.rowCount) throw new AppError('لا يمكن تعديل حملة مرسلة');
  } else {
    cid = (await pool.query(`INSERT INTO campaigns (name, segment, channels, subject, body, reward_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [...vals, req.staff.id])).rows[0].id;
  }
  flash(res, 'success', 'تم حفظ الحملة');
  res.redirect(`/admin/campaigns/${cid}`);
}));
r.post('/campaigns/:id/test', requirePerm('campaigns.manage'), h(async (req, res) => {
  const key = str(req.body.test_guest, 200);
  const g = (await pool.query('SELECT id FROM guests WHERE email = $1 OR member_no = $2 OR phone = $3', [normalizeEmail(key), key, normalizePhone(key)])).rows[0];
  if (!g) throw new AppError('لم يتم العثور على ضيف بهذا الجوال أو البريد أو رقم العضوية');
  await sendCampaign(Number(req.params.id), { testGuestIds: [g.id], actorId: req.staff.id });
  flash(res, 'success', 'تم إرسال نسخة تجريبية (تُرسل فقط إذا كان لدى الضيف موافقة على القناة)');
  res.redirect(`/admin/campaigns/${req.params.id}`);
}));
r.post('/campaigns/:id/send', requirePerm('campaigns.manage'), h(async (req, res) => {
  const out = await sendCampaign(Number(req.params.id), { actorId: req.staff.id });
  flash(res, 'success', `تم إطلاق الحملة: ${out.recipients} ضيف مؤهل من أصل ${out.audience}. الرسائل في طابور الإرسال.`);
  res.redirect(`/admin/campaigns/${req.params.id}`);
}));
r.post('/campaigns/:id/schedule', requirePerm('campaigns.manage'), h(async (req, res) => {
  const at = new Date(req.body.scheduled_at);
  if (Number.isNaN(at.getTime()) || at < new Date()) throw new AppError('اختر وقتًا مستقبليًا للإرسال');
  const u = await pool.query(`UPDATE campaigns SET status = 'scheduled', scheduled_at = $2 WHERE id = $1 AND status IN ('draft','scheduled')`, [req.params.id, at]);
  if (!u.rowCount) throw new AppError('لا يمكن جدولة هذه الحملة');
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'campaign.schedule', entity: 'campaign', entityId: req.params.id, data: { at } });
  flash(res, 'success', 'تمت جدولة الحملة');
  res.redirect(`/admin/campaigns/${req.params.id}`);
}));
r.post('/campaigns/:id/cancel', requirePerm('campaigns.manage'), h(async (req, res) => {
  await pool.query(`UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = $1 AND status = 'scheduled'`, [req.params.id]);
  flash(res, 'success', 'تم إلغاء الجدولة');
  res.redirect(`/admin/campaigns/${req.params.id}`);
}));

// ---------- القوالب والأتمتة ----------
r.get('/messages', requirePerm('templates.manage'), h(async (req, res) => {
  const templates = (await pool.query('SELECT * FROM message_templates ORDER BY category, name')).rows;
  const automations = (await pool.query('SELECT * FROM automations ORDER BY key')).rows;
  const rewards = (await pool.query('SELECT id, name FROM rewards WHERE active ORDER BY name')).rows;
  res.render('admin/messages', { title: 'الرسائل والأتمتة', templates, automations, rewards });
}));
r.post('/messages/template', requirePerm('templates.manage'), h(async (req, res) => {
  const b = req.body;
  if (!str(b.subject, 200) || !str(b.body, 3000)) throw new AppError('العنوان والنص إلزاميان');
  await pool.query(`UPDATE message_templates SET subject=$2, body=$3, whatsapp_template_name=$4, whatsapp_params=$5, updated_at=now() WHERE key=$1`,
    [b.key, str(b.subject, 200), str(b.body, 3000), str(b.whatsapp_template_name, 120), str(b.whatsapp_params, 200)]);
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'template.update', entity: 'message_template', entityId: b.key });
  flash(res, 'success', 'تم حفظ القالب');
  res.redirect('/admin/messages');
}));
r.post('/messages/automation', requirePerm('templates.manage'), h(async (req, res) => {
  const b = req.body;
  const a = (await pool.query('SELECT * FROM automations WHERE key = $1', [b.key])).rows[0];
  if (!a) throw new AppError('غير موجود', { status: 404 });
  const params = { ...a.params };
  for (const k of Object.keys(a.params)) if (b[`param_${k}`] !== undefined) params[k] = int(b[`param_${k}`]);
  const channels = ['in_app', ...(Array.isArray(b.channels) ? b.channels : b.channels ? [b.channels] : []).filter((x) => ['email', 'whatsapp'].includes(x))];
  await pool.query('UPDATE automations SET active=$2, params=$3, channels=$4 WHERE key=$1', [b.key, bool(b.active), JSON.stringify(params), channels]);
  await audit({ actorType: 'staff', actorId: req.staff.id, action: 'automation.update', entity: 'automation', entityId: b.key, data: { active: bool(b.active), params, channels } });
  flash(res, 'success', 'تم حفظ إعدادات الأتمتة');
  res.redirect('/admin/messages');
}));

r.get('/notifications', requirePerm('notifications.view'), h(async (req, res) => {
  const status = req.query.status || null;
  const channel = req.query.channel || null;
  const rows = (await pool.query(
    `SELECT n.*, g.full_name, g.member_no FROM notifications n JOIN guests g ON g.id = n.guest_id
      WHERE ($1::text IS NULL OR n.status = $1) AND ($2::text IS NULL OR n.channel = $2) ORDER BY n.id DESC LIMIT 300`, [status, channel],
  )).rows;
  res.render('admin/notifications', { title: 'سجل الرسائل', rows, status, channel });
}));

r.post('/jobs/run', requirePerm('notifications.view'), h(async (req, res) => {
  const out = await runJobsOnce();
  flash(res, 'success', out.skipped ? 'المهام قيد التشغيل حاليًا' : `تم التشغيل: أُرسلت ${out.sent} رسالة، ${out.campaigns} حملة مجدولة، انتهت صلاحية ${out.maintenance.expiredLots} دفعة نقاط و${out.maintenance.expiredVouchers} مكافأة.`);
  res.redirect(req.get('referer') || '/admin/notifications');
}));

// ---------- فريق العمل والتدقيق والتكامل ----------
r.get('/staff', requirePerm('staff.manage'), h(async (req, res) => {
  const rows = (await pool.query('SELECT id, email, name, role, active, created_at FROM staff_users ORDER BY id')).rows;
  res.render('admin/staff', { title: 'فريق العمل', rows });
}));
r.post('/staff', requirePerm('staff.manage'), h(async (req, res) => {
  const b = req.body;
  if (b._action === 'toggle') {
    if (Number(b.id) === req.staff.id) throw new AppError('لا يمكنك إيقاف حسابك');
    await pool.query('UPDATE staff_users SET active = NOT active WHERE id = $1', [b.id]);
    await pool.query(`DELETE FROM sessions WHERE actor_type = 'staff' AND actor_id = $1`, [b.id]);
  } else {
    const role = ['admin', 'manager', 'support', 'marketing'].includes(b.role) ? b.role : null;
    if (!normalizeEmail(b.email) || !str(b.name) || !role) throw new AppError('جميع الحقول إلزامية');
    if (!b.password || b.password.length < 10) throw new AppError('كلمة المرور يجب ألا تقل عن 10 أحرف');
    await pool.query('INSERT INTO staff_users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)', [normalizeEmail(b.email), str(b.name, 100), await bcrypt.hash(b.password, 10), role]);
  }
  await audit({ actorType: 'staff', actorId: req.staff.id, action: `staff.${b._action || 'create'}`, entity: 'staff', entityId: b.id, data: { email: b.email, role: b.role } });
  flash(res, 'success', 'تم الحفظ');
  res.redirect('/admin/staff');
}));
r.get('/audit', requirePerm('audit.view'), h(async (req, res) => {
  const rows = (await pool.query(
    `SELECT a.*, s.name AS staff_name FROM audit_log a LEFT JOIN staff_users s ON a.actor_type = 'staff' AND s.id = a.actor_id ORDER BY a.id DESC LIMIT 300`,
  )).rows;
  res.render('admin/audit', { title: 'سجل التدقيق', rows });
}));
r.get('/integrations', requirePerm('dashboard.view'), h(async (req, res) => {
  const events = (await pool.query('SELECT * FROM integration_events ORDER BY id DESC LIMIT 50')).rows;
  res.render('admin/integrations', { title: 'التكاملات', events, webhookConfigured: Boolean(config.bookingWebhookSecret), webhookUrl: `${config.appUrl}/api/integrations/bookings` });
}));

export default r;
