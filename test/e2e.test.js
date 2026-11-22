// اختبار شامل عبر HTTP لمعايير نجاح المشروع
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { resetDb, daysFromNow, pool } from './helpers.js';
import { createApp } from '../src/server.js';
import { processQueue } from '../src/services/notifications.js';
import { config } from '../src/config.js';

let app;
before(async () => { await resetDb(); app = createApp(); });
after(() => pool.end());

async function client() {
  const agent = request.agent(app);
  const r = await agent.get('/login');
  const csrf = /mz_csrf=([^;]+)/.exec(r.headers['set-cookie'].join(';'))[1];
  return { agent, csrf };
}
const ok = (r) => { assert.ok([200, 302].includes(r.status), `HTTP ${r.status} ${r.text?.slice(0, 300)}`); return r; };
const flashOf = (r) => { const m = /mz_flash=([^;]+)/.exec((r.headers['set-cookie'] || []).join(';')); return m ? JSON.parse(Buffer.from(m[1], 'base64url').toString()) : null; };

test('full journey: signup → stay → points → card → reward → redeem → rebook → campaign → referral → dashboard', async () => {
  const admin = await client();
  ok(await admin.agent.post('/admin/login').type('form').send({ _csrf: admin.csrf, email: 'admin@test.local', password: 'Admin@12345' }));

  // 1) إنشاء حساب ضيف + التحقق
  const g = await client();
  let r = await g.agent.post('/signup').type('form').send({ _csrf: g.csrf, full_name: 'نورة العتيبي', email: 'noura@test.local', phone: '0551112222', password: 'Password123', accept_terms: 'on', consent_email_marketing: 'on' });
  assert.equal(r.status, 302);
  const dev = /dev=(\d{6})/.exec(r.headers.location)[1];
  r = ok(await g.agent.post('/verify').type('form').send({ _csrf: g.csrf, channel: 'email', code: dev }));
  const guest = (await pool.query(`SELECT * FROM guests WHERE email = 'noura@test.local'`)).rows[0];
  assert.ok(guest.email_verified_at);

  // 2) تسجيل إقامة مكتملة من الإدارة → 3) منح النقاط تلقائيًا
  const unit = (await pool.query('SELECT * FROM units ORDER BY id LIMIT 1')).rows[0];
  r = ok(await admin.agent.post('/admin/bookings').type('form').send({ _csrf: admin.csrf, contact_name: 'نورة', contact_email: 'noura@test.local', unit_id: unit.id, check_in: daysFromNow(-5), check_out: daysFromNow(-3), status: 'completed' }));
  let gg = (await pool.query('SELECT * FROM guests WHERE id = $1', [guest.id])).rows[0];
  assert.equal(gg.points_balance, 950);
  assert.equal(gg.completed_stays, 1);

  // 4) عرض بطاقة الولاء
  r = ok(await g.agent.get('/account/card'));
  assert.match(r.text, /950/);
  assert.match(r.text, new RegExp(guest.member_no));
  const pub = ok(await request(app).get(`/card/${guest.card_token}`));
  assert.doesNotMatch(pub.text, /noura@test\.local/);

  // 5) إنشاء مكافأة من لوحة الإدارة
  r = ok(await admin.agent.post('/admin/rewards').type('form').send({ _csrf: admin.csrf, name: 'خصم الشتاء 100', reward_type: 'fixed_discount', category: 'seasonal', value: 100, points_cost: 900, min_booking_amount: 300, voucher_validity_days: 60, active: 'on' }));
  const reward = (await pool.query(`SELECT * FROM rewards WHERE name = 'خصم الشتاء 100'`)).rows[0];
  assert.ok(reward);

  // 6) استبدال النقاط بالمكافأة (مع حماية النقر المزدوج)
  r = ok(await g.agent.post(`/account/rewards/${reward.id}/redeem`).type('form').send({ _csrf: g.csrf, request_id: 'abc123' }));
  ok(await g.agent.post(`/account/rewards/${reward.id}/redeem`).type('form').send({ _csrf: g.csrf, request_id: 'abc123' }));
  gg = (await pool.query('SELECT * FROM guests WHERE id = $1', [guest.id])).rows[0];
  assert.equal(gg.points_balance, 50);
  const voucher = (await pool.query('SELECT * FROM guest_rewards WHERE guest_id = $1 AND reward_id = $2', [guest.id, reward.id])).rows[0];

  // 7) استخدام المكافأة في حجز جديد (إعادة الحجز)
  ok(await g.agent.get('/account/rebook'));
  r = ok(await g.agent.get(`/account/book/${unit.id}?check_in=${daysFromNow(20)}&check_out=${daysFromNow(22)}&guests=2&voucher_id=${voucher.id}`));
  assert.match(r.text, /خصم المكافأة/);
  r = await g.agent.post(`/account/book/${unit.id}`).type('form').send({ _csrf: g.csrf, check_in: daysFromNow(20), check_out: daysFromNow(22), guests: 2, voucher_id: voucher.id });
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /\/account\/bookings\/MZ/);
  const nb = (await pool.query('SELECT * FROM bookings WHERE guest_id = $1 ORDER BY id DESC LIMIT 1', [guest.id])).rows[0];
  assert.equal(Number(nb.discount_amount), 100);
  // 8) تتبع الحجوزات المتكررة
  assert.equal(nb.is_repeat, true);
  ok(await g.agent.get(r.headers.location));

  // ضيف آخر لا يرى الحجز
  const other = await client();
  await other.agent.post('/signup').type('form').send({ _csrf: other.csrf, full_name: 'خالد', email: 'khaled@test.local', password: 'Password123', accept_terms: 'on' });
  assert.equal((await other.agent.get(`/account/bookings/${nb.booking_ref}`)).status, 404);

  // 9) حملة تسويقية تجريبية
  r = ok(await admin.agent.post('/admin/campaigns').type('form').send({ _csrf: admin.csrf, name: 'عرض العودة', stayed_within_days: 365, channels: 'email', subject: 'اشتقنا لك', body: 'مرحبًا {{name}}، رصيدك {{balance}}' }));
  const camp = (await pool.query(`SELECT * FROM campaigns WHERE name = 'عرض العودة'`)).rows[0];
  ok(await admin.agent.post(`/admin/campaigns/${camp.id}/test`).type('form').send({ _csrf: admin.csrf, test_guest: 'noura@test.local' }));
  ok(await admin.agent.post(`/admin/campaigns/${camp.id}/send`).type('form').send({ _csrf: admin.csrf }));
  await processQueue();
  const n = (await pool.query(`SELECT * FROM notifications WHERE campaign_id = $1 AND channel = 'email'`, [camp.id])).rows[0];
  assert.equal(n.status, 'sent');
  // نقر على رابط الحملة → حجز منسوب للحملة
  r = await g.agent.get(`/t/${n.tracking_token}`);
  assert.equal(r.status, 302);
  const unit2 = (await pool.query('SELECT * FROM units ORDER BY id OFFSET 1 LIMIT 1')).rows[0];
  await g.agent.post(`/account/book/${unit2.id}`).type('form').send({ _csrf: g.csrf, check_in: daysFromNow(40), check_out: daysFromNow(41), guests: 1 });
  const cb = (await pool.query('SELECT * FROM bookings WHERE guest_id = $1 ORDER BY id DESC LIMIT 1', [guest.id])).rows[0];
  assert.equal(cb.campaign_id, camp.id);
  r = ok(await admin.agent.get(`/admin/campaigns/${camp.id}`));

  // 10) تتبع إحالة ناجحة
  const f = await client();
  await f.agent.get(`/r/${guest.referral_code}`);
  r = await f.agent.post('/signup').type('form').send({ _csrf: f.csrf, full_name: 'سارة', email: 'sara@test.local', password: 'Password123', accept_terms: 'on' });
  const sara = (await pool.query(`SELECT * FROM guests WHERE email = 'sara@test.local'`)).rows[0];
  const ref = (await pool.query('SELECT * FROM referrals WHERE referee_id = $1', [sara.id])).rows[0];
  assert.equal(ref.referrer_id, guest.id);
  await pool.query('UPDATE guests SET email_verified_at = now() WHERE id = $1', [sara.id]);
  ok(await admin.agent.post('/admin/bookings').type('form').send({ _csrf: admin.csrf, contact_name: 'سارة', contact_email: 'sara@test.local', unit_id: unit2.id, check_in: daysFromNow(-10), check_out: daysFromNow(-8), status: 'completed' }));
  assert.equal((await pool.query('SELECT status FROM referrals WHERE id = $1', [ref.id])).rows[0].status, 'rewarded');
  r = ok(await g.agent.get('/account/referrals'));
  assert.match(r.text, /ناجحة/);
  assert.doesNotMatch(r.text, /sara@test\.local/);

  // 11) النتائج في لوحة التحكم
  r = ok(await admin.agent.get('/admin'));
  assert.match(r.text, /الإحالات الناجحة/);

  // كل صفحات الضيف والإدارة تُعرض دون أخطاء
  for (const p of ['/account', '/account/points', '/account/rewards', '/account/bookings', '/account/referrals', '/account/notifications', '/account/preferences', '/account/card']) ok(await g.agent.get(p));
  const gid = guest.id; const bid = nb.id;
  for (const p of ['/admin?days=30', '/admin/guests', `/admin/guests/${gid}`, '/admin/guests?segment=repeat', '/admin/bookings', '/admin/bookings/new', `/admin/bookings/${bid}`, '/admin/units', `/admin/units?edit=${unit.id}`, '/admin/loyalty', '/admin/loyalty?program=new', '/admin/rewards', `/admin/rewards/${reward.id}`, '/admin/rewards/new', '/admin/referrals', '/admin/campaigns', '/admin/campaigns/new', '/admin/messages', '/admin/notifications', '/admin/staff', '/admin/audit', '/admin/integrations']) {
    const res = await admin.agent.get(p);
    assert.equal(res.status, 200, `${p} → ${res.status} ${res.text.slice(0, 400)}`);
  }
});

