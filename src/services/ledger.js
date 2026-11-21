// محرك سجل النقاط: كل تغيير على الرصيد يمر من هنا فقط، داخل معاملة، مع قفل صف الضيف.
import { AppError } from '../lib/errors.js';

const EARNING_TYPES = new Set(['earn', 'referral_bonus', 'campaign_bonus', 'restore']);

export async function lockGuest(client, guestId) {
  const g = (await client.query('SELECT * FROM guests WHERE id = $1 FOR UPDATE', [guestId])).rows[0];
  if (!g) throw new AppError('الضيف غير موجود', { status: 404 });
  return g;
}

/**
 * إضافة قيد في سجل النقاط.
 * - idempotencyKey: إذا سبق تسجيله تُعاد العملية السابقة دون تكرار.
 * - القيود السالبة تستهلك الدفعات الموجبة بنظام FIFO (الأقرب انتهاءً أولًا) لدعم انتهاء الصلاحية بدقة.
 * - preferLotId: دفعة تُستهلك أولًا (مثل عكس نقاط حجز معين).
 * - allowNegative: السماح بأن يصبح الرصيد سالبًا (عكس نقاط بعد استرداد، لا يُسمح به للاستبدال).
 */
export async function postEntry(client, {
  guestId, type, points, reason, bookingId = null, guestRewardId = null, relatedEntryId = null,
  idempotencyKey = null, expiresAt = null, staffId = null, preferLotId = null, allowNegative = false, onlyLotId = null,
}) {
  points = Math.trunc(points);
  if (!points) return { entry: null, duplicate: false, skipped: true };
  const guest = await lockGuest(client, guestId);

  if (idempotencyKey) {
    const existing = (await client.query('SELECT * FROM points_ledger WHERE idempotency_key = $1', [idempotencyKey])).rows[0];
    if (existing) return { entry: existing, duplicate: true };
  }

  const balance = guest.points_balance;
  let remaining = 0;

  if (points > 0) {
    // إذا كان على الضيف رصيد سالب (دين من عكس سابق) يُسدد أولًا
    const debt = Math.max(0, -balance);
    remaining = Math.max(0, points - debt);
  } else {
    const need = -points;
    if (!allowNegative && balance < need) {
      throw new AppError('رصيد النقاط غير كافٍ لإتمام العملية', { code: 'insufficient_points' });
    }
    let left = need;
    const lots = (await client.query(
      `SELECT id, remaining FROM points_ledger
        WHERE guest_id = $1 AND remaining > 0 ${onlyLotId ? 'AND id = $2' : ''}
        ORDER BY ${preferLotId ? `(id = ${Number(preferLotId)}) DESC,` : ''} expires_at ASC NULLS LAST, id ASC
        FOR UPDATE`,
      onlyLotId ? [guestId, onlyLotId] : [guestId],
    )).rows;
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, lot.remaining);
      await client.query('UPDATE points_ledger SET remaining = remaining - $1 WHERE id = $2', [take, lot.id]);
      left -= take;
    }
  }

  const balanceAfter = balance + points;
  const entry = (await client.query(
    `INSERT INTO points_ledger
       (guest_id, entry_type, points, balance_after, remaining, booking_id, guest_reward_id, related_entry_id,
        idempotency_key, reason, expires_at, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [guestId, type, points, balanceAfter, remaining, bookingId, guestRewardId, relatedEntryId,
      idempotencyKey, reason, points > 0 ? expiresAt : null, staffId],
  )).rows[0];

  // النقاط مدى الحياة (لتحديد المستوى) تزيد بالاكتساب وتنقص بعكس الاكتساب فقط
  let lifetimeDelta = 0;
  if (EARNING_TYPES.has(type)) lifetimeDelta = points;
  if (type === 'reverse') lifetimeDelta = points;
  if (type === 'adjust') lifetimeDelta = points > 0 ? points : 0;

  await client.query(
    'UPDATE guests SET points_balance = $2, lifetime_points = GREATEST(0, lifetime_points + $3) WHERE id = $1',
    [guestId, balanceAfter, lifetimeDelta],
  );
  return { entry, duplicate: false };
}

/** انتهاء صلاحية الدفعات المنتهية لضيف معين أو للجميع */
export async function expireDueLots(client, { guestId = null, now = new Date() } = {}) {
  const lots = (await client.query(
    `SELECT id, guest_id, remaining, expires_at FROM points_ledger
      WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= $1 ${guestId ? 'AND guest_id = $2' : ''}
      ORDER BY guest_id, id`,
    guestId ? [now, guestId] : [now],
  )).rows;
  const expired = [];
  for (const lot of lots) {
    const { entry, duplicate } = await postEntry(client, {
      guestId: lot.guest_id, type: 'expire', points: -lot.remaining, onlyLotId: lot.id, allowNegative: true,
      relatedEntryId: lot.id, idempotencyKey: `expire:lot:${lot.id}`, reason: 'انتهاء صلاحية النقاط',
    });
    if (entry && !duplicate) expired.push(entry);
  }
  return expired;
}

/** التحقق من تطابق الرصيد المخزن مع مجموع السجل (يستخدم في الاختبارات والمراجعة) */
export async function verifyBalance(client, guestId) {
  const r = (await client.query(
    `SELECT g.points_balance, COALESCE(SUM(l.points),0)::int AS ledger_sum
       FROM guests g LEFT JOIN points_ledger l ON l.guest_id = g.id WHERE g.id = $1 GROUP BY g.id`,
    [guestId],
  )).rows[0];
  return { stored: r.points_balance, ledger: r.ledger_sum, ok: r.points_balance === r.ledger_sum };
}
