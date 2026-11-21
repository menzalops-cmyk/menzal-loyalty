// واتساب عبر WhatsApp Business Cloud API الرسمي (Meta).
// الرسائل التي يبدأها النظام يجب أن تكون قوالب معتمدة مسبقًا لدى Meta، ولا تُرسل إلا لمن وافق.
import { config } from '../config.js';

export const whatsappConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);

/** params: قيم متغيرات القالب بالترتيب {{1}}, {{2}}, ... */
export async function sendWhatsAppTemplate({ to, templateName, params = [], fallbackText }) {
  if (!whatsappConfigured()) {
    if (config.isProd) throw new Error('مزود واتساب غير مُعد (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
    if (!config.isTest) console.log(`[whatsapp:dev-log] → ${to} | ${templateName || 'no-template'} | ${fallbackText?.slice(0, 60)}`);
    return { id: `dev-log-${Date.now()}`, mode: 'dev-log' };
  }
  if (!templateName) throw new Error('لا يوجد اسم قالب واتساب معتمد لهذه الرسالة');
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: templateName, language: { code: config.whatsapp.templateLang },
        components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p).replace(/\s+/g, ' ').slice(0, 1000) })) }] : [],
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `WhatsApp API ${res.status}`);
  return { id: body?.messages?.[0]?.id, mode: 'cloud-api' };
}