test('security: CSRF, guest cannot reach admin, role limits, webhook signature', async () => {
  const g = await client();
  assert.equal((await g.agent.post('/signup').type('form').send({ full_name: 'x' })).status, 403);
  assert.equal((await g.agent.get('/admin/guests')).status, 302);
  assert.equal((await request(app).get('/account')).status, 302);

  // دور التسويق لا يعدّل النقاط
  const admin = await client();
  await admin.agent.post('/admin/login').type('form').send({ _csrf: admin.csrf, email: 'admin@test.local', password: 'Admin@12345' });
  await admin.agent.post('/admin/staff').type('form').send({ _csrf: admin.csrf, name: 'مسوق', email: 'mkt@test.local', role: 'marketing', password: 'Marketing@123' });
  const m = await client();
  await m.agent.post('/admin/login').type('form').send({ _csrf: m.csrf, email: 'mkt@test.local', password: 'Marketing@123' });
  const gid = (await pool.query('SELECT id FROM guests LIMIT 1')).rows[0].id;
  const balBefore = (await pool.query('SELECT points_balance FROM guests WHERE id = $1', [gid])).rows[0].points_balance;
  const denied = await m.agent.post(`/admin/guests/${gid}/adjust`).type('form').send({ _csrf: m.csrf, points: 100, reason: 'محاولة غير مصرح' });
  assert.match(flashOf(denied)?.message || '', /صلاحية/);
  assert.equal((await pool.query('SELECT points_balance FROM guests WHERE id = $1', [gid])).rows[0].points_balance, balBefore);
  const page = await m.agent.get(`/admin/guests/${gid}`);
  assert.match(page.text, /مخفي حسب الصلاحية/);

  // Webhook
  const body = JSON.stringify({ event_id: 'evt-1', booking: { external_ref: 'PMS-1', status: 'completed', unit_id: 5, check_in: daysFromNow(-4), check_out: daysFromNow(-2), total_amount: 900, guest: { name: 'عميل', email: 'noura@test.local' } } });
  assert.equal((await request(app).post('/api/integrations/bookings').set('content-type', 'application/json').set('x-menzal-signature', 'sha256=bad').send(body)).status, 401);
  config.bookingWebhookSecret = 'test-secret';
  const sig = `sha256=${crypto.createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  const before = (await pool.query(`SELECT points_balance FROM guests WHERE email = 'noura@test.local'`)).rows[0].points_balance;
  let r = await request(app).post('/api/integrations/bookings').set('content-type', 'application/json').set('x-menzal-signature', sig).send(body);
  assert.equal(r.status, 200, r.text);
  r = await request(app).post('/api/integrations/bookings').set('content-type', 'application/json').set('x-menzal-signature', sig).send(body);
  assert.equal(r.body.duplicate, true);
  const afterPts = (await pool.query(`SELECT points_balance FROM guests WHERE email = 'noura@test.local'`)).rows[0].points_balance;
  assert.equal(afterPts - before, 950);
});

test('unsubscribe link stops marketing', async () => {
  const g = (await pool.query(`SELECT * FROM guests WHERE email = 'noura@test.local'`)).rows[0];
  assert.equal(g.consent_email_marketing, true);
  const r = await request(app).post(`/unsubscribe/${g.unsubscribe_token}`);
  assert.equal(r.status, 200);
  assert.equal((await pool.query('SELECT consent_email_marketing FROM guests WHERE id = $1', [g.id])).rows[0].consent_email_marketing, false);
});
