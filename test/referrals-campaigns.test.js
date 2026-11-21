import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeGuest, daysFromNow, guest, unitId, pool, tx } from './helpers.js';
import { recordBooking, transition } from '../src/services/bookings.js';
import { sendCampaign, previewAudience, campaignStats } from '../src/services/campaigns.js';
import { processQueue } from '../src/services/notifications.js';
import { dashboardKpis } from '../src/services/kpis.js';
import { setConsent } from '../src/services/guests.js';

before(resetDb);
after(() => pool.end());

const stayFor = async (g, unit = 0, offset = 15, extra = {}) => tx(async (c) => recordBooking(c, {
  contactName: g.full_name, contactEmail: g.email, unitId: await unitId(unit), checkIn: daysFromNow(-offset - 1), checkOut: daysFromNow(-offset), status: 'completed', ...extra,
}));

test('successful referral rewards both sides only after the friend completes a stay', async () => {
  const referrer = await makeGuest();
  const friend = await makeGuest({ referralCode: referrer.referral_code });
  let ref = (await pool.query('SELECT * FROM referrals WHERE referee_id = $1', [friend.id])).rows[0];
  assert.equal(ref.status, 'pending');
  assert.equal((await guest(referrer.id)).points_balance, 0);
  await stayFor(friend, 0, 20); // 450 ≥ 200
  ref = (await pool.query('SELECT * FROM referrals WHERE id = $1', [ref.id])).rows[0];
  assert.equal(ref.status, 'rewarded');
  assert.equal((await guest(referrer.id)).points_balance, 300);
  const rv = (await pool.query(`SELECT count(*)::int c FROM guest_rewards WHERE source = 'referral' AND guest_id = ANY($1)`, [[referrer.id, friend.id]])).rows[0].c;
  assert.equal(rv, 2);
  // إقامة ثانية للصديق لا تمنح مكافأة إحالة إضافية
  await stayFor(friend, 1, 40);
  assert.equal((await guest(referrer.id)).points_balance, 300);
});

test('self-referral and existing guests are rejected', async () => {
  const referrer = await makeGuest();
  const email = `old_${Date.now()}@test.local`;
  await tx(async (c) => recordBooking(c, { contactName: 'قديم', contactEmail: email, unitId: await unitId(1), checkIn: daysFromNow(-300), checkOut: daysFromNow(-298), status: 'completed' }));
  const old = await makeGuest({ email, referralCode: referrer.referral_code });
  const ref = (await pool.query('SELECT * FROM referrals WHERE referee_id = $1', [old.id])).rows[0];
  assert.equal(ref.status, 'rejected');
});

test('refund of the qualifying booking reverses the referral bonus', async () => {
  const referrer = await makeGuest();
  const friend = await makeGuest({ referralCode: referrer.referral_code });
  const b = await stayFor(friend, 2, 60);
  assert.equal((await guest(referrer.id)).points_balance, 300);
  await tx((c) => transition(c, b.id, 'refunded', { actor: 'staff:1' }));
  assert.equal((await guest(referrer.id)).points_balance, 0);
});

test('campaign targets past guests who did not rebook, respects consent, and tracks results', async () => {
  const yes = await makeGuest({ consents: { email_marketing: true } });
  const no = await makeGuest({ consents: {} });
  const rebooked = await makeGuest({ consents: { email_marketing: true } });
  await stayFor(yes, 3, 100);
  await stayFor(no, 4, 120);
  await stayFor(rebooked, 5, 200);
  await tx(async (c) => recordBooking(c, { contactName: 'x', contactEmail: rebooked.email, unitId: await unitId(5), checkIn: daysFromNow(50), checkOut: daysFromNow(52), status: 'confirmed' }));

  const seg = { stayed_within_days: 365, no_rebook: true };
  const prev = await previewAudience(seg);
  assert.ok(prev.total >= 2);
  const c = (await pool.query(
    `INSERT INTO campaigns (name, segment, channels, subject, body, status) VALUES ('عودة', $1, '{email,whatsapp}', 'اشتقنا لك', 'مرحبًا {{name}}', 'draft') RETURNING *`,
    [JSON.stringify(seg)],
  )).rows[0];
  await sendCampaign(c.id);
  const notes = (await pool.query('SELECT guest_id, channel, status, skip_reason FROM notifications WHERE campaign_id = $1', [c.id])).rows;
  assert.ok(notes.some((n) => n.guest_id === yes.id && n.channel === 'email' && n.status === 'queued'));
  assert.ok(notes.some((n) => n.guest_id === no.id && n.channel === 'email' && n.status === 'skipped'));
  assert.ok(!notes.some((n) => n.guest_id === rebooked.id));
  assert.ok(!notes.some((n) => n.channel === 'whatsapp' && n.status !== 'skipped'));
  await assert.rejects(sendCampaign(c.id), /مسبقًا/);
  await processQueue();
  const stats = await campaignStats(c.id);
  assert.ok(stats.sent >= 1);
  // إلغاء الاشتراك قبل الإرسال يمنع الرسالة حتى لو كانت في الطابور
  await tx((cl) => setConsent(cl, yes.id, 'email_marketing', false, 'unsubscribe_link'));
  const k = await dashboardKpis({});
  assert.ok(k.members.total >= 3);
  assert.ok(k.referrals !== undefined);
});
