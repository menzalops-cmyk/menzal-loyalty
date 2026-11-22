import { Router } from 'express';
import { z } from 'zod';
import { tx } from '../db.js';
import { h, flash, createSession, destroySession, clientIp } from '../lib/web.js';
import { signup, loginWithPassword, sendVerificationCode, loginWithCode, verifyContact } from '../services/guests.js';
import { AppError } from '../lib/errors.js';

const r = Router();
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/account');

r.get('/signup', (req, res) => {
  if (req.guest) return res.redirect('/account');
  res.render('guest/signup', { title: 'إنشاء حساب', ref: req.cookies.mz_ref || req.query.ref || '', form: {} });
});

const SignupSchema = z.object({
  full_name: z.string().trim().min(2, 'أدخل الاسم الكامل').max(120),
  email: z.string().trim().email('البريد الإلكتروني غير صحيح').max(200),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  password: z.string().min(8, 'كلمة المرور يجب ألا تقل عن 8 أحرف').max(200),
  home_city: z.string().trim().max(80).optional().or(z.literal('')),
  referral_code: z.string().trim().max(16).optional().or(z.literal('')),
  consent_email_marketing: z.string().optional(),
  consent_whatsapp: z.string().optional(),
  consent_whatsapp_marketing: z.string().optional(),
  accept_terms: z.literal('on', { errorMap: () => ({ message: 'يجب الموافقة على الشروط وسياسة الخصوصية' }) }),
});

r.post('/signup', h(async (req, res) => {
  const p = SignupSchema.safeParse(req.body);
  if (!p.success) {
    return res.status(422).render('guest/signup', { title: 'إنشاء حساب', ref: req.body.referral_code || '', form: req.body, error: p.error.issues[0].message });
  }
  const d = p.data;
  let guest;
  try {
    guest = await tx((c) => signup(c, {
      fullName: d.full_name, email: d.email, phone: d.phone, password: d.password, homeCity: d.home_city,
      referralCode: d.referral_code || req.cookies.mz_ref, ip: clientIp(req),
      consents: { email_marketing: !!d.consent_email_marketing, whatsapp: !!d.consent_whatsapp, whatsapp_marketing: !!(d.consent_whatsapp && d.consent_whatsapp_marketing) },
    }));
  } catch (e) {
    if (e instanceof AppError) return res.status(422).render('guest/signup', { title: 'إنشاء حساب', ref: d.referral_code, form: req.body, error: e.message });
    throw e;
  }
  res.clearCookie('mz_ref');
  await createSession(res, 'guest', guest.id);
  const { devCode } = await sendVerificationCode({ guestId: guest.id, target: guest.email, channel: 'email' });
  res.redirect(`/verify${devCode ? `?dev=${devCode}` : ''}`);
}));

// تأكيد البريد/الجوال — يربط الحجوزات السابقة بالحساب
r.get('/verify', (req, res) => {
  if (!req.guest) return res.redirect('/login');
  res.render('guest/verify', { title: 'تأكيد الحساب', devCode: req.query.dev, channel: req.query.channel === 'phone' ? 'phone' : 'email' });
});
r.post('/verify/resend', h(async (req, res) => {
  if (!req.guest) return res.redirect('/login');
  const channel = req.body.channel === 'phone' ? 'phone' : 'email';
  const target = channel === 'email' ? req.guest.email : req.guest.phone;
  if (!target) { flash(res, 'error', 'لا يوجد رقم جوال في حسابك'); return res.redirect('/account/preferences'); }
  const { devCode } = await sendVerificationCode({ guestId: req.guest.id, target, channel });
  flash(res, 'success', 'أرسلنا رمزًا جديدًا');
  res.redirect(`/verify?channel=${channel}${devCode ? `&dev=${devCode}` : ''}`);
}));
r.post('/verify', h(async (req, res) => {
  if (!req.guest) return res.redirect('/login');
  const channel = req.body.channel === 'phone' ? 'phone' : 'email';
  const result = await tx((c) => verifyContact(c, { guestId: req.guest.id, channel, code: req.body.code }));
  flash(res, 'success', result.linked
    ? `تم التأكيد! وجدنا ${result.linked} حجزًا سابقًا وربطناه بحسابك${result.awarded ? ' وأضفنا نقاطها' : ''}.`
    : 'تم تأكيد حسابك بنجاح.');
  res.redirect('/account');
}));

r.get('/login', (req, res) => {
  if (req.guest) return res.redirect('/account');
  res.render('guest/login', { title: 'تسجيل الدخول', next: req.query.next || '', mode: req.query.mode === 'code' ? 'code' : 'password', email: req.query.email || '', devCode: req.query.dev });
});
r.post('/login', h(async (req, res) => {
  try {
    const g = await loginWithPassword({ email: req.body.email, password: req.body.password });
    await createSession(res, 'guest', g.id);
    res.redirect(g.email_verified_at ? safeNext(req.body.next) : '/verify');
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    res.status(401).render('guest/login', { title: 'تسجيل الدخول', next: req.body.next, mode: 'password', email: req.body.email, error: e.message });
  }
}));
// الدخول برمز يُرسل للبريد: مناسب للضيف الذي حجز سابقًا دون حساب أو نسي كلمة المرور
r.post('/login/code/send', h(async (req, res) => {
  const email = String(req.body.email || '').trim();
  let devCode;
  try { ({ devCode } = await sendVerificationCode({ target: email, channel: 'email' })); } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return res.render('guest/login', { title: 'تسجيل الدخول', mode: 'code', email, error: e.message, next: req.body.next });
  }
  res.render('guest/login', { title: 'تسجيل الدخول', mode: 'code', sent: true, email, devCode, next: req.body.next });
}));
r.post('/login/code', h(async (req, res) => {
  try {
    const g = await tx((c) => loginWithCode(c, { email: req.body.email, code: req.body.code }));
    await createSession(res, 'guest', g.id);
    res.redirect(safeNext(req.body.next));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    res.status(401).render('guest/login', { title: 'تسجيل الدخول', mode: 'code', sent: true, email: req.body.email, error: e.message, next: req.body.next });
  }
}));

r.post('/logout', h(async (req, res) => {
  await destroySession(req, res, 'guest');
  res.redirect('/');
}));
export default r;
