// الإحالات: ربط الضيف الجديد بمن أحاله، والتحقق من الحجز المكتمل، ومنع الإحالات الوهمية.
import { postEntry } from './ledger.js';
import { issueVoucher, revokeVoucher } from './rewards.js';
import { notify } from './notifications.js';
import { audit } from '../lib/audit.js';
import { pool } from '../db.js';

export async function getReferralRules(client = pool) {
  return (await client.query('SELECT * FROM referral_rules WHERE id = 1')).rows[0];
}

/**
 * تسجيل إحالة عند إنشاء حساب جديد عبر رابط إحالة.
 * يُرفض: الإحالة الذاتية، الضيف الذي سبق له الحجز (ليس صديقًا جديدًا)، والكود غير الصالح.
 */
export async function attachReferral(client, { referee, code }) {
  if (!code) return null;
  const referrer = (await client.query(`SELECT * FROM guests WHERE referral_code = $1 AND status = 'active'`, [String(code).toUpperCase()])).rows[0];
  if (!referrer || referrer.id === referee.id) return null;
  const sameContact = (referrer.email && referrer.email === referee.email) || (referrer.phone && referrer.phone === referee.phone);
  // ضيف سبق أن حجز بنفس البريد أو الجوال لا يُعد صديقًا جديدًا
  const prior = (await client.query(
    `SELECT count(*)::int AS c FROM bookings WHERE status <> 'cancelled' AND (
       (contact_email IS NOT NULL AND lower(contact_email) = $1) OR (contact_phone IS NOT NULL AND contact_phone = $2))`,
    [referee.email, referee.phone],
  )).rows[0].c;
  let status = 'pending';
  let rejectReason = null;
  if (sameContact) { status = 'rejected'; rejectReason = 'إحالة ذاتية'; }
  else if (prior > 0) { status = 'rejected'; rejectReason = 'الضيف لديه حجوزات سابقة'; }
  const r = (await client.query(
    `INSERT INTO referrals (referrer_id, referee_id, status, reject_reason) VALUES ($1,$2,$3,$4)
     ON CONFLICT (referee_id) DO NOTHING RETURNING *`,
    [referrer.id, referee.id, status, rejectReason],
  )).rows[0];
  return r || null;
}

/** عند اكتمال أول إقامة للضيف المُحال: مكافأة الطرفين وفق القواعد */
export async function qualifyReferral(client, booking) {
  const ref = (await client.query(
    `SELECT * FROM referrals WHERE referee_id = $1 AND status = 'pending' FOR UPDATE`, [booking.guest_id],
  )).rows[0];
  if (!ref) return null;
  const rules = await getReferralRules(client);
  if (!rules?.active) return null;
  if (Number(booking.total_amount) - Number(booking.refunded_amount || 0) < Number(rules.min_booking_amount)) return null;

  // حماية: جهة اتصال الحجز يجب ألا تطابق المُحيل
  const referrer = (await client.query('SELECT * FROM guests WHERE id = $1', [ref.referrer_id])).rows[0];
  const reject = async (reason) => {
    await client.query(`UPDATE referrals SET status = 'rejected', reject_reason = $2, booking_id = $3 WHERE id = $1`, [ref.id, reason, booking.id]);
    await audit({ actorType: 'system', action: 'referral.rejected', entity: 'referral', entityId: ref.id, data: { reason } }, client);
    return { id: ref.id, status: 'rejected', reason };
  };
  if ((booking.contact_email && referrer.email && booking.contact_email.toLowerCase() === referrer.email)
      || (booking.contact_phone && referrer.phone && booking.contact_phone === referrer.phone)) {
    return reject('بيانات الحجز تطابق صاحب رابط الإحالة');
  }
  const monthCount = (await client.query(
    `SELECT count(*)::int AS c FROM referrals WHERE referrer_id = $1 AND status = 'rewarded' AND rewarded_at >= date_trunc('month', now())`,
    [ref.referrer_id],
  )).rows[0].c;
  if (monthCount >= rules.max_per_referrer_month) return reject('تجاوز الحد الشهري للإحالات');

  await client.query(`UPDATE referrals SET status = 'rewarded', booking_id = $2, rewarded_at = now() WHERE id = $1`, [ref.id, booking.id]);
  if (rules.referrer_points > 0) {
    await postEntry(client, {
      guestId: ref.referrer_id, type: 'referral_bonus', points: rules.referrer_points, bookingId: booking.id,
      idempotencyKey: `referral:${ref.id}:referrer`, reason: 'مكافأة إحالة صديق ناجحة',
    });
  }
  if (rules.referrer_reward_id) {
    await issueVoucher(client, { guestId: ref.referrer_id, rewardId: rules.referrer_reward_id, source: 'referral', sourceRef: `referral:${ref.id}`, skipEligibility: true });
  }
  if (rules.referee_reward_id) {
    await issueVoucher(client, { guestId: ref.referee_id, rewardId: rules.referee_reward_id, source: 'referral', sourceRef: `referral:${ref.id}`, skipEligibility: true });
  }
  await notify(client, {
    guestId: ref.referrer_id, templateKey: 'referral_success', category: 'transactional',
    vars: { points: rules.referrer_points }, link: '/account/referrals', dedupeKey: `referral:${ref.id}`,
  });
  await audit({ actorType: 'system', action: 'referral.rewarded', entity: 'referral', entityId: ref.id, data: { bookingId: booking.id } }, client);
  return { id: ref.id, status: 'rewarded' };
}

/** إذا استُرد الحجز الذي حقق الإحالة: عكس نقاط المُحيل وإلغاء القسائم غير المستخدمة */
export async function reverseReferralForBooking(client, bookingId) {
  const ref = (await client.query(`SELECT * FROM referrals WHERE booking_id = $1 AND status = 'rewarded' FOR UPDATE`, [bookingId])).rows[0];
  if (!ref) return;
  await client.query(`UPDATE referrals SET status = 'rejected', reject_reason = 'استرداد الحجز المؤهل' WHERE id = $1`, [ref.id]);
  const bonus = (await client.query(`SELECT * FROM points_ledger WHERE idempotency_key = $1`, [`referral:${ref.id}:referrer`])).rows[0];
  if (bonus) {
    await postEntry(client, {
      guestId: ref.referrer_id, type: 'reverse', points: -bonus.points, relatedEntryId: bonus.id, preferLotId: bonus.id,
      allowNegative: true, idempotencyKey: `reverse:referral:${ref.id}`, reason: 'عكس مكافأة إحالة بعد استرداد الحجز',
    });
  }
  const vouchers = (await client.query(`SELECT id FROM guest_rewards WHERE source = 'referral' AND source_ref = $1`, [`referral:${ref.id}`])).rows;
  for (const v of vouchers) await revokeVoucher(client, v.id, 'استرداد الحجز المؤهل للإحالة');
}

export async function referralsForGuest(guestId, client = pool) {
  return (await client.query(
    `SELECT r.id, r.status, r.reject_reason, r.created_at, r.rewarded_at,
            split_part(g.full_name, ' ', 1) AS friend_first_name   -- لا نعرض بيانات الصديق الشخصية
       FROM referrals r JOIN guests g ON g.id = r.referee_id WHERE r.referrer_id = $1 ORDER BY r.created_at DESC`,
    [guestId],
  )).rows;
}
