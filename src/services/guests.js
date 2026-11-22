// حسابات الضيوف: التسجيل، التحقق من البريد/الجوال برمز، تسجيل الدخول، الموافقات.
import { AppError } from '../lib/errors.js';
import { randomCode, randomDigits, hmac } from '../lib/crypto.js';
import { normalizeEmail, normalizePhone } from '../lib/format.js';
import { attachReferral } from './referrals.js';
import { claimBookingsForGuest } from './bookings.js';
import { recomputeTier } from './loyalty.js';
import { notify } from './notifications.js';
import { sendEmail, emailConfigured } from '../providers/email.js';
import { sendWhatsAppTemplate, whatsappConfigured } from '../providers/whatsapp.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { pool } from '../db.js';

async function newMemberNo(client) {
  for (;;) {
    const no = `MZ-${randomDigits(7)}`;
    if (!(await client.query('SELECT 1 FROM guests WHERE member_no = $1', [no])).rowCount) return no;
  }
}
async function newReferralCode(client, name) {
  for (;;) {
    const code = randomCode(7);
    if (!(await client.query('SELECT 1 FROM guests WHERE referral_code = $1', [code])).rowCount) return code;
  }
}

export async function setConsent(client, guestId, channel, granted, source) {
  const col = { email_marketing: 'consent_email_marketing', whatsapp: 'consent_whatsapp', whatsapp_marketing: 'consent_whatsapp_marketing' }[channel];
  if (!col) throw new AppError('قناة غير معروفة');
  const cur = (await client.query(`SELECT ${col} AS v FROM guests WHERE id = $1`, [guestId])).rows[0];
  if (cur.v === granted) return;
  await client.query(`UPDATE guests SET ${col} = $2 WHERE id = $1`, [guestId, granted]);
  // إلغاء موافقة واتساب العامة يلغي التسويقية أيضًا
  if (channel === 'whatsapp' && !granted) await setConsent(client, guestId, 'whatsapp_marketing', false, source);
  await client.query('INSERT INTO consent_log (guest_id, channel, granted, source) VALUES ($1,$2,$3,$4)', [guestId, channel, granted, source]);
}

/**
 * تسجيل ضيف جديد. رقم الجوال هو المعرف الأساسي (الحجوزات تُسجل به)، والبريد اختياري.
 * الحساب لا يُفعّل إلا بعد إدخال الرمز المرسل للجوال (loginWithPhoneCode).
 * إذا وُجد تسجيل سابق غير مؤكد بنفس الرقم تُحدّث بياناته ويُعاد إرسال الرمز.
 */
