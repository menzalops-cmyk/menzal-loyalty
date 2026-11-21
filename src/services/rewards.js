// المكافآت: الكتالوج، إصدار القسائم، الاستبدال بالنقاط، التحقق عند الحجز.
import { AppError } from '../lib/errors.js';
import { randomCode } from '../lib/crypto.js';
import { postEntry, lockGuest } from './ledger.js';
import { notify } from './notifications.js';
import { audit } from '../lib/audit.js';
import { pool } from '../db.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

/** هل المكافأة متاحة للإصدار الآن لهذا الضيف؟ تعيد سبب الرفض أو null */
export async function eligibilityError(client, reward, guest) {
  if (!reward.active) return 'المكافأة غير مفعلة';
  const t = todayStr();
  if (reward.valid_from && t < reward.valid_from) return 'المكافأة لم تبدأ بعد';
  if (reward.valid_until && t > reward.valid_until) return 'انتهت فترة هذه المكافأة';
  if (reward.total_stock != null && reward.issued_count >= reward.total_stock) return 'نفدت الكمية المتاحة';
  if (reward.min_completed_stays && guest.completed_stays < reward.min_completed_stays) {
    return `تتطلب ${reward.min_completed_stays} إقامات مكتملة على الأقل`;
  }
  if (reward.min_tier_id) {
    const r = (await client.query(
      `SELECT (SELECT sort_order FROM tiers WHERE id = $1) AS need, (SELECT sort_order FROM tiers WHERE id = $2) AS has`,
      [reward.min_tier_id, guest.tier_id],
    )).rows[0];
    if (r.has == null || r.has < r.need) return 'تتطلب مستوى ولاء أعلى';
  }
  if (reward.per_guest_limit != null) {
    const c = (await client.query(
      `SELECT count(*)::int AS c FROM guest_rewards WHERE guest_id = $1 AND reward_id = $2 AND status <> 'revoked'`,
      [guest.id, reward.id],
    )).rows[0].c;
    if (c >= reward.per_guest_limit) return 'وصلت للحد الأقصى لهذه المكافأة';
  }
  return null;
}

/**
 * إصدار قسيمة لضيف (من الاستبدال أو الأختام أو الإحالة أو الحملات).
 * source + sourceRef فريدان لكل ضيف لمنع الإصدار المكرر لنفس السبب.
 */
export async function issueVoucher(client, { guestId, rewardId, source, sourceRef = null, pointsSpent = 0, skipEligibility = false, notifyGuest = true }) {
  const guest = await lockGuest(client, guestId);
  const reward = (await client.query('SELECT * FROM rewards WHERE id = $1 FOR UPDATE', [rewardId])).rows[0];
  if (!reward) throw new AppError('المكافأة غير موجودة', { status: 404 });

  if (sourceRef) {
    const dup = (await client.query(
      'SELECT * FROM guest_rewards WHERE guest_id = $1 AND source = $2 AND source_ref = $3', [guestId, source, sourceRef],
    )).rows[0];
    if (dup) return { voucher: dup, duplicate: true };
  }
  if (!skipEligibility) {
    const err = await eligibilityError(client, reward, guest);
    if (err) throw new AppError(err, { code: 'not_eligible' });
  } else if (!reward.active) {
    return { voucher: null, skipped: 'inactive' };
  }

  const expiresAt = reward.voucher_validity_days
    ? new Date(Date.now() + reward.voucher_validity_days * 86400000) : null;
  let voucher;
  for (let i = 0; i < 5 && !voucher; i++) {
    const code = `MZ-${randomCode(8)}`;
    voucher = (await client.query(
      `INSERT INTO guest_rewards (guest_id, reward_id, code, source, source_ref, points_spent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING *`,
      [guestId, rewardId, code, source, sourceRef, pointsSpent, expiresAt],
    )).rows[0];
  }
  await client.query('UPDATE rewards SET issued_count = issued_count + 1 WHERE id = $1', [rewardId]);

  if (notifyGuest) {
    await notify(client, {
      guestId, templateKey: 'reward_issued', category: 'transactional',
      vars: { reward_name: reward.name, code: voucher.code, expires_at: expiresAt ? expiresAt.toISOString().slice(0, 10) : 'بدون انتهاء' },
      link: '/account/rewards', dedupeKey: `voucher:${voucher.id}`,
    });
  }
  return { voucher, reward, duplicate: false };
}

/** استبدال النقاط بمكافأة من الكتالوج — عملية خادم بالكامل */
export async function redeemPoints(client, { guestId, rewardId, requestId }) {
  if (!requestId) throw new AppError('طلب غير صالح');
  const idem = `redeem:${guestId}:${requestId}`;
  const prior = (await client.query('SELECT * FROM points_ledger WHERE idempotency_key = $1', [idem])).rows[0];
  if (prior) {
    const v = (await client.query('SELECT * FROM guest_rewards WHERE id = $1', [prior.guest_reward_id])).rows[0];
    return { voucher: v, duplicate: true };
  }
  const guest = await lockGuest(client, guestId);
  if (guest.status !== 'active') throw new AppError('الحساب موقوف');
  const reward = (await client.query('SELECT * FROM rewards WHERE id = $1', [rewardId])).rows[0];
  if (!reward || reward.points_cost == null) throw new AppError('هذه المكافأة غير متاحة للاستبدال بالنقاط');
  if (guest.points_balance < reward.points_cost) throw new AppError('رصيد النقاط غير كافٍ لهذه المكافأة', { code: 'insufficient_points' });

  const { voucher } = await issueVoucher(client, {
    guestId, rewardId, source: 'redeem', sourceRef: requestId, pointsSpent: reward.points_cost,
  });
  await postEntry(client, {
    guestId, type: 'redeem', points: -reward.points_cost, guestRewardId: voucher.id,
    idempotencyKey: idem, reason: `استبدال: ${reward.name}`,
  });
  await audit({ actorType: 'guest', actorId: guestId, action: 'points.redeem', entity: 'guest_reward', entityId: voucher.id, data: { rewardId, points: reward.points_cost } }, client);
  return { voucher, reward, duplicate: false };
}

