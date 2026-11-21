// الحجوزات: إنشاء الحجز (إعادة الحجز من حساب الضيف أو من الإدارة أو من منصة خارجية)،
// دورة الحالات، والربط التلقائي بنظام الولاء عند الاكتمال/الإلغاء/الاسترداد.
import { AppError } from '../lib/errors.js';
import { randomCode } from '../lib/crypto.js';
import { normalizeEmail, normalizePhone, today } from '../lib/format.js';
import { lockVoucherForBooking, restoreVoucherFromBooking } from './rewards.js';
import { processCompletedBooking, reconcileBookingPoints, revokeStayForBooking } from './loyalty.js';
import { notify } from './notifications.js';
import { getSettingSync } from './settings.js';
import { audit } from '../lib/audit.js';
import { pool } from '../db.js';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'checked_in', 'completed'];
const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'completed', 'cancelled'],
  checked_in: ['completed', 'cancelled'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

const nightsBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** تسعير الحجز مع تطبيق المكافأة (للعرض قبل التأكيد) */
export async function quote(client, { guestId, unitId, checkIn, checkOut, voucherId }) {
  const unit = (await client.query('SELECT * FROM units WHERE id = $1 AND active', [unitId])).rows[0];
  if (!unit) throw new AppError('الوحدة غير متاحة', { status: 404 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn || '') || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut || '')) throw new AppError('اختر تاريخي الوصول والمغادرة');
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) throw new AppError('تاريخ المغادرة يجب أن يكون بعد تاريخ الوصول');
  if (nights > 60) throw new AppError('الحد الأقصى للحجز 60 ليلة');
  const subtotal = Math.round(nights * Number(unit.nightly_price) * 100) / 100;
  let discount = 0; let perk = null; let voucher = null;
  if (voucherId) {
    const v = await lockVoucherForBooking(client, { guestId, voucherId, unitId, checkIn, subtotal });
    discount = v.discount; perk = v.perk; voucher = v.voucher;
  }
  return { unit, nights, subtotal, discount, total: Math.max(0, Math.round((subtotal - discount) * 100) / 100), perk, voucher };
}

async function assertAvailable(client, unitId, checkIn, checkOut, excludeId = null) {
  await client.query('SELECT id FROM units WHERE id = $1 FOR UPDATE', [unitId]); // تسلسل الحجوزات على نفس الوحدة
  const clash = (await client.query(
    `SELECT id FROM bookings WHERE unit_id = $1 AND status = ANY($4) AND check_in < $3 AND check_out > $2 ${excludeId ? 'AND id <> $5' : ''} LIMIT 1`,
    excludeId ? [unitId, checkIn, checkOut, ACTIVE_STATUSES, excludeId] : [unitId, checkIn, checkOut, ACTIVE_STATUSES],
  )).rows[0];
  if (clash) throw new AppError('الوحدة غير متاحة في هذه التواريخ، جرّب تواريخ أخرى أو وحدة مشابهة', { code: 'unavailable' });
}

async function newRef(client) {
  for (;;) {
    const ref = `MZ${randomCode(6)}`;
    const e = (await client.query('SELECT 1 FROM bookings WHERE booking_ref = $1', [ref])).rows[0];
    if (!e) return ref;
  }
}

/**
 * إنشاء حجز جديد لضيف مسجل (إعادة الحجز). القسيمة تُقفل وتُستهلك في نفس المعاملة لمنع الاستخدام المزدوج.
 */
