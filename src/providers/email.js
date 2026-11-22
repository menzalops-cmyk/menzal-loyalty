// مزود البريد: SMTP عبر nodemailer. بدون إعداد يعمل في "وضع السجل" للتطوير فقط.
import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
export const emailConfigured = () => Boolean(config.smtp.host);

export async function sendEmail({ to, subject, html, text, headers = {} }) {
  if (!emailConfigured()) {
    if (config.isProd && !config.demoMode) throw new Error('مزود البريد غير مُعد (SMTP_HOST)');
    if (!config.isTest) console.log(`[email:dev-log] → ${to} | ${subject}`);
    return { id: `dev-log-${Date.now()}`, mode: 'dev-log' };
  }
  transport ||= nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  const info = await transport.sendMail({ from: config.smtp.from, to, subject, html, text, headers });
  return { id: info.messageId, mode: 'smtp' };
}
