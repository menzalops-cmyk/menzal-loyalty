// دخول الضيف وتسجيله برقم الجوال ورمز لمرة واحدة (بدون كلمة مرور).
import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db.js';
import { h, flash, createSession, destroySession, clientIp } from '../lib/web.js';
import { signup, sendVerificationCode, loginWithPhoneCode, verifyContact, guestByPhone } from '../services/guests.js';
import { normalizePhone } from '../lib/format.js';
import { AppError } from '../lib/errors.js';

const r = Router();
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/account');
const renderLogin = (res, opts, status = 200) => res.status(status).render('guest/login', { title: 'تسجيل الدخول', next: '', phone: '', sent: false, ...opts });

// ---------- إنشاء حساب ----------
r.get('/signup', (req, res) => {
  if (req.guest) return res.redirect('/account');
  res.render('guest/signup', { title: 'إنشاء حساب', ref: req.cookies.mz_ref || req.query.ref || '', form: { phone: req.query.phone || '' } });
});

const SignupSchema = z.object({
  full_name: z.string().trim().min(2, 'أدخل الاسم الكامل').max(120),
  phone: z.string().trim().min(9, 'أدخل رقم الجوال').max(30),
  email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(200).optional().or(z.literal('')),
  home_city: z.string().trim().max(80).optional().or(z.literal('')),
  referral_code: z.string().trim().max(16).optional().or(z.literal('')),
  consent_email_marketing: z.string().optional(),
  consent_whatsapp: z.string().optional(),
  consent_whatsapp_marketing: z.string().optional(),
  accept_terms: z.literal('on', { errorMap: () => ({ message: 'يجب الموافقة على الشروط وسياسة الخصوصية' }) }),
});

r.post('/signup', h(async (req, res) => {
  const fail = (error) => res.status(422).render('guest/signup', { title: 'إنشاء حساب', ref: req.body.referral_code || '', form: req.body, error });
  const p = SignupSchema.safeParse(req.body);
  if (!p.success) return fail(p.error.issues[0].message);
  const d = p.data;
  let guest;
  try {
    guest = await tx((c) => signup(c, {
      fullName: d.full_name, phone: d.phone, email: d.email, homeCity: d.home_city,
      referralCode: d.referral_code || req.cookies.mz_ref, ip: clientIp(req),
      consents: { email_marketing: !!(d.email && d.consent_email_marketing), whatsapp: !!d.consent_whatsapp, whatsapp_marketing: !!(d.consent_whatsapp && d.consent_whatsapp_marketing) },
    }));
  } catch (e) {
    if (e instanceof AppError) return fail(e.message);
    throw e;
  }
  res.clearCookie('mz_ref');
  try {
    const { devCode } = await sendVerificationCode({ guestId: guest.id, target: guest.phone, channel: 'phone' });
    renderLogin(res, { title: 'تأكيد رقم الجوال', phone: guest.phone, sent: true, devCode, signup: true });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    renderLogin(res, { phone: guest.phone, error: e.message }, 429);
  }
}));

// ---------- الدخول ----------
r.get('/login', (req, res) => {
  if (req.guest) return res.redirect('/account');
  renderLogin(res, { next: req.query.next || '' });
});

r.post('/login/code/send', h(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const next = req.body.next || '';
  if (!phone) return renderLogin(res, { next, phone: req.body.phone, error: 'أدخل رقم جوال صحيح، مثال: 05XXXXXXXX' }, 422);
  const g = await guestByPhone(phone);
  if (!g) {
    flash(res, 'error', 'لا يوجد حساب بهذا الرقم. أنشئ حسابك الآن — وإن كنت حجزت به سابقًا فسنربط حجوزاتك تلقائيًا.');
    return res.redirect(`/signup?phone=${encodeURIComponent(req.body.phone)}`);
  }
  try {
    const { devCode } = await sendVerificationCode({ guestId: g.id, target: phone, channel: 'phone' });
    renderLogin(res, { next, phone, sent: true, devCode });
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    renderLogin(res, { next, phone, error: e.message }, e.status || 400);
  }
}));

r.post('/login/code', h(async (req, res) => {
  try {
    const { guest, claim } = await tx((c) => loginWithPhoneCode(c, { phone: req.body.phone, code: req.body.code }));
    await createSession(res, 'guest', guest.id);
    if (claim.linked) {
      flash(res, 'success', `أهلًا بك! وجدنا ${claim.linked} حجزًا سابقًا برقمك وربطناه بحسابك${claim.awarded ? ' وأضفنا نقاطه' : ''}.`);
    }
    res.redirect(safeNext(req.body.next));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    renderLogin(res, { next: req.body.next, phone: normalizePhone(req.body.phone) || req.body.phone, sent: true, error: e.message, signup: req.body.signup === '1' }, 401);
  }
}));

// ---------- تأكيد البريد الاختياري (من التفضيلات) ----------
r.get('/verify', (req, res) => {
  if (!req.guest) return res.redirect('/login');
  if (!req.guest.email) return res.redirect('/account/preferences');
  res.render('guest/verify', { title: 'تأكيد البريد', devCode: req.query.dev });
});
r.post('/verify/resend', h(async (req, res) => {
  if (!req.guest) return res.redirect('/login');
  if (!req.guest.email) { flash(res, 'error', 'أضف بريدك الإلكتروني أولًا'); return res.redirect('/account/preferences'); }
  const { devCode } = await sendVerificationCode({ guestId: req.guest.id, target: req.guest.email, channel: 'email' });
  res.redirect(`/verify${devCode ? `?dev=${devCode}` : ''}`);
}));
r.post('/verify', h(async (req, res) => {
  if (!req.guest) return res.redirect('/login');
  const result = await tx((c) => verifyContact(c, { guestId: req.guest.id, channel: 'email', code: req.body.code }));
  flash(res, 'success', result.linked ? `تم تأكيد بريدك وربط ${result.linked} حجزًا سابقًا به.` : 'تم تأكيد بريدك الإلكتروني.');
  res.redirect('/account/preferences');
}));

r.post('/logout', h(async (req, res) => {
  await destroySession(req, res, 'guest');
  res.redirect('/');
}));
export default r;
