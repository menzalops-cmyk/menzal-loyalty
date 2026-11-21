// الأتمتة: رسائل تلقائية تُبقي العلاقة مع الضيف بعد مغادرته. كلها قابلة للتفعيل والتعديل من لوحة الإدارة،
// ومحمية من التكرار عبر dedupe_key، والتسويقية منها تخضع لموافقة الضيف.
import { pool, tx } from '../db.js';
import { notify } from './notifications.js';
import { issueVoucher } from './rewards.js';
import { expireDueLots } from './ledger.js';
import { expireVouchers } from './rewards.js';

const ym = () => new Date().toISOString().slice(0, 7);

const HANDLERS = {
  // تذكير بقرب انتهاء صلاحية المكافآت (معاملات)
  async reward_expiry_reminder(a) {
    const days = Number(a.params.days_before || 7);
    const rows = (await pool.query(
      `SELECT gr.id, gr.guest_id, gr.code, gr.expires_at, r.name FROM guest_rewards gr JOIN rewards r ON r.id = gr.reward_id
        WHERE gr.status = 'available' AND gr.expires_at > now() AND gr.expires_at <= now() + make_interval(days => $1)`, [days],
    )).rows;
    let n = 0;
    for (const v of rows) {
      await tx(async (c) => {
        const created = await notify(c, {
          guestId: v.guest_id, templateKey: a.template_key, category: 'transactional', channels: a.channels,
          vars: { reward_name: v.name, code: v.code, expires_at: new Date(v.expires_at).toISOString().slice(0, 10) },
          link: '/account/rewards', dedupeKey: `${a.key}:${v.id}`,
        });
        n += created.length ? 1 : 0;
      });
    }
    return n;
  },

  // تذكير بنقاط ستنتهي صلاحيتها (معاملات)
  async points_expiry_reminder(a) {
    const days = Number(a.params.days_before || 30);
    const rows = (await pool.query(
      `SELECT guest_id, SUM(remaining)::int AS pts, MIN(expires_at) AS first_at FROM points_ledger
        WHERE remaining > 0 AND expires_at > now() AND expires_at <= now() + make_interval(days => $1) GROUP BY guest_id`, [days],
    )).rows;
    let n = 0;
    for (const r of rows) {
      await tx(async (c) => {
        const created = await notify(c, {
          guestId: r.guest_id, templateKey: a.template_key, category: 'transactional', channels: a.channels,
          vars: { points: r.pts, expires_at: new Date(r.first_at).toISOString().slice(0, 10) },
          link: '/account/rewards', dedupeKey: `${a.key}:${new Date(r.first_at).toISOString().slice(0, 10)}`,
        });
        n += created.length ? 1 : 0;
      });
    }
    return n;
  },

  // لديك نقاط كافية للاستبدال (تسويقية، مرة شهريًا كحد أقصى)
  async points_redeemable(a) {
    const rows = (await pool.query(
      `SELECT g.id, (SELECT name FROM rewards r WHERE r.active AND r.points_cost IS NOT NULL AND r.points_cost <= g.points_balance
                      AND (r.valid_until IS NULL OR r.valid_until >= current_date) ORDER BY r.points_cost DESC LIMIT 1) AS reward_name
         FROM guests g WHERE g.status = 'active'
          AND g.points_balance >= (SELECT min(points_cost) FROM rewards WHERE active AND points_cost IS NOT NULL
                                    AND (valid_until IS NULL OR valid_until >= current_date))`,
    )).rows;
    let n = 0;
    for (const r of rows) {
      await tx(async (c) => {
        const created = await notify(c, {
          guestId: r.id, templateKey: a.template_key, category: 'marketing', channels: a.channels,
          vars: { reward_name: r.reward_name }, link: '/account/rewards', dedupeKey: `${a.key}:${ym()}`,
        });
        n += created.length ? 1 : 0;
      });
    }
    return n;
  },

  // ضيوف لم يعودوا منذ فترة (تسويقية) + مكافأة عودة اختيارية
  async lapsed_guest(a) {
    const days = Number(a.params.days || 180);
    const rows = (await pool.query(
      `SELECT g.id, lb.id AS last_booking_id FROM guests g
         JOIN LATERAL (SELECT id, check_out FROM bookings WHERE guest_id = g.id AND status = 'completed' ORDER BY check_out DESC LIMIT 1) lb ON true
        WHERE g.status = 'active' AND lb.check_out < current_date - $1::int
          AND NOT EXISTS (SELECT 1 FROM bookings nb WHERE nb.guest_id = g.id AND nb.status IN ('pending','confirmed','checked_in') )`, [days],
    )).rows;
    let n = 0;
    for (const r of rows) {
      await tx(async (c) => {
        let vars = {};
        const dedupeKey = `${a.key}:${r.last_booking_id}`;
        const already = (await c.query('SELECT 1 FROM notifications WHERE guest_id = $1 AND dedupe_key = $2', [r.id, dedupeKey])).rowCount;
        if (already) return;
        const guest = (await c.query('SELECT * FROM guests WHERE id = $1', [r.id])).rows[0];
        const reachable = guest.consent_email_marketing || (guest.consent_whatsapp && guest.consent_whatsapp_marketing);
        if (a.params.reward_id && reachable) {
          const { voucher, reward } = await issueVoucher(c, {
            guestId: r.id, rewardId: Number(a.params.reward_id), source: 'automation', sourceRef: dedupeKey, skipEligibility: true, notifyGuest: false,
          });
          if (voucher) vars = { code: voucher.code, reward_name: reward.name };
        }
        const created = await notify(c, {
          guestId: r.id, templateKey: a.template_key, category: 'marketing', channels: a.channels, vars, link: '/account/rebook', dedupeKey,
        });
        n += created.length ? 1 : 0;
      });
    }
    return n;
  },

  // تشجيع على إعادة الحجز بعد X يوم من المغادرة (تسويقية)
  async rebook_nudge(a) {
    const days = Number(a.params.days_after || 21);
    const rows = (await pool.query(
      `SELECT b.id, b.guest_id, u.name AS unit_name FROM bookings b JOIN units u ON u.id = b.unit_id
        WHERE b.status = 'completed' AND b.guest_id IS NOT NULL AND b.check_out = current_date - $1::int`, [days],
    )).rows;
    let n = 0;
    for (const r of rows) {
      await tx(async (c) => {
        const created = await notify(c, {
          guestId: r.guest_id, templateKey: a.template_key, category: 'marketing', channels: a.channels,
          vars: { unit_name: r.unit_name }, link: '/account/rebook', dedupeKey: `${a.key}:${r.id}`,
        });
        n += created.length ? 1 : 0;
      });
    }
    return n;
  },
};

export async function runAutomations() {
  const autos = (await pool.query('SELECT * FROM automations WHERE active')).rows;
  const out = {};
  for (const a of autos) {
    if (!HANDLERS[a.key]) continue;
    out[a.key] = await HANDLERS[a.key](a);
    await pool.query('UPDATE automations SET last_run_at = now() WHERE key = $1', [a.key]);
  }
  return out;
}

/** مهام الصيانة: انتهاء صلاحية النقاط والقسائم */
export async function runMaintenance() {
  const expiredLots = await tx((c) => expireDueLots(c));
  const expiredVouchers = await expireVouchers();
  return { expiredLots: expiredLots.length, expiredVouchers };
}

export const AUTOMATION_KEYS = Object.keys(HANDLERS);
