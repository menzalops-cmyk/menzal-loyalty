import { getSettingSync } from '../services/settings.js';

const nf = new Intl.NumberFormat('ar-SA-u-nu-latn', { maximumFractionDigits: 2 });
export const num = (n) => nf.format(Number(n || 0));
export const money = (n) => `${nf.format(Number(n || 0))} ${getSettingSync('currency_symbol', 'ر.س')}`;
export function date(d) {
  if (!d) return '—';
  const v = typeof d === 'string' && d.length === 10 ? new Date(`${d}T00:00:00`) : new Date(d);
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { year: 'numeric', month: 'short', day: 'numeric' }).format(v);
}
export function dateTime(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
}
export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
export function addDays(d, days) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}
export const today = () => isoDate(new Date());

/** استبدال {{placeholders}} في نصوص الرسائل */
export function renderTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

export const normalizeEmail = (e) => (e ? String(e).trim().toLowerCase() : null);
/** توحيد رقم الجوال بصيغة دولية بدون + (مثال: 9665XXXXXXXX) */
export function normalizePhone(p) {
  if (!p) return null;
  let d = String(p).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('05') && d.length === 10) d = `966${d.slice(1)}`;
  if (d.startsWith('5') && d.length === 9) d = `966${d}`;
  return d.length >= 9 ? d : null;
}

export const LABELS = {
  booking: { pending: 'بانتظار التأكيد', confirmed: 'مؤكد', checked_in: 'مقيم حاليًا', completed: 'مكتملة', cancelled: 'ملغي', refunded: 'مسترد' },
  ledger: { earn: 'نقاط إقامة', redeem: 'استبدال', reverse: 'عكس نقاط', expire: 'انتهاء صلاحية', adjust: 'تعديل إداري', referral_bonus: 'مكافأة إحالة', campaign_bonus: 'نقاط حملة', restore: 'استرجاع نقاط' },
  rewardType: { percent_discount: 'خصم بنسبة مئوية', fixed_discount: 'خصم بمبلغ ثابت', free_upgrade: 'ترقية مجانية للوحدة', late_checkout: 'تسجيل خروج متأخر' },
  rewardCategory: { catalog: 'كتالوج النقاط', seasonal: 'عرض موسمي', repeat_guest: 'للضيوف المتكررين', referral: 'إحالة', stamp: 'بطاقة الأختام', campaign: 'حملة' },
  voucher: { available: 'متاحة', used: 'مستخدمة', expired: 'منتهية', revoked: 'ملغاة' },
  referral: { pending: 'بانتظار أول إقامة', rewarded: 'ناجحة', rejected: 'مرفوضة' },
  role: { admin: 'مدير النظام', manager: 'مدير الولاء', support: 'خدمة الضيوف', marketing: 'التسويق' },
  channel: { in_app: 'داخل النظام', email: 'البريد', whatsapp: 'واتساب' },
  campaign: { draft: 'مسودة', scheduled: 'مجدولة', sending: 'قيد الإرسال', sent: 'أُرسلت', cancelled: 'ملغاة' },
  notif: { queued: 'في الانتظار', sent: 'أُرسل', failed: 'فشل', skipped: 'تخطي' },
};
