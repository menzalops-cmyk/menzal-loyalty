// تهيئة النظام: الإعدادات الافتراضية لبرنامج الولاء، القوالب، الأتمتة، ومدير النظام.
// الاستخدام: npm run seed            (إعداد أساسي + وحدات نموذجية قابلة للتعديل)
//            npm run seed -- --demo  (إضافة ضيوف وحجوزات تجريبية لاستكشاف النظام)
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, tx } from '../src/db.js';

export const TEMPLATES = [
  ['welcome', 'ترحيب بعضو جديد', 'transactional', 'أهلًا بك في نادي ضيوف منزال', 'مرحبًا {{name}}، أصبحت عضوًا في برنامج ولاء منزال. ستجمع النقاط بعد كل إقامة مكتملة، ورابط الإحالة الخاص بك جاهز للمشاركة مع أصدقائك.', null, null],
  ['points_earned', 'إضافة نقاط', 'transactional', 'أضفنا {{points}} نقطة إلى حسابك', 'شكرًا لإقامتك في {{unit_name}} يا {{name}}! أضفنا {{points}} نقطة إلى حسابك، ورصيدك الآن {{balance}} نقطة.', 'menzal_points_earned', 'name,balance'],
  ['reward_issued', 'مكافأة جديدة', 'transactional', 'لديك مكافأة جديدة: {{reward_name}}', 'مبروك {{name}}! حصلت على «{{reward_name}}». رمز المكافأة: {{code}} — صالحة حتى {{expires_at}}. استخدمها في حجزك القادم.', 'menzal_reward_issued', 'name'],
  ['tier_upgraded', 'ترقية المستوى', 'transactional', 'تهانينا! أصبحت في مستوى {{tier_name}}', 'مبروك {{name}}، تمت ترقيتك إلى مستوى {{tier_name}}. {{perks}}', null, null],
  ['booking_received', 'استلام حجز', 'transactional', 'استلمنا طلب حجزك {{booking_ref}}', 'استلمنا طلب حجزك في {{unit_name}} من {{check_in}} إلى {{check_out}}. سيتواصل معك فريق منزال لتأكيد الحجز.', null, null],
  ['booking_confirmed', 'تأكيد حجز', 'transactional', 'تم تأكيد حجزك {{booking_ref}}', 'تم تأكيد حجزك {{booking_ref}}، ننتظرك يوم {{check_in}}. ستُضاف نقاطك تلقائيًا بعد انتهاء الإقامة.', null, null],
  ['booking_cancelled', 'إلغاء حجز', 'transactional', 'تم إلغاء الحجز {{booking_ref}}', 'تم إلغاء الحجز {{booking_ref}}. {{voucher_note}}', null, null],
  ['referral_success', 'إحالة ناجحة', 'transactional', 'صديقك أكمل إقامته — مكافأتك وصلت!', 'شكرًا لترشيحك منزال يا {{name}}! أكمل صديقك إقامته وأضفنا {{points}} نقطة إلى حسابك.', null, null],
  ['reward_expiring', 'تذكير انتهاء مكافأة', 'transactional', 'مكافأتك تنتهي قريبًا', 'تذكير يا {{name}}: مكافأة «{{reward_name}}» (الرمز {{code}}) تنتهي في {{expires_at}}. احجز الآن واستفد منها.', 'menzal_reward_expiring', 'name'],
  ['points_expiring', 'تذكير انتهاء نقاط', 'transactional', '{{points}} نقطة ستنتهي صلاحيتها', 'يا {{name}}، لديك {{points}} نقطة تنتهي في {{expires_at}}. استبدلها بمكافأة قبل انتهائها.', null, null],
  ['points_redeemable', 'نقاط كافية للاستبدال', 'marketing', 'نقاطك تكفي لمكافأة!', 'رصيدك {{balance}} نقطة يا {{name}} — يكفي للحصول على «{{reward_name}}». استبدلها واستخدمها في رحلتك القادمة.', null, null],
  ['lapsed_guest', 'ضيف لم يعد منذ فترة', 'marketing', 'اشتقنا لك في منزال', 'مرحبًا {{name}}، مر وقت منذ آخر إقامة لك معنا. جهزنا لك مكافأة خاصة {{code}} لحجزك القادم.', 'menzal_winback', 'name'],
  ['rebook_nudge', 'تشجيع إعادة الحجز', 'marketing', 'خطط لزيارتك القادمة', 'نتمنى أن إقامتك في {{unit_name}} كانت مريحة يا {{name}}. رصيدك {{balance}} نقطة — احجز زيارتك القادمة بنقرة واحدة.', null, null],
];

const AUTOMATIONS = [
  ['reward_expiry_reminder', 'تذكير بقرب انتهاء المكافآت', true, { days_before: 7 }, 'reward_expiring'],
  ['points_expiry_reminder', 'تذكير بقرب انتهاء النقاط', true, { days_before: 30 }, 'points_expiring'],
  ['points_redeemable', 'إشعار من لديه نقاط كافية للاستبدال', true, {}, 'points_redeemable'],
  ['lapsed_guest', 'استعادة الضيوف المنقطعين', false, { days: 180, reward_id: null }, 'lapsed_guest'],
  ['rebook_nudge', 'تشجيع إعادة الحجز بعد المغادرة', true, { days_after: 21 }, 'rebook_nudge'],
];

