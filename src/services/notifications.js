// الإشعارات: إنشاء الرسائل مع احترام الموافقات، وطابور إرسال يعالجه العامل الخلفي.
import { pool } from '../db.js';
import { config } from '../config.js';
import { renderTemplate, LABELS } from '../lib/format.js';
import { sendEmail, emailConfigured } from '../providers/email.js';
import { sendWhatsAppTemplate, whatsappConfigured } from '../providers/whatsapp.js';
import { getSettingSync } from './settings.js';

/**
 * هل يُسمح بإرسال رسالة لهذا الضيف عبر هذه القناة؟
 * - داخل النظام: دائمًا.
 * - البريد: المعاملات تتطلب بريدًا موجودًا؛ التسويق يتطلب موافقة صريحة.
 * - واتساب: أي رسالة تتطلب موافقة واتساب؛ التسويق يتطلب موافقة تسويقية إضافية.
 */
export function consentCheck(guest, channel, category) {
  if (guest.status !== 'active') return 'الحساب موقوف';
  if (channel === 'in_app') return null;
  if (channel === 'email') {
    if (!guest.email) return 'لا يوجد بريد إلكتروني';
    if (category === 'marketing' && !guest.consent_email_marketing) return 'لا توجد موافقة تسويقية على البريد';
    return null;
  }
  if (channel === 'whatsapp') {
    if (!guest.phone) return 'لا يوجد رقم جوال';
    if (!guest.consent_whatsapp) return 'لا توجد موافقة على واتساب';
    if (category === 'marketing' && !guest.consent_whatsapp_marketing) return 'لا توجد موافقة تسويقية على واتساب';
    return null;
  }
  return 'قناة غير معروفة';
}

const firstName = (n) => String(n || '').split(' ')[0];

/**
 * إنشاء إشعار (أو عدة إشعارات حسب القنوات).
 * القنوات الافتراضية: داخل النظام + البريد + واتساب (كل قناة تخضع لفحص الموافقة).
 * dedupeKey يمنع إرسال نفس الرسالة مرتين لنفس الضيف والقناة.
 */
export async function notify(client, {
  guestId, templateKey = null, subject = null, body = null, vars = {}, category = 'transactional',
  channels = ['in_app', 'email', 'whatsapp'], link = null, dedupeKey = null, campaignId = null, scheduledAt = null,
  recordSkipped = false,
}) {
  const guest = (await client.query('SELECT * FROM guests WHERE id = $1', [guestId])).rows[0];
  if (!guest) return [];
  let tpl = null;
  if (templateKey) tpl = (await client.query('SELECT * FROM message_templates WHERE key = $1', [templateKey])).rows[0];
  const allVars = {
    name: firstName(guest.full_name), full_name: guest.full_name, member_no: guest.member_no,
    balance: guest.points_balance, brand: getSettingSync('brand_name', 'منزال'), ...vars,
  };
  const subj = renderTemplate(subject ?? tpl?.subject ?? '', allVars);
  const text = renderTemplate(body ?? tpl?.body ?? '', allVars);
  if (!text) return [];
  const created = [];
  for (const channel of channels) {
    const blocked = consentCheck(guest, channel, category);
    if (blocked && !recordSkipped) continue;
    const status = blocked ? 'skipped' : channel === 'in_app' ? 'sent' : 'queued';
    const r = (await client.query(
      `INSERT INTO notifications (guest_id, channel, category, template_key, subject, body, link, status, skip_reason,
                                  campaign_id, dedupe_key, scheduled_at, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, now()), CASE WHEN $8 = 'sent' THEN now() END)
       ON CONFLICT (guest_id, channel, dedupe_key) DO NOTHING RETURNING *`,
      [guestId, channel, category, templateKey, subj, text, link, status, blocked, campaignId, dedupeKey, scheduledAt],
    )).rows[0];
    if (r) created.push(r);
  }
  return created;
}