/** حساب أثر القسيمة على حجز محدد دون تعديل أي شيء */
export function computeVoucherEffect(reward, voucher, { unitId, checkIn, subtotal }) {
  if (voucher.status !== 'available') return { error: voucher.status === 'used' ? 'هذه المكافأة مستخدمة مسبقًا' : 'هذه المكافأة غير صالحة' };
  if (voucher.expires_at && new Date(voucher.expires_at) <= new Date()) return { error: 'انتهت صلاحية هذه المكافأة' };
  if (Number(subtotal) < Number(reward.min_booking_amount)) return { error: `الحد الأدنى لقيمة الحجز لاستخدام هذه المكافأة ${reward.min_booking_amount}` };
  if (reward.unit_ids && reward.unit_ids.length && !reward.unit_ids.map(Number).includes(Number(unitId))) return { error: 'هذه المكافأة غير مشمولة لهذه الوحدة' };
  if (reward.stay_from && checkIn < reward.stay_from) return { error: 'تاريخ الإقامة خارج فترة العرض' };
  if (reward.stay_until && checkIn > reward.stay_until) return { error: 'تاريخ الإقامة خارج فترة العرض' };
  let discount = 0;
  let perk = null;
  if (reward.reward_type === 'percent_discount') {
    discount = Math.round(Number(subtotal) * Number(reward.value)) / 100;
    if (reward.max_discount != null) discount = Math.min(discount, Number(reward.max_discount));
  } else if (reward.reward_type === 'fixed_discount') {
    discount = Math.min(Number(reward.value), Number(subtotal));
  } else {
    perk = reward.reward_type; // free_upgrade | late_checkout — تُنفذ عند التوفر
  }
  return { discount: Math.round(discount * 100) / 100, perk };
}

/** قفل القسيمة والتحقق منها لاستخدامها في حجز (داخل معاملة الحجز) */
export async function lockVoucherForBooking(client, { guestId, voucherId, unitId, checkIn, subtotal }) {
  const voucher = (await client.query('SELECT * FROM guest_rewards WHERE id = $1 FOR UPDATE', [voucherId])).rows[0];
  if (!voucher || Number(voucher.guest_id) !== Number(guestId)) throw new AppError('المكافأة غير موجودة', { status: 404 });
  const reward = (await client.query('SELECT * FROM rewards WHERE id = $1', [voucher.reward_id])).rows[0];
  const effect = computeVoucherEffect(reward, voucher, { unitId, checkIn, subtotal });
  if (effect.error) throw new AppError(effect.error, { code: 'voucher_invalid' });
  return { voucher, reward, ...effect };
}

/** استرجاع قسيمة بعد إلغاء الحجز قبل الإقامة */
export async function restoreVoucherFromBooking(client, bookingId) {
  const v = (await client.query(
    `SELECT * FROM guest_rewards WHERE used_booking_id = $1 AND status = 'used' FOR UPDATE`, [bookingId],
  )).rows[0];
  if (!v) return null;
  const expired = v.expires_at && new Date(v.expires_at) <= new Date();
  const r = (await client.query(
    `UPDATE guest_rewards SET status = $2, used_at = NULL, used_booking_id = NULL, discount_applied = NULL
      WHERE id = $1 RETURNING *`,
    [v.id, expired ? 'expired' : 'available'],
  )).rows[0];
  return r;
}

export async function revokeVoucher(client, voucherId, reason) {
  return (await client.query(
    `UPDATE guest_rewards SET status = 'revoked', revoked_reason = $2 WHERE id = $1 AND status = 'available' RETURNING *`,
    [voucherId, reason],
  )).rows[0] || null;
}

/** تحويل القسائم المنتهية إلى حالة "منتهية" */
export async function expireVouchers(client = pool) {
  const r = await client.query(
    `UPDATE guest_rewards SET status = 'expired' WHERE status = 'available' AND expires_at IS NOT NULL AND expires_at <= now()`,
  );
  return r.rowCount;
}

/** المكافآت المتاحة للضيف في الكتالوج مع حالة الأهلية */
export async function catalogForGuest(guest, client = pool) {
  const rewards = (await client.query(
    `SELECT * FROM rewards WHERE active AND points_cost IS NOT NULL
       AND (valid_from IS NULL OR valid_from <= current_date) AND (valid_until IS NULL OR valid_until >= current_date)
     ORDER BY points_cost ASC`,
  )).rows;
  const out = [];
  for (const r of rewards) {
    let err = await eligibilityError(client, r, guest);
    if (!err && guest.points_balance < r.points_cost) err = `تحتاج ${r.points_cost - guest.points_balance} نقطة إضافية`;
    out.push({ ...r, eligible: !err, reason: err });
  }
  return out;
}
