// قلب نظام الولاء: احتساب النقاط بعد الإقامة المكتملة، الأختام، المستويات، العكس عند الاسترداد، التعديل الإداري.
import { AppError } from '../lib/errors.js';
import { postEntry, lockGuest } from './ledger.js';
import { issueVoucher, revokeVoucher } from './rewards.js';
import { notify } from './notifications.js';
import { qualifyReferral, reverseReferralForBooking } from './referrals.js';
import { audit } from '../lib/audit.js';
import { pool } from '../db.js';

export async function getActiveProgram(client = pool) {
  return (await client.query('SELECT * FROM loyalty_programs WHERE active LIMIT 1')).rows[0] || null;
}

/** قواعد الاكتساب الإضافية المطابقة لحجز معين */
async function matchingRules(client, programId, booking) {
  return (await client.query(
    `SELECT * FROM earning_rules
      WHERE program_id = $1 AND active
        AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_until IS NULL OR valid_until >= $2::date)
        AND (unit_ids IS NULL OR cardinality(unit_ids) = 0 OR $3 = ANY(unit_ids))`,
    [programId, booking.check_in, booking.unit_id],
  )).rows;
}

/** حساب النقاط المستحقة لحجز وفق القواعد الحالية (المبلغ المدفوع فعليًا بعد الخصم والاسترداد) */
export async function computeEarnPoints(client, program, booking, tier) {
  const paid = Math.max(0, Number(booking.total_amount) - Number(booking.refunded_amount || 0));
  if (paid <= 0) return { points: 0, breakdown: { paid } };
  const base = Math.floor(paid * Number(program.points_per_currency))
    + Number(program.points_per_stay) + Number(program.points_per_night) * Number(booking.nights);
  const rules = await matchingRules(client, program.id, booking);
  let multiplier = tier ? Number(tier.earn_multiplier) : 1;
  let bonus = 0;
  for (const r of rules) {
    if (r.rule_type === 'multiplier') multiplier *= Number(r.value);
    else bonus += Math.trunc(Number(r.value));
  }
  const points = Math.max(0, Math.round(base * multiplier) + bonus);
  return { points, breakdown: { paid, base, multiplier, bonus, rules: rules.map((r) => r.name) } };
}

/** إعادة حساب مستوى الضيف */
export async function recomputeTier(client, guestId) {
  const g = (await client.query('SELECT * FROM guests WHERE id = $1', [guestId])).rows[0];
  const program = await getActiveProgram(client);
  if (!program) return null;
  const tier = (await client.query(
    `SELECT * FROM tiers WHERE program_id = $1 AND min_stays <= $2 AND min_points <= $3
      ORDER BY sort_order DESC LIMIT 1`,
    [program.id, g.completed_stays, g.lifetime_points],
  )).rows[0] || null;
  if ((tier?.id ?? null) !== (g.tier_id ?? null)) {
    await client.query('UPDATE guests SET tier_id = $2 WHERE id = $1', [guestId, tier?.id ?? null]);
    if (tier && (!g.tier_id || (await isUpgrade(client, g.tier_id, tier.id)))) {
      await notify(client, {
        guestId, templateKey: 'tier_upgraded', category: 'transactional',
        vars: { tier_name: tier.name, perks: tier.perks || '' }, link: '/account', dedupeKey: `tier:${tier.id}`,
      });
    }
  }
  return tier;
}
async function isUpgrade(client, fromId, toId) {
  const r = (await client.query('SELECT (SELECT sort_order FROM tiers WHERE id=$2) > (SELECT sort_order FROM tiers WHERE id=$1) AS up', [fromId, toId])).rows[0];
  return r.up;
}

/**
 * معالجة إقامة مكتملة: نقاط + ختم + مستوى + إحالة + إشعارات.
 * آمنة للتكرار: يمكن استدعاؤها أكثر من مرة لنفس الحجز دون أي احتساب مزدوج.
 */