export async function createGuestBooking(client, { guestId, unitId, checkIn, checkOut, guestsCount = 1, voucherId = null, campaignId = null, notes = null }) {
  const guest = (await client.query('SELECT * FROM guests WHERE id = $1 FOR UPDATE', [guestId])).rows[0];
  if (!guest || guest.status !== 'active') throw new AppError('الحساب غير نشط', { status: 403 });
  if (checkIn < today()) throw new AppError('لا يمكن الحجز بتاريخ سابق');
  const q = await quote(client, { guestId, unitId, checkIn, checkOut, voucherId });
  if (guestsCount > q.unit.capacity) throw new AppError(`السعة القصوى لهذه الوحدة ${q.unit.capacity} أشخاص`);
  await assertAvailable(client, unitId, checkIn, checkOut);

  // إسناد الحملة: من رابط الحملة، أو من قسيمة صادرة عن حملة
  let attributedCampaign = campaignId;
  if (!attributedCampaign && q.voucher?.source === 'campaign') attributedCampaign = Number(q.voucher.source_ref) || null;
  const referral = (await client.query(
    `SELECT g.referral_code FROM referrals r JOIN guests g ON g.id = r.referrer_id WHERE r.referee_id = $1 AND r.status = 'pending'`, [guestId],
  )).rows[0];

  const booking = (await client.query(
    `INSERT INTO bookings (booking_ref, source, guest_id, contact_name, contact_email, contact_phone, unit_id, check_in, check_out,
                           guests_count, subtotal_amount, discount_amount, total_amount, status, perks, is_repeat, referral_code, campaign_id, notes)
     VALUES ($1,'menzal',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15,$16,$17) RETURNING *`,
    [await newRef(client), guestId, guest.full_name, guest.email, guest.phone, unitId, checkIn, checkOut, guestsCount,
      q.subtotal, q.discount, q.total, q.perk ? [q.perk] : [], guest.completed_stays > 0, referral?.referral_code || null,
      attributedCampaign, notes],
  )).rows[0];

  if (q.voucher) {
    const u = await client.query(
      `UPDATE guest_rewards SET status = 'used', used_at = now(), used_booking_id = $2, discount_applied = $3
        WHERE id = $1 AND status = 'available' RETURNING id`, [q.voucher.id, booking.id, q.discount],
    );
    if (!u.rowCount) throw new AppError('هذه المكافأة مستخدمة مسبقًا');
  }
  await client.query(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, actor, note) VALUES ($1,NULL,'pending',$2,$3)`,
    [booking.id, `guest:${guestId}`, q.voucher ? `مكافأة مطبقة ${q.voucher.code}` : null],
  );
  await notify(client, {
    guestId, templateKey: 'booking_received', category: 'transactional',
    vars: { booking_ref: booking.booking_ref, unit_name: q.unit.name, check_in: checkIn, check_out: checkOut },
    link: `/account/bookings/${booking.booking_ref}`, dedupeKey: `booking:${booking.id}:received`,
  });
  await audit({ actorType: 'guest', actorId: guestId, action: 'booking.create', entity: 'booking', entityId: booking.id, data: { voucherId, total: q.total } }, client);
  return { booking, quote: q };
}

/**
 * تسجيل حجز من الإدارة أو من منصة خارجية (قد لا يملك الضيف حسابًا بعد).
 * يُربط تلقائيًا بحساب موجود فقط إذا كانت جهة الاتصال موثقة في ذلك الحساب.
 */
export async function recordBooking(client, data, { actor = 'staff', source = 'menzal' } = {}) {
  const email = normalizeEmail(data.contactEmail);
  const phone = normalizePhone(data.contactPhone);
  if (!email && !phone) throw new AppError('أدخل البريد الإلكتروني أو رقم الجوال للضيف');
  const unit = (await client.query('SELECT * FROM units WHERE id = $1', [data.unitId])).rows[0];
  if (!unit) throw new AppError('الوحدة غير موجودة', { status: 404 });
  const nights = nightsBetween(data.checkIn, data.checkOut);
  if (!(nights >= 1)) throw new AppError('تواريخ الحجز غير صحيحة');
  if (data.status !== 'cancelled') await assertAvailable(client, unit.id, data.checkIn, data.checkOut);
  const subtotal = data.subtotal != null ? Number(data.subtotal) : nights * Number(unit.nightly_price);
  const discount = Number(data.discount || 0);
  const total = data.total != null ? Number(data.total) : Math.max(0, subtotal - discount);

  const guest = (await client.query(
    `SELECT * FROM guests WHERE (email = $1 AND email_verified_at IS NOT NULL) OR (phone = $2 AND phone_verified_at IS NOT NULL) LIMIT 1`,
    [email, phone],
  )).rows[0];
  const booking = (await client.query(
    `INSERT INTO bookings (booking_ref, source, external_ref, guest_id, contact_name, contact_email, contact_phone, unit_id, check_in, check_out,
                           guests_count, subtotal_amount, discount_amount, total_amount, status, is_repeat, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16) RETURNING *`,
    [await newRef(client), source, data.externalRef || null, guest?.id || null, data.contactName, email, phone, unit.id,
      data.checkIn, data.checkOut, data.guestsCount || 1, subtotal, discount, total, Boolean(guest && guest.completed_stays > 0), data.notes || null],
  )).rows[0];
  await client.query(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, actor) VALUES ($1,NULL,'pending',$2)`, [booking.id, actor],
  );
  let result = booking;
  const PATHS = { confirmed: ['confirmed'], checked_in: ['confirmed', 'checked_in'], completed: ['confirmed', 'completed'], cancelled: ['cancelled'] };
  for (const step of PATHS[data.status] || []) {
    result = await transition(client, booking.id, step, { actor, force: data.forceComplete, note: 'تسجيل أولي' });
  }
  return result;
}

