# التكاملات

## 1) منصة الحجز (Webhook)

إذا كانت لدى منزال منصة حجز أو PMS، فهي ترسل أحداث الحجز إلى:

`POST {APP_URL}/api/integrations/bookings`

- الترويسة `X-Menzal-Signature: sha256=<HMAC-SHA256(BOOKING_WEBHOOK_SECRET, raw_body)>`
- `event_id` فريد لكل حدث: الأحداث المكررة تُتجاهل، والحدث الفاشل يمكن إعادة إرساله بنفس المعرف.

```json
{
  "event_id": "evt_123",
  "provider": "my-pms",
  "booking": {
    "external_ref": "PMS-8841",
    "status": "completed",
    "unit_external_id": "APT-12",
    "check_in": "2026-11-01", "check_out": "2026-11-03",
    "guests_count": 2, "total_amount": 900, "refunded_amount": 0,
    "guest": { "name": "...", "phone": "05...", "email": "(اختياري)" }
  }
}
```

الحالات: `pending | confirmed | checked_in | completed | cancelled | refunded`. تُمنح النقاط عند `completed` بعد مرور تاريخ المغادرة. تُطابق الوحدة بحقل «المعرف في نظام الحجز الخارجي» في `/admin/units`.

بدون منصة خارجية يعمل النظام بالكامل بوحدة الحجز المدمجة (طلبات الحجز من حساب الضيف + تسجيل الحجوزات من الإدارة).

## 2) البريد الإلكتروني

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — يعمل مع Amazon SES أو Mailgun أو SendGrid (SMTP) أو Google Workspace. فعّل SPF/DKIM للنطاق.

## 3) واتساب (WhatsApp Business Cloud API — Meta)

`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TEMPLATE_LANG=ar`.
الرسائل التي يبدأها النظام يجب أن تكون قوالب معتمدة لدى Meta. أنشئ القوالب ثم ضع أسماءها في `/admin/messages`:
- `menzal_otp` (فئة Authentication) — **إلزامي**: رمز الدخول والتسجيل يُرسل به. `{{1}}` = الرمز
  (بديل لاحق ممكن: مزود SMS سعودي مثل Unifonic أو Taqnyat لإرسال الرمز برسالة نصية)
- قوالب الإشعارات حسب الحاجة مع ترتيب المتغيرات (مثل `name,balance`)
- قوالب الحملات (فئة Marketing): `{{1}}` = الاسم، `{{2}}` = نص الرسالة

لا يُرسل أي شيء عبر واتساب إلا لمن وافق، ولا عروض إلا لمن وافق على العروض عبر واتساب.

## 4) لم يُنفذ بعد (جاهز للإضافة)

- بوابة الدفع: الحجوزات الجديدة تُنشأ «بانتظار التأكيد» ويؤكدها الفريق.
- إضافة البطاقة إلى Apple/Google Wallet: البطاقة لها رابط عام `/card/<token>` جاهز للربط بخدمة إصدار البطاقات.
- إرسال رموز التحقق عبر SMS.
