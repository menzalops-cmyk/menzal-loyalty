import 'dotenv/config';

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  port: Number(process.env.PORT || 3000),
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  // وضع التجربة: يعرض رموز التحقق على الشاشة ويسجل الرسائل بدل إرسالها عندما لا يكون مزود البريد/واتساب مُعدًا.
  // للتجربة الداخلية فقط — يجب إيقافه (DEMO_MODE=false) وإعداد SMTP قبل استقبال ضيوف حقيقيين.
  demoMode: process.env.DEMO_MODE === 'true',
  databaseUrl: required('DATABASE_URL', 'postgres://menzal:menzal_dev@localhost:5432/menzal'),
  appSecret: required('APP_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-secret-not-for-production'),
  runWorker: process.env.RUN_WORKER !== 'false',
  workerIntervalSeconds: Number(process.env.WORKER_INTERVAL_SECONDS || 60),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Menzal <no-reply@example.com>',
  },
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'ar',
  },
  bookingWebhookSecret: process.env.BOOKING_WEBHOOK_SECRET || '',
};
