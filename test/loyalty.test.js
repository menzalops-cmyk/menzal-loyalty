import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeGuest, daysFromNow, guest, unitId, pool, tx } from './helpers.js';
import { recordBooking, transition, createGuestBooking, claimBookingsForGuest } from '../src/services/bookings.js';
import { processCompletedBooking, adjustPoints } from '../src/services/loyalty.js';
import { redeemPoints } from '../src/services/rewards.js';
import { verifyBalance, expireDueLots, postEntry } from '../src/services/ledger.js';
import { verifyContact, sendVerificationCode } from '../src/services/guests.js';

before(resetDb);
after(() => pool.end());


async function stay(g, opts = {}) {
  const u = await unitId(opts.unit ?? 0);
  const nights = opts.nights ?? 2;
  const offset = opts.offset ?? 10 + Math.floor(Math.random() * 300);
  return tx((c) => recordBooking(c, {
    contactName: g.full_name, contactEmail: g.email, contactPhone: opts.phone, unitId: u,
    checkIn: daysFromNow(-offset - nights), checkOut: daysFromNow(-offset), status: opts.status ?? 'completed', total: opts.total,
  }));
}

test('points are awarded once after a completed stay (450×2=900 paid → 900 + 50 per stay)', async () => {
  const g = await makeGuest();
  const b = await stay(g, { nights: 2 });
  assert.equal(b.status, 'completed');
  const g2 = await guest(g.id);
  assert.equal(g2.points_balance, 950);
  assert.equal(g2.completed_stays, 1);
  // إعادة المعالجة لا تضيف شيئًا
  await tx((c) => processCompletedBooking(c, b.id));
  await tx((c) => processCompletedBooking(c, b.id));
  assert.equal((await guest(g.id)).points_balance, 950);
  const earns = (await pool.query(`SELECT count(*)::int c FROM points_ledger WHERE booking_id = $1 AND entry_type='earn'`, [b.id])).rows[0].c;
  assert.equal(earns, 1);
  assert.ok((await tx((c) => verifyBalance(c, g.id))).ok);
});

test('no points before completion; cannot complete before checkout date', async () => {
  const g = await makeGuest();
  const u = await unitId(1);
  const b = await tx((c) => recordBooking(c, { contactName: g.full_name, contactEmail: g.email, unitId: u, checkIn: daysFromNow(5), checkOut: daysFromNow(7), status: 'confirmed' }));
  assert.equal((await guest(g.id)).points_balance, 0);
  await assert.rejects(tx((c) => transition(c, b.id, 'completed', { actor: 'staff:1' })), /قبل تاريخ المغادرة/);
  assert.equal((await guest(g.id)).points_balance, 0);
});

test('stamp card: after 2 completed stays the guest gets the stamp reward voucher (once)', async () => {
  const g = await makeGuest();
  await stay(g, { unit: 1, offset: 100 });
  let v = (await pool.query(`SELECT * FROM guest_rewards WHERE guest_id = $1 AND source = 'stamp'`, [g.id])).rows;
  assert.equal(v.length, 0);
  await stay(g, { unit: 1, offset: 50 });
  v = (await pool.query(`SELECT * FROM guest_rewards WHERE guest_id = $1 AND source = 'stamp'`, [g.id])).rows;
  assert.equal(v.length, 1);
  assert.equal((await guest(g.id)).stamp_count, 2);
});

test('redeem points for a reward, then use it on a new booking exactly once', async () => {
  const g = await makeGuest();
  await stay(g, { unit: 2, nights: 1 }); // 1400 + 50 = 1450
  const before = (await guest(g.id)).points_balance;
  assert.equal(before, 1450);
  const reward = (await pool.query(`SELECT * FROM rewards WHERE name = 'خصم 50 ريال'`)).rows[0];
  const { voucher } = await tx((c) => redeemPoints(c, { guestId: g.id, rewardId: reward.id, requestId: 'req-1' }));
  // نفس الطلب مرتين (نقر مزدوج) لا يخصم مرتين
  const again = await tx((c) => redeemPoints(c, { guestId: g.id, rewardId: reward.id, requestId: 'req-1' }));
  assert.equal(again.duplicate, true);
  assert.equal((await guest(g.id)).points_balance, before - 1000);

  const u = await unitId(0);
  const { booking } = await tx((c) => createGuestBooking(c, { guestId: g.id, unitId: u, checkIn: daysFromNow(30), checkOut: daysFromNow(32), voucherId: voucher.id }));
  assert.equal(Number(booking.discount_amount), 50);
  assert.equal(Number(booking.total_amount), 850);
  assert.equal(booking.is_repeat, true);
  // استخدام نفس القسيمة مرة أخرى مرفوض
  await assert.rejects(tx((c) => createGuestBooking(c, { guestId: g.id, unitId: u, checkIn: daysFromNow(40), checkOut: daysFromNow(41), voucherId: voucher.id })), /مستخدمة/);
  // الإلغاء يعيد القسيمة
  await tx((c) => transition(c, booking.id, 'cancelled', { actor: 'staff:1' }));
  const v2 = (await pool.query('SELECT status FROM guest_rewards WHERE id = $1', [voucher.id])).rows[0];
  assert.equal(v2.status, 'available');
  assert.ok((await tx((c) => verifyBalance(c, g.id))).ok);
});