export async function processCompletedBooking(client, bookingId, { actor = 'system' } = {}) {
  const booking = (await client.query(
    `SELECT b.*, u.name AS unit_name FROM bookings b JOIN units u ON u.id = b.unit_id WHERE b.id = $1 FOR UPDATE OF b`, [bookingId],
  )).rows[0];
  if (!booking) throw new AppError('الحجز غير موجود', { status: 404 });
  if (booking.status !== 'completed') return { skipped: 'not_completed' };
  if (!booking.guest_id) return { skipped: 'no_guest' }; // تُعالج لاحقًا عند ربط الحجز بحساب موثق
  const program = await getActiveProgram(client);
  const guest = await lockGuest(client, booking.guest_id);
  const result = { points: 0, stamp: false, vouchers: [] };

  // 1) الختم وعدد الإقامات — مرة واحدة لكل حجز (قيد UNIQUE على booking_id)
  const stampGoal = program?.stamp_goal || 0;
  const n = guest.stamp_count + 1;
  const stampIns = await client.query(
    `INSERT INTO stamps (guest_id, booking_id, card_no) VALUES ($1,$2,$3) ON CONFLICT (booking_id) DO NOTHING RETURNING *`,
    [guest.id, booking.id, stampGoal > 0 ? Math.ceil(n / stampGoal) : 1],
  );
  if (stampIns.rowCount) {
    result.stamp = true;
    await client.query('UPDATE guests SET stamp_count = stamp_count + 1, completed_stays = completed_stays + 1 WHERE id = $1', [guest.id]);
    if (program && stampGoal > 0 && n % stampGoal === 0 && program.stamp_reward_id) {
      const cardNo = n / stampGoal;
      const { voucher } = await issueVoucher(client, {
        guestId: guest.id, rewardId: program.stamp_reward_id, source: 'stamp', sourceRef: `card:${cardNo}`, skipEligibility: true,
      });
      if (voucher) result.vouchers.push(voucher);
    }
  }

  // 2) النقاط — مفتاح منع التكرار + فهرس فريد على (booking_id) للاكتساب
  if (program) {
    const tier = guest.tier_id ? (await client.query('SELECT * FROM tiers WHERE id = $1', [guest.tier_id])).rows[0] : null;
    const { points, breakdown } = await computeEarnPoints(client, program, booking, tier);
    if (points > 0) {
      const expiresAt = program.points_expiry_months
        ? new Date(new Date().setMonth(new Date().getMonth() + program.points_expiry_months)) : null;
      const { entry, duplicate } = await postEntry(client, {
        guestId: guest.id, type: 'earn', points, bookingId: booking.id, expiresAt,
        idempotencyKey: `earn:booking:${booking.id}`, reason: `إقامة مكتملة — ${booking.unit_name} (${booking.booking_ref})`,
      });
      if (!duplicate) {
        result.points = points;
        result.breakdown = breakdown;
        const g2 = (await client.query('SELECT points_balance FROM guests WHERE id = $1', [guest.id])).rows[0];
        await notify(client, {
          guestId: guest.id, templateKey: 'points_earned', category: 'transactional',
          vars: { points, balance: g2.points_balance, unit_name: booking.unit_name }, link: '/account/points', dedupeKey: `earn:${entry.id}`,
        });
        await audit({ actorType: actor === 'system' ? 'system' : 'staff', action: 'points.earn', entity: 'booking', entityId: booking.id, data: { points, breakdown } }, client);
      }
    }
  }

  // 3) المستوى ثم الإحالة
  await recomputeTier(client, guest.id);
  const ref = await qualifyReferral(client, booking);
  if (ref) result.referral = ref;
  return result;
}

/**
 * عكس النقاط بعد استرداد (كلي أو جزئي) لحجز مكتمل.
 * يُعاد حساب المستحق على المبلغ المتبقي ويُسجل الفرق كقيد عكسي موثق — لا يُحذف أي قيد.
 */
