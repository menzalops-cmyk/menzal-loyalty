-- منزال | نظام الولاء وإعادة الحجز — المخطط الأساسي
-- مبادئ: الفصل بين الضيوف/الحجوزات/المكافآت، سجل نقاط غير قابل للحذف، مفاتيح منع التكرار.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ========== الإعدادات العامة ==========
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ========== فريق العمل والصلاحيات ==========
CREATE TABLE staff_users (
  id            bigserial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','manager','support','marketing')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ========== برنامج الولاء ==========
CREATE TABLE loyalty_programs (
  id                     bigserial PRIMARY KEY,
  name                   text NOT NULL,
  active                 boolean NOT NULL DEFAULT false,
  points_per_currency    numeric(10,4) NOT NULL DEFAULT 1,   -- نقاط لكل وحدة عملة مدفوعة
  points_per_stay        integer NOT NULL DEFAULT 0,          -- نقاط ثابتة لكل إقامة مكتملة
  points_per_night       integer NOT NULL DEFAULT 0,
  point_value            numeric(10,4) NOT NULL DEFAULT 0.05, -- قيمة النقطة التقديرية بالعملة (للتقارير)
  points_expiry_months   integer,                             -- NULL = لا تنتهي
  stamp_goal             integer NOT NULL DEFAULT 0,          -- 0 = نموذج الأختام معطل
  stamp_reward_id        bigint,                              -- مكافأة تُمنح عند اكتمال البطاقة
  claim_window_days      integer NOT NULL DEFAULT 365,        -- مدة احتساب الحجوزات السابقة عند ربط الحساب
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- برنامج واحد نشط فقط في أي وقت
CREATE UNIQUE INDEX one_active_program ON loyalty_programs ((active)) WHERE active;

CREATE TABLE tiers (
  id               bigserial PRIMARY KEY,
  program_id       bigint NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  name             text NOT NULL,
  min_stays        integer NOT NULL DEFAULT 0,
  min_points       integer NOT NULL DEFAULT 0,  -- إجمالي النقاط المكتسبة مدى الحياة
  earn_multiplier  numeric(6,3) NOT NULL DEFAULT 1,
  perks            text,
  color            text NOT NULL DEFAULT '#0f5257',
  sort_order       integer NOT NULL DEFAULT 0
);

-- قواعد اكتساب إضافية (مضاعفات موسمية / مكافآت وحدات)
CREATE TABLE earning_rules (
  id           bigserial PRIMARY KEY,
  program_id   bigint NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  name         text NOT NULL,
  rule_type    text NOT NULL CHECK (rule_type IN ('multiplier','bonus_points')),
  value        numeric(10,3) NOT NULL,
  unit_ids     bigint[],            -- NULL = كل الوحدات
  valid_from   date,
  valid_until  date,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ========== الوحدات ==========
CREATE TABLE units (
  id            bigserial PRIMARY KEY,
  external_id   text UNIQUE,
  name          text NOT NULL,
  city          text NOT NULL,
  district      text,
  unit_type     text NOT NULL,           -- شقة / استوديو / فيلا / شاليه
  bedrooms      integer NOT NULL DEFAULT 1,
  capacity      integer NOT NULL DEFAULT 2,
  nightly_price numeric(12,2) NOT NULL,
  image_url     text,
  description   text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ========== الضيوف ==========
CREATE TABLE guests (
  id                 bigserial PRIMARY KEY,
  member_no          text NOT NULL UNIQUE,
  full_name          text NOT NULL,
  email              text UNIQUE,
  phone              text UNIQUE,
  password_hash      text,
  email_verified_at  timestamptz,
  phone_verified_at  timestamptz,
  home_city          text,
  referral_code      text NOT NULL UNIQUE,
  card_token         text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'), -- رابط مشاركة البطاقة
  unsubscribe_token  text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16),'hex'),
  tier_id            bigint REFERENCES tiers(id) ON DELETE SET NULL,
  -- أرصدة مخزنة للعرض السريع؛ المصدر الحقيقي هو points_ledger
  points_balance     integer NOT NULL DEFAULT 0,
  lifetime_points    integer NOT NULL DEFAULT 0,
  completed_stays    integer NOT NULL DEFAULT 0,
  stamp_count        integer NOT NULL DEFAULT 0,
  -- موافقات التواصل الحالية (السجل الكامل في consent_log)
  consent_email_marketing     boolean NOT NULL DEFAULT false,
  consent_whatsapp            boolean NOT NULL DEFAULT false,  -- موافقة استقبال واتساب (معاملات)
  consent_whatsapp_marketing  boolean NOT NULL DEFAULT false,
  signup_ip_hash     text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX guests_name_idx ON guests (lower(full_name));

CREATE TABLE consent_log (
  id          bigserial PRIMARY KEY,
  guest_id    bigint NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  channel     text NOT NULL,      -- email_marketing / whatsapp / whatsapp_marketing
  granted     boolean NOT NULL,
  source      text NOT NULL,      -- signup / preferences / unsubscribe_link / staff
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_codes (
  id          bigserial PRIMARY KEY,
  guest_id    bigint REFERENCES guests(id) ON DELETE CASCADE,
  target      text NOT NULL,       -- البريد أو الجوال
  channel     text NOT NULL CHECK (channel IN ('email','phone')),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  actor_type  text NOT NULL CHECK (actor_type IN ('guest','staff')),
  actor_id    bigint NOT NULL,
  csrf_token  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ========== الحملات (قبل الحجوزات لأجل الإسناد) ==========
CREATE TABLE campaigns (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  segment       jsonb NOT NULL DEFAULT '{}'::jsonb,
  channels      text[] NOT NULL,
  subject       text,
  body          text NOT NULL,
  reward_id     bigint,                  -- مكافأة تُمنح لكل مستلم (اختياري)
  scheduled_at  timestamptz,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  is_test       boolean NOT NULL DEFAULT false,
  sent_at       timestamptz,
  recipients_count integer NOT NULL DEFAULT 0,
  created_by    bigint REFERENCES staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ========== كتالوج المكافآت ==========
CREATE TABLE rewards (
  id                    bigserial PRIMARY KEY,
  name                  text NOT NULL,
  description           text,
  reward_type           text NOT NULL CHECK (reward_type IN
                          ('percent_discount','fixed_discount','free_upgrade','late_checkout')),
  category              text NOT NULL DEFAULT 'catalog' CHECK (category IN
                          ('catalog','seasonal','repeat_guest','referral','stamp','campaign')),
  value                 numeric(12,2) NOT NULL DEFAULT 0,  -- نسبة أو مبلغ
  max_discount          numeric(12,2),                      -- سقف خصم النسبة
  points_cost           integer,                            -- NULL = غير قابلة للاستبدال بالنقاط
  min_booking_amount    numeric(12,2) NOT NULL DEFAULT 0,
  unit_ids              bigint[],                           -- NULL = كل الوحدات
  min_tier_id           bigint REFERENCES tiers(id) ON DELETE SET NULL,
  min_completed_stays   integer NOT NULL DEFAULT 0,
  valid_from            date,                               -- نافذة الإصدار/الاستبدال
  valid_until           date,
  stay_from             date,                               -- نافذة تواريخ الإقامة المسموحة (للعروض الموسمية)
  stay_until            date,
  voucher_validity_days integer NOT NULL DEFAULT 90,        -- صلاحية القسيمة بعد إصدارها
  per_guest_limit       integer,                            -- NULL = بلا حد
  total_stock           integer,                            -- NULL = بلا حد
  issued_count          integer NOT NULL DEFAULT 0,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE loyalty_programs ADD CONSTRAINT stamp_reward_fk FOREIGN KEY (stamp_reward_id) REFERENCES rewards(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD CONSTRAINT campaign_reward_fk FOREIGN KEY (reward_id) REFERENCES rewards(id) ON DELETE SET NULL;

-- ========== الحجوزات ==========
CREATE TABLE bookings (
  id                bigserial PRIMARY KEY,
  booking_ref       text NOT NULL UNIQUE,
  source            text NOT NULL DEFAULT 'menzal' CHECK (source IN ('menzal','external')),
  external_ref      text,
  guest_id          bigint REFERENCES guests(id) ON DELETE SET NULL,
  -- بيانات التواصل كما وردت مع الحجز (لربطها لاحقًا بحساب بعد التحقق)
  contact_name      text NOT NULL,
  contact_email     text,
  contact_phone     text,
  unit_id           bigint NOT NULL REFERENCES units(id),
  check_in          date NOT NULL,
  check_out         date NOT NULL,
  nights            integer GENERATED ALWAYS AS (check_out - check_in) STORED,
  guests_count      integer NOT NULL DEFAULT 1,
  subtotal_amount   numeric(12,2) NOT NULL,
  discount_amount   numeric(12,2) NOT NULL DEFAULT 0,
  total_amount      numeric(12,2) NOT NULL,          -- المدفوع فعليًا بعد الخصم
  refunded_amount   numeric(12,2) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN
                      ('pending','confirmed','checked_in','completed','cancelled','refunded')),
  perks             text[] NOT NULL DEFAULT '{}',    -- ترقية / تسجيل خروج متأخر مطلوب
  is_repeat         boolean NOT NULL DEFAULT false,  -- الضيف لديه إقامة مكتملة سابقة وقت الحجز
  referral_code     text,
  campaign_id       bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  completed_at      timestamptz,
  cancelled_at      timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  CHECK (total_amount >= 0),
  UNIQUE (source, external_ref)
);
CREATE INDEX bookings_guest_idx ON bookings (guest_id, check_in DESC);
CREATE INDEX bookings_contact_email_idx ON bookings (lower(contact_email)) WHERE guest_id IS NULL;
CREATE INDEX bookings_contact_phone_idx ON bookings (contact_phone) WHERE guest_id IS NULL;
CREATE INDEX bookings_unit_dates_idx ON bookings (unit_id, check_in, check_out);

CREATE TABLE booking_status_history (
  id          bigserial PRIMARY KEY,
  booking_id  bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor       text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- أحداث التكامل الواردة من منصات الحجز الخارجية (منع المعالجة المكررة)
CREATE TABLE integration_events (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ========== سجل النقاط (لا يُحذف ولا يُعدّل إلا حقل remaining لتتبع الاستهلاك) ==========
CREATE TABLE points_ledger (
  id               bigserial PRIMARY KEY,
  guest_id         bigint NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  entry_type       text NOT NULL CHECK (entry_type IN
                     ('earn','redeem','reverse','expire','adjust','referral_bonus','campaign_bonus','restore')),
  points           integer NOT NULL CHECK (points <> 0),   -- موجب للإضافة، سالب للخصم
  balance_after    integer NOT NULL,
  remaining        integer NOT NULL DEFAULT 0,             -- للدفعات الموجبة: ما لم يُستهلك بعد (FIFO)
  booking_id       bigint REFERENCES bookings(id),
  guest_reward_id  bigint,
  related_entry_id bigint REFERENCES points_ledger(id),    -- لعمليات التصحيح والعكس
  idempotency_key  text UNIQUE,                            -- يمنع احتساب العملية مرتين
  reason           text NOT NULL,
  expires_at       timestamptz,
  staff_id         bigint REFERENCES staff_users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX points_ledger_guest_idx ON points_ledger (guest_id, created_at DESC);
CREATE INDEX points_ledger_lots_idx ON points_ledger (guest_id, expires_at) WHERE remaining > 0;
-- لا يمكن منح نقاط "اكتساب" لنفس الحجز أكثر من مرة حتى لو اختلف مفتاح التكرار
CREATE UNIQUE INDEX one_earn_per_booking ON points_ledger (booking_id) WHERE entry_type = 'earn';

-- منع الحذف والتعديل (عدا remaining) على مستوى قاعدة البيانات
CREATE OR REPLACE FUNCTION points_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'points_ledger is append-only';
  END IF;
  IF NEW.guest_id <> OLD.guest_id OR NEW.points <> OLD.points OR NEW.entry_type <> OLD.entry_type
     OR NEW.balance_after <> OLD.balance_after OR NEW.reason <> OLD.reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'points_ledger entries are immutable; use a correcting entry';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER points_ledger_guard BEFORE UPDATE OR DELETE ON points_ledger
  FOR EACH ROW EXECUTE FUNCTION points_ledger_guard();

-- ========== الأختام ==========
CREATE TABLE stamps (
  id          bigserial PRIMARY KEY,
  guest_id    bigint NOT NULL REFERENCES guests(id),
  booking_id  bigint NOT NULL UNIQUE REFERENCES bookings(id),
  card_no     integer NOT NULL,            -- رقم بطاقة الأختام (1، 2، ...)
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ========== القسائم الممنوحة للضيوف ==========
CREATE TABLE guest_rewards (
  id               bigserial PRIMARY KEY,
  guest_id         bigint NOT NULL REFERENCES guests(id),
  reward_id        bigint NOT NULL REFERENCES rewards(id),
  code             text NOT NULL UNIQUE,
  source           text NOT NULL CHECK (source IN ('redeem','stamp','referral','campaign','manual','automation')),
  status           text NOT NULL DEFAULT 'available' CHECK (status IN ('available','used','expired','revoked')),
  points_spent     integer NOT NULL DEFAULT 0,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  used_at          timestamptz,
  used_booking_id  bigint REFERENCES bookings(id),
  discount_applied numeric(12,2),
  source_ref       text,              -- مرجع المصدر (حجز/حملة/إحالة) لمنع التكرار
  revoked_reason   text,
  UNIQUE (source, source_ref, guest_id)
);
CREATE INDEX guest_rewards_guest_idx ON guest_rewards (guest_id, status);
ALTER TABLE points_ledger ADD CONSTRAINT ledger_guest_reward_fk FOREIGN KEY (guest_reward_id) REFERENCES guest_rewards(id);

-- ========== الإحالات ==========
CREATE TABLE referral_rules (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active                 boolean NOT NULL DEFAULT true,
  referrer_points        integer NOT NULL DEFAULT 0,
  referrer_reward_id     bigint REFERENCES rewards(id) ON DELETE SET NULL,
  referee_reward_id      bigint REFERENCES rewards(id) ON DELETE SET NULL,
  min_booking_amount     numeric(12,2) NOT NULL DEFAULT 0,
  max_per_referrer_month integer NOT NULL DEFAULT 10,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id                bigserial PRIMARY KEY,
  referrer_id       bigint NOT NULL REFERENCES guests(id),
  referee_id        bigint NOT NULL UNIQUE REFERENCES guests(id),   -- الضيف يُحال مرة واحدة فقط
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','rejected')),
  booking_id        bigint REFERENCES bookings(id),
  reject_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  rewarded_at       timestamptz,
  CHECK (referrer_id <> referee_id)
);

-- ========== الإشعارات ==========
CREATE TABLE message_templates (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('transactional','marketing')),
  subject     text NOT NULL,
  body        text NOT NULL,
  whatsapp_template_name text,     -- اسم القالب المعتمد لدى Meta
  whatsapp_params text,            -- أسماء المتغيرات بالترتيب لقالب واتساب، مثال: name,points,balance
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id                  bigserial PRIMARY KEY,
  guest_id            bigint NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('in_app','email','whatsapp')),
  category            text NOT NULL CHECK (category IN ('transactional','marketing')),
  template_key        text,
  subject             text,
  body                text NOT NULL,
  link                text,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','skipped')),
  skip_reason         text,
  error               text,
  attempts            integer NOT NULL DEFAULT 0,
  campaign_id         bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  dedupe_key          text,
  tracking_token      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(12),'hex'),
  provider_message_id text,
  scheduled_at        timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  read_at             timestamptz,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guest_id, channel, dedupe_key)
);
CREATE INDEX notifications_queue_idx ON notifications (scheduled_at) WHERE status = 'queued';
CREATE INDEX notifications_guest_inapp_idx ON notifications (guest_id, created_at DESC) WHERE channel = 'in_app';

-- الأتمتة (تذكيرات ورسائل تلقائية)
CREATE TABLE automations (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  active       boolean NOT NULL DEFAULT false,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_key text NOT NULL REFERENCES message_templates(key),
  channels     text[] NOT NULL DEFAULT '{in_app,email}',
  last_run_at  timestamptz
);

-- ========== سجل التدقيق ==========
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  text NOT NULL,     -- staff / guest / system / integration
  actor_id    bigint,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  data        jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);