/**
 * تغيير حالة الحجز. هذه النقطة الوحيدة التي تربط الحجوزات بنظام الولاء:
 * - completed → منح النقاط والختم (بعد التحقق من مرور تاريخ المغادرة)
 * - cancelled → استرجاع القسيمة المستخدمة
 * - refunded (كلي/جزئي) → عكس النقاط بقيد موثق وإلغاء الختم عند الاسترداد الكامل
 */
export async function transition(client, bookingId, to, { actor = 'staff', note = null, refundAmount = null, force = false } = {}) {
  const b = (await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
  if (!b) throw new AppError('الحجز غير موجود', { status: 404 });

  // استرداد جزئي على حجز مكتمل يبقى بحالة completed
  if (to === 'partial_refund') {
    if (b.status !== 'completed') throw new AppError('الاسترداد الجزئي متاح للحجوزات المكتملة فقط');
    const amt = Number(refundAmount);
    const remaining = Number(b.total_amount) - Number(b.refunded_amount);
    if (!(amt > 0) || amt > remaining) throw new AppError(`مبلغ الاسترداد يجب أن يكون بين 0 و ${remaining}`);
    if (amt === remaining) return transition(client, bookingId, 'refunded', { actor, note });
    await client.query('UPDATE bookings SET refunded_amount = refunded_amount + $2, updated_at = now() WHERE id = $1', [bookingId, amt]);
    await client.query(`INSERT INTO booking_status_history (booking_id, from_status, to_status, actor, note) VALUES ($1,$2,$2,$3,$4)`,
      [bookingId, b.status, actor, `استرداد جزئي ${amt}${note ? ` — ${note}` : ''}`]);
    await reconcileBookingPoints(client, bookingId, { reason: `تصحيح نقاط بعد استرداد جزئي (${b.booking_ref})` });
    return (await client.query('SELECT * FROM bookings WHERE id = $1', [bookingId])).rows[0];
  }

  if (b.status === to) return b;
  if (!TRANSITIONS[b.status]?.includes(to)) {
    throw new AppError(`لا يمكن نقل الحجز من «${b.status}» إلى «${to}»`, { code: 'invalid_transition' });
  }
  if (to === 'completed' && getSettingSync('require_checkout_passed', true) && b.check_out > today() && !force) {
    throw new AppError('لا يمكن إكمال الإقامة قبل تاريخ المغادرة');
  }
  const sets = ['status = $2', 'updated_at = now()'];
  if (to === 'completed') sets.push('completed_at = now()');
  if (to === 'cancelled') sets.push('cancelled_at = now()');
  if (to === 'refunded') sets.push('refunded_amount = total_amount');
  const updated = (await client.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [bookingId, to])).rows[0];
  await client.query(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, actor, note) VALUES ($1,$2,$3,$4,$5)`,
    [bookingId, b.status, to, actor, note],
  );

  if (to === 'completed') {
    await processCompletedBooking(client, bookingId, { actor });
  } else if (to === 'cancelled') {
    const v = await restoreVoucherFromBooking(client, bookingId);
    if (b.guest_id) {
      await notify(client, {
        guestId: b.guest_id, templateKey: 'booking_cancelled', category: 'transactional',
        vars: { booking_ref: b.booking_ref, voucher_note: v ? 'تمت إعادة مكافأتك إلى حسابك.' : '' },
        link: '/account/bookings', dedupeKey: `booking:${b.id}:cancelled`,
      });
    }
  } else if (to === 'refunded') {
    await reconcileBookingPoints(client, bookingId, { reason: `عكس نقاط بعد استرداد كامل (${b.booking_ref})` });
    await revokeStayForBooking(client, bookingId);
  } else if (to === 'confirmed' && b.guest_id) {
    await notify(client, {
      guestId: b.guest_id, templateKey: 'booking_confirmed', category: 'transactional',
      vars: { booking_ref: b.booking_ref, check_in: b.check_in }, link: `/account/bookings/${b.booking_ref}`,
      dedupeKey: `booking:${b.id}:confirmed`,
    });
  }
  await audit({ actorType: actor.startsWith('staff') ? 'staff' : actor.startsWith('integration') ? 'integration' : 'system', action: `booking.${to}`, entity: 'booking', entityId: bookingId, data: { from: b.status, note, refundAmount } }, client);
  return updated;
}

/**
 * ربط الحجوزات السابقة (بدون حساب) بحساب الضيف بعد التحقق من البريد أو الجوال،
 * ثم احتساب نقاط الإقامات المكتملة ضمن نافذة المطالبة.
 */
export async function claimBookingsForGuest(client, guestId) {
  const g = (await client.query('SELECT * FROM guests WHERE id = $1', [guestId])).rows[0];
  const email = g.email_verified_at ? g.email : null;
  const phone = g.phone_verified_at ? g.phone : null;
  if (!email && !phone) return { linked: 0, awarded: 0 };
  const linked = (await client.query(
    `UPDATE bookings SET guest_id = $1, updated_at = now()
      WHERE guest_id IS NULL AND ((contact_email IS NOT NULL AND lower(contact_email) = $2) OR (contact_phone IS NOT NULL AND contact_phone = $3))
      RETURNING id, status, completed_at, check_out`,
    [guestId, email, phone],
  )).rows;
  const program = (await client.query('SELECT claim_window_days FROM loyalty_programs WHERE active LIMIT 1')).rows[0];
  const windowDays = program?.claim_window_days ?? 365;
  let awarded = 0;
  const completed = linked.filter((b) => b.status === 'completed').sort((a, b) => String(a.check_out).localeCompare(String(b.check_out)));
  for (const b of completed) {
    const within = (Date.now() - new Date(b.completed_at || b.check_out).getTime()) / 86400000 <= windowDays;
    if (within) { await processCompletedBooking(client, b.id, { actor: 'system' }); awarded++; }
  }
  if (linked.length) {
    await audit({ actorType: 'guest', actorId: guestId, action: 'bookings.claim', entity: 'guest', entityId: guestId, data: { linked: linked.map((b) => b.id), awarded } }, client);
  }
  return { linked: linked.length, awarded };
}

/** الوحدات التي أقام فيها الضيف + المقترحات المشابهة */
export async function rebookSuggestions(guestId, client = pool) {
  const stayed = (await client.query(
    `SELECT u.*, max(b.check_out) AS last_stay, count(*)::int AS stays
       FROM bookings b JOIN units u ON u.id = b.unit_id
      WHERE b.guest_id = $1 AND b.status = 'completed' AND u.active
      GROUP BY u.id ORDER BY max(b.check_out) DESC`, [guestId],
  )).rows;
  let similar;
  if (stayed.length) {
    const cities = [...new Set(stayed.map((u) => u.city))];
    const types = [...new Set(stayed.map((u) => u.unit_type))];
    const avg = stayed.reduce((s, u) => s + Number(u.nightly_price), 0) / stayed.length;
    similar = (await client.query(
      `SELECT u.*, ((u.city = ANY($2))::int * 2 + (u.unit_type = ANY($3))::int
                    + (u.nightly_price BETWEEN $4 * 0.7 AND $4 * 1.3)::int) AS score
         FROM units u WHERE u.active AND NOT (u.id = ANY($1))
        ORDER BY score DESC, u.nightly_price ASC LIMIT 6`,
      [stayed.map((u) => u.id), cities, types, avg],
    )).rows;
  } else {
    similar = (await client.query('SELECT * FROM units WHERE active ORDER BY nightly_price ASC LIMIT 6')).rows;
  }
  return { stayed, similar };
}