export async function reconcileBookingPoints(client, bookingId, { reason }) {
  const booking = (await client.query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
  if (!booking?.guest_id) return { delta: 0 };
  const earn = (await client.query(`SELECT * FROM points_ledger WHERE booking_id = $1 AND entry_type = 'earn'`, [bookingId])).rows[0];
  if (!earn) return { delta: 0 };
  const current = (await client.query(
    `SELECT COALESCE(SUM(points),0)::int AS s FROM points_ledger WHERE booking_id = $1 AND entry_type IN ('earn','reverse')`, [bookingId],
  )).rows[0].s;
  let target = 0;
  if (booking.status !== 'refunded') {
    const paid = Number(booking.total_amount) - Number(booking.refunded_amount);
    const total = Number(booking.total_amount);
    target = total > 0 ? Math.floor(earn.points * (paid / total)) : 0; // تناسبي مع ما احتُسب فعليًا
  }
  const delta = target - current;
  if (delta >= 0) return { delta: 0 };
  const seq = (await client.query(`SELECT count(*)::int AS c FROM points_ledger WHERE booking_id = $1 AND entry_type = 'reverse'`, [bookingId])).rows[0].c;
  await postEntry(client, {
    guestId: booking.guest_id, type: 'reverse', points: delta, bookingId, relatedEntryId: earn.id,
    preferLotId: earn.id, allowNegative: true, idempotencyKey: `reverse:booking:${bookingId}:${seq + 1}`, reason,
  });
  return { delta };
}

/** إلغاء الختم وتحديث العدادات عند استرداد كامل لإقامة مكتملة */
export async function revokeStayForBooking(client, bookingId) {
  const stamp = (await client.query('UPDATE stamps SET revoked_at = now() WHERE booking_id = $1 AND revoked_at IS NULL RETURNING *', [bookingId])).rows[0];
  if (!stamp) return;
  const g = (await client.query(
    'UPDATE guests SET stamp_count = GREATEST(0, stamp_count - 1), completed_stays = GREATEST(0, completed_stays - 1) WHERE id = $1 RETURNING *',
    [stamp.guest_id],
  )).rows[0];
  // إذا كانت مكافأة بطاقة الأختام صدرت بسبب هذا الختم ولم تُستخدم بعد، تُلغى
  const program = await getActiveProgram(client);
  if (program?.stamp_goal) {
    const cards = (await client.query(
      `SELECT * FROM guest_rewards WHERE guest_id = $1 AND source = 'stamp' AND status = 'available'`, [g.id],
    )).rows;
    for (const v of cards) {
      const cardNo = Number(String(v.source_ref).split(':')[1]);
      if (g.stamp_count < cardNo * program.stamp_goal) await revokeVoucher(client, v.id, 'استرداد إقامة سابقة');
    }
  }
  await reverseReferralForBooking(client, bookingId);
  await recomputeTier(client, g.id);
}

/** تعديل إداري للرصيد مع سبب إلزامي وتسجيل في التدقيق */
export async function adjustPoints(client, { guestId, points, reason, staff, limit = null, ip = null }) {
  points = Math.trunc(Number(points));
  if (!points) throw new AppError('أدخل عدد نقاط صحيحًا (موجب للإضافة أو سالب للخصم)');
  if (!reason || reason.trim().length < 5) throw new AppError('سبب التعديل إلزامي (5 أحرف على الأقل)');
  if (limit != null && Math.abs(points) > limit) throw new AppError(`الحد الأقصى المسموح لصلاحيتك هو ${limit} نقطة في العملية`, { status: 403 });
  const program = await getActiveProgram(client);
  const expiresAt = points > 0 && program?.points_expiry_months
    ? new Date(new Date().setMonth(new Date().getMonth() + program.points_expiry_months)) : null;
  const { entry } = await postEntry(client, {
    guestId, type: 'adjust', points, reason: `تعديل إداري: ${reason.trim()}`, staffId: staff.id, expiresAt,
  });
  await audit({ actorType: 'staff', actorId: staff.id, action: 'points.adjust', entity: 'guest', entityId: guestId, data: { points, reason, entryId: entry.id }, ip }, client);
  await recomputeTier(client, guestId);
  return entry;
}

/** ملخص بطاقة الولاء للعرض */
export async function cardSummary(guestId, client = pool) {
  const g = (await client.query(
    `SELECT g.*, t.name AS tier_name, t.color AS tier_color, t.earn_multiplier, t.perks AS tier_perks
       FROM guests g LEFT JOIN tiers t ON t.id = g.tier_id WHERE g.id = $1`, [guestId],
  )).rows[0];
  if (!g) return null;
  const program = await getActiveProgram(client);
  const nextTier = program ? (await client.query(
    `SELECT * FROM tiers WHERE program_id = $1 AND sort_order > COALESCE((SELECT sort_order FROM tiers WHERE id = $2), -1)
      ORDER BY sort_order ASC LIMIT 1`, [program.id, g.tier_id],
  )).rows[0] : null;
  const vouchers = (await client.query(
    `SELECT gr.*, r.name, r.reward_type, r.value, r.description FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id
      WHERE gr.guest_id = $1 AND gr.status = 'available' AND (gr.expires_at IS NULL OR gr.expires_at > now())
      ORDER BY gr.expires_at ASC NULLS LAST`, [guestId],
  )).rows;
  const nextReward = (await client.query(
    `SELECT * FROM rewards WHERE active AND points_cost IS NOT NULL AND points_cost > $1
       AND (valid_until IS NULL OR valid_until >= current_date) ORDER BY points_cost ASC LIMIT 1`, [g.points_balance],
  )).rows[0];
  const expiring = (await client.query(
    `SELECT COALESCE(SUM(remaining),0)::int AS pts, MIN(expires_at) AS first_at FROM points_ledger
      WHERE guest_id = $1 AND remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() + interval '60 days'`, [guestId],
  )).rows[0];
  const stampGoal = program?.stamp_goal || 0;
  const stampsOnCard = stampGoal ? g.stamp_count % stampGoal : 0;
  const stampReward = program?.stamp_reward_id ? (await client.query('SELECT name FROM rewards WHERE id = $1', [program.stamp_reward_id])).rows[0] : null;
  return {
    guest: g, program, nextTier, vouchers, nextReward, expiring,
    stamps: { goal: stampGoal, onCard: stampsOnCard, rewardName: stampReward?.name || null },
    tierProgress: nextTier ? {
      staysNeeded: Math.max(0, nextTier.min_stays - g.completed_stays),
      pointsNeeded: Math.max(0, nextTier.min_points - g.lifetime_points),
      pct: Math.min(100, Math.round(100 * Math.min(
        nextTier.min_stays ? g.completed_stays / nextTier.min_stays : 1,
        nextTier.min_points ? g.lifetime_points / nextTier.min_points : 1,
      ))),
    } : null,
  };
}