function emailHtml(n, guest) {
  const brand = getSettingSync('brand_name', 'منزال');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const linkUrl = `${config.appUrl}/t/${n.tracking_token}`;
  const unsub = `${config.appUrl}/unsubscribe/${guest.unsubscribe_token}`;
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f6f1e9;font-family:Tahoma,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
  <tr><td style="background:#0f4c4f;color:#fff;padding:20px 24px;font-size:22px;font-weight:bold">${esc(brand)}</td></tr>
  <tr><td style="padding:24px;color:#1f2a2b;font-size:16px;line-height:1.9;text-align:right">
    ${n.subject ? `<h2 style="margin:0 0 12px;font-size:19px;color:#0f4c4f">${esc(n.subject)}</h2>` : ''}
    ${esc(n.body).replace(/\n/g, '<br>')}
    ${n.link ? `<p style="margin:24px 0 0"><a href="${linkUrl}" style="background:#c8963e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;display:inline-block">افتح حسابك في ${esc(brand)}</a></p>` : ''}
  </td></tr>
  <tr><td style="padding:16px 24px;color:#7a8586;font-size:12px;text-align:right;border-top:1px solid #eee">
    ${n.category === 'marketing' ? `وصلتك هذه الرسالة لأنك وافقت على استقبال عروض ${esc(brand)}. <a href="${unsub}" style="color:#7a8586">إلغاء الاشتراك</a>` : `رسالة خدمة من ${esc(brand)}.`}
  </td></tr></table>
  <img src="${config.appUrl}/t/${n.tracking_token}.gif" width="1" height="1" alt="">
  </td></tr></table></body></html>`;
}

/** إرسال إشعار واحد من الطابور */
async function deliver(n) {
  const guest = (await pool.query('SELECT * FROM guests WHERE id = $1', [n.guest_id])).rows[0];
  // إعادة فحص الموافقة وقت الإرسال (قد يلغي الضيف اشتراكه بعد الجدولة)
  const blocked = consentCheck(guest, n.channel, n.category);
  if (blocked) return { status: 'skipped', skip_reason: blocked };
  if (n.channel === 'email') {
    const headers = n.category === 'marketing' ? {
      'List-Unsubscribe': `<${config.appUrl}/unsubscribe/${guest.unsubscribe_token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : {};
    const res = await sendEmail({ to: guest.email, subject: n.subject || getSettingSync('brand_name', 'منزال'), html: emailHtml(n, guest), text: n.body, headers });
    return { status: 'sent', provider_message_id: res.id };
  }
  if (n.channel === 'whatsapp') {
    const tpl = n.template_key ? (await pool.query('SELECT * FROM message_templates WHERE key = $1', [n.template_key])).rows[0] : null;
    let templateName = tpl?.whatsapp_template_name;
    let params = [];
    if (n.campaign_id) {
      const c = (await pool.query('SELECT * FROM campaigns WHERE id = $1', [n.campaign_id])).rows[0];
      templateName = c?.segment?.whatsapp_template_name || templateName;
      params = [String(guest.full_name).split(' ')[0], n.body];
    } else if (tpl?.whatsapp_params) {
      const vars = { name: String(guest.full_name).split(' ')[0], balance: guest.points_balance, member_no: guest.member_no };
      params = tpl.whatsapp_params.split(',').map((k) => vars[k.trim()] ?? '');
    }
    const res = await sendWhatsAppTemplate({ to: guest.phone, templateName, params, fallbackText: n.body });
    return { status: 'sent', provider_message_id: res.id };
  }
  return { status: 'skipped', skip_reason: 'قناة غير مدعومة' };
}

/** معالجة طابور الإشعارات المستحقة */
export async function processQueue({ limit = 100 } = {}) {
  const client = await pool.connect();
  let processed = 0;
  try {
    await client.query('BEGIN');
    const batch = (await client.query(
      `SELECT * FROM notifications WHERE status = 'queued' AND scheduled_at <= now()
        ORDER BY scheduled_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit],
    )).rows;
    for (const n of batch) {
      let upd;
      try {
        upd = await deliver(n);
      } catch (e) {
        const attempts = n.attempts + 1;
        upd = attempts >= 3 ? { status: 'failed', error: e.message } : { status: 'queued', error: e.message, retry: true };
      }
      await client.query(
        `UPDATE notifications SET status = $2, skip_reason = $3, error = $4, provider_message_id = $5, attempts = attempts + 1,
                sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
                scheduled_at = CASE WHEN $6 THEN now() + interval '10 minutes' ELSE scheduled_at END
          WHERE id = $1`,
        [n.id, upd.status, upd.skip_reason || null, upd.error || null, upd.provider_message_id || null, Boolean(upd.retry)],
      );
      processed++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return processed;
}

export function providerStatus() {
  return {
    email: emailConfigured() ? 'smtp' : (config.isProd ? 'غير مُعد' : 'وضع السجل (تطوير)'),
    whatsapp: whatsappConfigured() ? 'WhatsApp Cloud API' : (config.isProd ? 'غير مُعد' : 'وضع السجل (تطوير)'),
  };
}

export const channelLabel = (c) => LABELS.channel[c] || c;
