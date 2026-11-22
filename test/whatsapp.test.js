// التحقق من شكل الطلب المرسل إلى WhatsApp Cloud API (بدون اتصال فعلي)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { sendWhatsAppTemplate } from '../src/providers/whatsapp.js';

test('authentication template sends the code in body and copy-code button', async () => {
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent = { url, opts }; return { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }; };
  try {
    const r = await sendWhatsAppTemplate({ to: '966500000001', templateName: 'menzal_otp', params: ['482913'], otpButton: '482913' });
    assert.equal(r.id, 'wamid.X');
    assert.match(sent.url, /graph\.facebook\.com\/v\d+\.\d+\/123456\/messages/);
    assert.equal(sent.opts.headers.Authorization, 'Bearer test-token');
    const body = JSON.parse(sent.opts.body);
    assert.equal(body.template.name, 'menzal_otp');
    assert.equal(body.template.language.code, 'ar');
    assert.deepEqual(body.template.components[0], { type: 'body', parameters: [{ type: 'text', text: '482913' }] });
    assert.deepEqual(body.template.components[1], { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] });
  } finally {
    globalThis.fetch = realFetch; config.whatsapp.token = ''; config.whatsapp.phoneNumberId = '';
  }
});