export async function signup(client, { fullName, email, phone, homeCity, referralCode, consents = {}, ip }) {
  email = normalizeEmail(email);
  phone = normalizePhone(phone);
  if (!fullName || fullName.trim().length < 2) throw new AppError('أدخل الاسم الكامل');
  if (!phone) throw new AppError('أدخل رقم جوال صحيح، مثال: 05XXXXXXXX');
  const byPhone = (await client.query('SELECT * FROM guests WHERE phone = $1 FOR UPDATE', [phone])).rows[0];
  if (byPhone?.phone_verified_at) throw new AppError('هذا الرقم مسجل مسبقًا. سجّل الدخول برقم جوالك', { code: 'exists' });
  if (email) {
    const byEmail = (await client.query('SELECT id FROM guests WHERE email = $1 AND id <> $2', [email, byPhone?.id ?? 0])).rows[0];
    if (byEmail) throw new AppError('البريد الإلكتروني مستخدم في حساب آخر');
  }
  let guest;
  if (byPhone) {
    guest = (await client.query(
      `UPDATE guests SET full_name = $2, email = $3, home_city = $4, email_verified_at = NULL WHERE id = $1 RETURNING *`,
      [byPhone.id, fullName.trim(), email, homeCity || null],
    )).rows[0];
  } else {
    guest = (await client.query(
      `INSERT INTO guests (member_no, full_name, email, phone, home_city, referral_code, signup_ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [await newMemberNo(client), fullName.trim(), email, phone, homeCity || null, await newReferralCode(client), ip ? hmac(ip) : null],
    )).rows[0];
    await recomputeTier(client, guest.id);
    await notify(client, {
      guestId: guest.id, templateKey: 'welcome', category: 'transactional', channels: ['in_app'],
      vars: { referral_code: guest.referral_code }, link: '/account', dedupeKey: 'welcome',
    });
    await audit({ actorType: 'guest', actorId: guest.id, action: 'guest.signup', entity: 'guest', entityId: guest.id, data: { referral: Boolean(referralCode) } }, client);
  }
  for (const [ch, v] of Object.entries(consents)) await setConsent(client, guest.id, ch, Boolean(v), 'signup');
  if (referralCode) await attachReferral(client, { referee: guest, code: referralCode });
  return guest;
}

/** إرسال رمز تحقق (تفعيل الحساب أو الدخول بدون كلمة مرور) */
export async function sendVerificationCode({ guestId = null, target, channel }) {
  const t = channel === 'email' ? normalizeEmail(target) : normalizePhone(target);
  if (!t) throw new AppError('بيانات التواصل غير صحيحة');
  const recent = (await pool.query(
    `SELECT count(*)::int AS c FROM verification_codes WHERE target = $1 AND created_at > now() - interval '15 minutes'`, [t],
  )).rows[0].c;
  if (recent >= 5) throw new AppError('تم إرسال رموز كثيرة، حاول بعد 15 دقيقة', { status: 429 });
  const code = randomDigits(6);
  await pool.query(
    `INSERT INTO verification_codes (guest_id, target, channel, code_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '15 minutes')`,
    [guestId, t, channel, hmac(`${t}:${code}`)],
  );
  const msg = `رمز التحقق الخاص بك في منزال: ${code}\nصالح لمدة 15 دقيقة. لا تشاركه مع أحد.`;
  if (channel === 'email') {
    await sendEmail({ to: t, subject: 'رمز التحقق — منزال', text: msg, html: `<div dir="rtl" style="font-family:Tahoma">${msg.replace('\n', '<br>')}</div>` });
  } else {
    await sendWhatsAppTemplate({ to: t, templateName: 'menzal_otp', params: [code], fallbackText: msg });
  }
  // في التطوير أو وضع التجربة فقط، وعندما لا يكون مزود القناة مُعدًا: يُعاد الرمز لعرضه على الشاشة
  const providerReady = channel === 'email' ? emailConfigured() : whatsappConfigured();
  return { target: t, devCode: (!config.isProd || config.demoMode) && !providerReady ? code : undefined };
}

async function consumeCode(client, target, code) {
  const row = (await client.query(
    `SELECT * FROM verification_codes WHERE target = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY id DESC LIMIT 1 FOR UPDATE`, [target],
  )).rows[0];
  if (!row) throw new AppError('الرمز منتهي أو غير موجود، اطلب رمزًا جديدًا');
  if (row.attempts >= 5) throw new AppError('تجاوزت عدد المحاولات، اطلب رمزًا جديدًا', { status: 429 });
  if (row.code_hash !== hmac(`${target}:${String(code).trim()}`)) {
    await client.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw new AppError('الرمز غير صحيح');
  }
  await client.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  return row;
}

/** تأكيد البريد/الجوال ثم ربط الحجوزات السابقة بالحساب */
export async function verifyContact(client, { guestId, channel, code }) {
  const g = (await client.query('SELECT * FROM guests WHERE id = $1 FOR UPDATE', [guestId])).rows[0];
  const target = channel === 'email' ? g.email : g.phone;
  if (!target) throw new AppError('لا توجد بيانات تواصل لتأكيدها');
  await consumeCode(client, target, code);
  await client.query(`UPDATE guests SET ${channel === 'email' ? 'email_verified_at' : 'phone_verified_at'} = COALESCE(${channel === 'email' ? 'email_verified_at' : 'phone_verified_at'}, now()) WHERE id = $1`, [guestId]);
  return claimBookingsForGuest(client, guestId);
}

/**
 * الدخول (أو تفعيل حساب جديد) برقم الجوال ورمز لمرة واحدة.
 * إدخال الرمز الصحيح يثبت ملكية الرقم، فيُؤكد الرقم وتُربط الحجوزات السابقة المسجلة به.
 */
export async function loginWithPhoneCode(client, { phone, code }) {
  const p = normalizePhone(phone);
  if (!p) throw new AppError('رقم الجوال غير صحيح');
  await consumeCode(client, p, code);
  const g = (await client.query('SELECT * FROM guests WHERE phone = $1 FOR UPDATE', [p])).rows[0];
  if (!g) throw new AppError('لا يوجد حساب بهذا الرقم. أنشئ حسابًا جديدًا');
  if (g.status !== 'active') throw new AppError('الحساب موقوف، تواصل مع منزال', { status: 403 });
  let claim = { linked: 0, awarded: 0 };
  if (!g.phone_verified_at) {
    await client.query('UPDATE guests SET phone_verified_at = now() WHERE id = $1', [g.id]);
    claim = await claimBookingsForGuest(client, g.id);
  }
  return { guest: g, claim, firstLogin: !g.phone_verified_at };
}

/** هل يوجد حساب بهذا الرقم؟ (لتوجيه المستخدم للدخول أو التسجيل) */
export async function guestByPhone(phone) {
  const p = normalizePhone(phone);
  return p ? (await pool.query('SELECT id, status FROM guests WHERE phone = $1', [p])).rows[0] || null : null;
}