test('insufficient points and other guest vouchers are rejected', async () => {
  const g = await makeGuest();
  const other = await makeGuest();
  const reward = (await pool.query(`SELECT * FROM rewards WHERE name = 'خصم 10%'`)).rows[0];
  await assert.rejects(tx((c) => redeemPoints(c, { guestId: g.id, rewardId: reward.id, requestId: 'x' })), /غير كافٍ/);
  await tx((c) => adjustPoints(c, { guestId: other.id, points: 2000, reason: 'تعويض تجريبي', staff: { id: 1 } }));
  const { voucher } = await tx((c) => redeemPoints(c, { guestId: other.id, rewardId: reward.id, requestId: 'y' }));
  await assert.rejects(tx((c) => createGuestBooking(c, { guestId: g.id, unitId: 1, checkIn: daysFromNow(60), checkOut: daysFromNow(62), voucherId: voucher.id })), /غير موجودة/);
});

test('expired voucher cannot be used', async () => {
  const g = await makeGuest();
  await tx((c) => adjustPoints(c, { guestId: g.id, points: 1000, reason: 'رصيد اختبار', staff: { id: 1 } }));
  const reward = (await pool.query(`SELECT * FROM rewards WHERE name = 'خصم 50 ريال'`)).rows[0];
  const { voucher } = await tx((c) => redeemPoints(c, { guestId: g.id, rewardId: reward.id, requestId: 'exp' }));
  await pool.query(`UPDATE guest_rewards SET expires_at = now() - interval '1 day' WHERE id = $1`, [voucher.id]);
  await assert.rejects(tx((c) => createGuestBooking(c, { guestId: g.id, unitId: 1, checkIn: daysFromNow(70), checkOut: daysFromNow(72), voucherId: voucher.id })), /انتهت صلاحية/);
});

test('full refund after completion reverses points with a documented entry (no deletion)', async () => {
  const g = await makeGuest();
  const b = await stay(g, { unit: 3, nights: 2 }); // 1040 + 50
  assert.equal((await guest(g.id)).points_balance, 1090);
  await tx((c) => transition(c, b.id, 'refunded', { actor: 'staff:1' }));
  const g2 = await guest(g.id);
  assert.equal(g2.points_balance, 0);
  assert.equal(g2.completed_stays, 0);
  const rows = (await pool.query('SELECT entry_type, points FROM points_ledger WHERE booking_id = $1 ORDER BY id', [b.id])).rows;
  assert.deepEqual(rows.map((r) => r.entry_type), ['earn', 'reverse']);
  await assert.rejects(pool.query('DELETE FROM points_ledger WHERE booking_id = $1', [b.id]), /append-only/);
  await assert.rejects(pool.query('UPDATE points_ledger SET points = 1 WHERE booking_id = $1', [b.id]), /immutable/);
});

test('partial refund reverses points proportionally', async () => {
  const g = await makeGuest();
  const b = await stay(g, { unit: 3, nights: 2, total: 1000 }); // 1000 + 50 = 1050
  assert.equal((await guest(g.id)).points_balance, 1050);
  await tx((c) => transition(c, b.id, 'partial_refund', { refundAmount: 500, actor: 'staff:1' }));
  assert.equal((await guest(g.id)).points_balance, 525);
});

test('points expire FIFO with an expire entry', async () => {
  const g = await makeGuest();
  await tx((c) => postEntry(c, { guestId: g.id, type: 'adjust', points: 300, reason: 'دفعة قديمة', expiresAt: new Date(Date.now() - 1000) }));
  await tx((c) => postEntry(c, { guestId: g.id, type: 'adjust', points: 200, reason: 'دفعة حديثة', expiresAt: new Date(Date.now() + 86400000 * 300) }));
  await tx((c) => expireDueLots(c, { guestId: g.id }));
  await tx((c) => expireDueLots(c, { guestId: g.id })); // لا تكرار
  assert.equal((await guest(g.id)).points_balance, 200);
});

test('support staff adjustment limit and mandatory reason', async () => {
  const g = await makeGuest();
  await assert.rejects(tx((c) => adjustPoints(c, { guestId: g.id, points: 100, reason: '', staff: { id: 1 } })), /سبب/);
  await assert.rejects(tx((c) => adjustPoints(c, { guestId: g.id, points: 900, reason: 'تعويض كبير', staff: { id: 1 }, limit: 500 })), /الحد الأقصى/);
  const audit = (await pool.query(`SELECT count(*)::int c FROM audit_log WHERE action = 'points.adjust'`)).rows[0].c;
  assert.ok(audit >= 1);
});

test('bookings made without an account are linked and awarded after contact verification', async () => {
  const email = `walkin_${Date.now()}@test.local`;
  const u = await unitId(4);
  const b = await tx((c) => recordBooking(c, { contactName: 'سارة', contactEmail: email, unitId: u, checkIn: daysFromNow(-20), checkOut: daysFromNow(-18), status: 'completed' }));
  assert.equal(b.guest_id, null);
  const g = await makeGuest({ email, verified: false });
  assert.equal((await guest(g.id)).points_balance, 0); // غير موثق → لا ربط
  const { devCode } = await sendVerificationCode({ guestId: g.id, target: email, channel: 'email' });
  const res = await tx((c) => verifyContact(c, { guestId: g.id, channel: 'email', code: devCode }));
  assert.equal(res.linked, 1);
  assert.equal((await guest(g.id)).points_balance, 650);
  // تكرار الربط لا يضيف نقاطًا
  await tx((c) => claimBookingsForGuest(c, g.id));
  assert.equal((await guest(g.id)).points_balance, 650);
});

test('double booking of the same unit is prevented', async () => {
  const g = await makeGuest();
  const u = await unitId(5);
  await tx((c) => createGuestBooking(c, { guestId: g.id, unitId: u, checkIn: daysFromNow(100), checkOut: daysFromNow(103) }));
  await assert.rejects(tx((c) => createGuestBooking(c, { guestId: g.id, unitId: u, checkIn: daysFromNow(101), checkOut: daysFromNow(102) })), /غير متاحة/);
});