export async function seedBase(client, { adminEmail, adminPassword, units = true } = {}) {
  for (const t of TEMPLATES) {
    await client.query(
      `INSERT INTO message_templates (key, name, category, subject, body, whatsapp_template_name, whatsapp_params)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO NOTHING`, t,
    );
  }
  for (const [key, name, active, params, tpl] of AUTOMATIONS) {
    await client.query(
      `INSERT INTO automations (key, name, active, params, template_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
      [key, name, active, JSON.stringify(params), tpl],
    );
  }
  let program = (await client.query('SELECT * FROM loyalty_programs ORDER BY id LIMIT 1')).rows[0];
  if (!program) {
    program = (await client.query(
      `INSERT INTO loyalty_programs (name, active, points_per_currency, points_per_stay, points_per_night, point_value, points_expiry_months, stamp_goal, claim_window_days)
       VALUES ('نادي ضيوف منزال', true, 1, 50, 0, 0.05, 24, 2, 365) RETURNING *`,
    )).rows[0];
    const tiers = [['فضي', 0, 0, 1, 'نقاط على كل إقامة', '#8a8f94', 1], ['ذهبي', 3, 2000, 1.25, 'نقاط إضافية 25% + أولوية تسجيل الخروج المتأخر', '#b77b09', 2], ['ماسي', 8, 6000, 1.5, 'نقاط إضافية 50% + ترقية عند التوفر', '#640211', 3]];
    for (const [name, stays, pts, mult, perks, color, sort] of tiers) {
      await client.query(
        `INSERT INTO tiers (program_id, name, min_stays, min_points, earn_multiplier, perks, color, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [program.id, name, stays, pts, mult, perks, color, sort],
      );
    }
    const ins = async (r) => (await client.query(
      `INSERT INTO rewards (name, description, reward_type, category, value, max_discount, points_cost, min_booking_amount, voucher_validity_days, per_guest_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, r,
    )).rows[0].id;
    await ins(['خصم 50 ريال', 'خصم بمبلغ ثابت على حجزك القادم', 'fixed_discount', 'catalog', 50, null, 1000, 200, 120, null]);
    await ins(['خصم 10%', 'خصم 10% على الحجز القادم بحد أقصى 300', 'percent_discount', 'catalog', 10, 300, 1800, 300, 120, null]);
    await ins(['تسجيل خروج متأخر', 'تمديد وقت الخروج حتى الساعة 2 ظهرًا عند التوفر', 'late_checkout', 'catalog', 0, null, 600, 0, 90, null]);
    await ins(['ترقية مجانية للوحدة', 'ترقية لفئة أعلى عند التوفر', 'free_upgrade', 'catalog', 0, null, 2500, 0, 90, null]);
    const stampReward = await ins(['مكافأة الإقامة الثالثة: خصم 15%', 'بعد إكمال إقامتين تحصل على خصم 15% على حجزك القادم', 'percent_discount', 'stamp', 15, 400, null, 0, 180, null]);
    const referrer = await ins(['مكافأة الإحالة: خصم 75 ريال', 'شكرًا لترشيحك منزال', 'fixed_discount', 'referral', 75, null, null, 200, 180, null]);
    const referee = await ins(['هدية صديق: خصم 10%', 'هدية من صديقك على حجزك القادم', 'percent_discount', 'referral', 10, 250, null, 0, 180, null]);
    await client.query('UPDATE loyalty_programs SET stamp_reward_id = $1 WHERE id = $2', [stampReward, program.id]);
    await client.query(
      `INSERT INTO referral_rules (id, active, referrer_points, referrer_reward_id, referee_reward_id, min_booking_amount, max_per_referrer_month)
       VALUES (1, true, 300, $1, $2, 200, 10) ON CONFLICT (id) DO NOTHING`, [referrer, referee],
    );
  }
  if (adminEmail && adminPassword) {
    await client.query(
      `INSERT INTO staff_users (email, name, password_hash, role) VALUES ($1,'مدير النظام',$2,'admin') ON CONFLICT (email) DO NOTHING`,
      [adminEmail.toLowerCase(), await bcrypt.hash(adminPassword, 10)],
    );
  }
  if (units && !(await client.query('SELECT 1 FROM units LIMIT 1')).rowCount) {
    const list = [
      ['شقة الواحة — غرفتين', 'الرياض', 'الملقا', 'شقة', 2, 4, 450],
      ['استوديو النخيل', 'الرياض', 'العليا', 'استوديو', 1, 2, 280],
      ['فيلا الريحان', 'الرياض', 'حطين', 'فيلا', 4, 10, 1400],
      ['شقة البحر — إطلالة', 'جدة', 'الشاطئ', 'شقة', 2, 5, 520],
      ['استوديو الكورنيش', 'جدة', 'الحمراء', 'استوديو', 1, 2, 300],
      ['شاليه الغيم', 'أبها', 'السودة', 'شاليه', 3, 6, 850],
    ];
    for (const [name, city, district, type, br, cap, price] of list) {
      await client.query(
        `INSERT INTO units (name, city, district, unit_type, bedrooms, capacity, nightly_price, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'وحدة نموذجية — عدّلها أو استبدلها ببيانات وحداتك الفعلية من لوحة الإدارة')`,
        [name, city, district, type, br, cap, price],
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo') || process.env.SEED_DEMO === 'true';
  (async () => {
    await tx((c) => seedBase(c, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD }));
    console.log('✔ base configuration seeded');
    if (!process.env.ADMIN_PASSWORD) console.log('⚠ ADMIN_PASSWORD not set — no admin user created');
    else console.log(`✔ admin: ${process.env.ADMIN_EMAIL}`);
    if (demo) {
      const { seedDemo } = await import('./demo.js');
      await seedDemo();
      console.log('✔ demo data added');
    }
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
