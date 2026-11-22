# منزال | نظام الولاء وإعادة الحجز

نظام ولاء متكامل لمنصة منزال للتأجير اليومي: نقاط بعد كل إقامة مكتملة، بطاقة ولاء رقمية مع أختام، مكافآت وعروض، إعادة حجز مع تطبيق المكافآت، إحالات، إشعارات وحملات تسويقية تحترم الموافقة، ولوحة إدارة كاملة.

## التشغيل

المتطلبات: Node.js 20+ و PostgreSQL 14+.

```bash
npm install
cp .env.example .env        # عدّل DATABASE_URL و APP_SECRET و ADMIN_PASSWORD
npm run migrate             # إنشاء الجداول
npm run seed                # الإعدادات الافتراضية + مدير النظام + وحدات نموذجية
npm run seed -- --demo      # (اختياري) ضيوف وحجوزات تجريبية للاستكشاف
npm start                   # http://localhost:3000  —  الإدارة: /admin
npm test                    # 19 اختبارًا (تحتاج قاعدة menzal_test)
```

حسابات تجريبية بعد `--demo`: الضيف `demo.guest@menzal.local` / `Demo@12345`.

## البنية

| الطبقة | التقنية |
|---|---|
| الواجهة | صفحات تُعرض على الخادم (EJS) عربية RTL، متجاوبة مع الجوال، تعمل دون JavaScript |
| الخادم | Node.js + Express، helmet (CSP)، حماية CSRF، تحديد معدل محاولات الدخول |
| قاعدة البيانات | PostgreSQL، كل العمليات المالية داخل معاملات مع قفل صف الضيف |
| الدخول | جلسات بملفات تعريف ارتباط httpOnly (رمز مجزأ في القاعدة)، bcrypt، رموز تحقق لمرة واحدة |
| الصلاحيات | مدير النظام، مدير الولاء، خدمة الضيوف (تعديل نقاط بحد أقصى)، التسويق (دون بيانات التواصل) |
| العامل الخلفي | `src/worker.js`: طابور الإشعارات، الحملات المجدولة، الأتمتة، انتهاء صلاحية النقاط والمكافآت |

```
src/services/ledger.js     سجل النقاط (FIFO، منع التكرار، غير قابل للحذف)
src/services/loyalty.js    احتساب النقاط، الأختام، المستويات، العكس عند الاسترداد
src/services/rewards.js    الكتالوج، القسائم، الاستبدال، التحقق عند الحجز
src/services/bookings.js   الحجز وإعادة الحجز، دورة الحالات، ربط الحجوزات السابقة
src/services/referrals.js  الإحالات ومنع الاحتيال
src/services/campaigns.js  الشرائح، الإرسال، القياس والإسناد
src/services/automations.js الرسائل التلقائية
src/routes/api.js          Webhook تكامل منصة الحجز
```

## الجداول الرئيسية

`guests` · `staff_users` · `units` · `bookings` (+ `booking_status_history`) · `loyalty_programs` · `tiers` · `earning_rules` · `points_ledger` · `stamps` · `rewards` · `guest_rewards` · `referrals` / `referral_rules` · `campaigns` · `notifications` · `message_templates` · `automations` · `consent_log` · `audit_log` · `integration_events`

## قواعد العمل المطبقة (ومكان تطبيقها)

1. النقاط بعد الاكتمال فقط: الانتقال إلى `completed` يتطلب مرور تاريخ المغادرة (`bookings.transition`).
2. لا احتساب مزدوج: مفتاح `earn:booking:<id>` + فهرس فريد `one_earn_per_booking` في القاعدة.
3. لا استخدام لمكافأة منتهية/مستخدمة: قفل القسيمة `FOR UPDATE` والتحقق داخل معاملة الحجز.
4. و5. كل تغيير في سجل `points_ledger`؛ Trigger في القاعدة يمنع الحذف والتعديل، والتصحيح بقيود `reverse`/`adjust`.
6. فصل الضيوف/الحجوزات/المكافآت في جداول مستقلة.
7. كل القواعد تُعدّل من `/admin/loyalty` و `/admin/rewards` و `/admin/referrals`.
8. الحجوزات بدون حساب تُحفظ ببيانات التواصل، وتُربط بالحساب فقط بعد تأكيد البريد/الجوال برمز.
9. الرسائل التسويقية تتطلب موافقة لكل قناة، ويُعاد الفحص وقت الإرسال؛ رابط إلغاء اشتراك بنقرة واحدة (RFC 8058).
10. كل استعلامات حساب الضيف مقيدة بمعرفه؛ البطاقة العامة والإحالات لا تعرض بيانات تواصل.

## ما يحتاج ربطًا فعليًا

راجع `docs/INTEGRATIONS.md`: مزود البريد (SMTP)، WhatsApp Business Cloud API مع قوالب معتمدة، وWebhook منصة الحجز. بدونها يعمل النظام في «وضع السجل» أثناء التطوير، ويرفض الإرسال في الإنتاج.
