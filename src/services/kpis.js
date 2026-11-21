// مؤشرات الأداء للوحة الإدارة — كلها محسوبة من البيانات الفعلية.
import { pool } from '../db.js';

export async function dashboardKpis({ days = null } = {}, client = pool) {
  const since = days ? `now() - interval '${Number(days)} days'` : `'-infinity'::timestamptz`;
  const q = async (sql) => (await client.query(sql)).rows[0];
  const members = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at >= ${since})::int AS new FROM guests`);
  const returning = await q(`SELECT count(DISTINCT guest_id)::int AS c FROM bookings WHERE is_repeat AND status NOT IN ('cancelled','refunded') AND created_at >= ${since}`);
  const bookings = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE is_repeat)::int AS repeat,
      COALESCE(SUM(total_amount - refunded_amount) FILTER (WHERE is_repeat),0) AS repeat_revenue,
      COALESCE(SUM(total_amount - refunded_amount),0) AS revenue
    FROM bookings WHERE status NOT IN ('cancelled','refunded') AND created_at >= ${since}`);
  const points = await q(`SELECT
      COALESCE(SUM(points) FILTER (WHERE entry_type IN ('earn','referral_bonus','campaign_bonus') OR (entry_type = 'adjust' AND points > 0)),0)::int AS earned,
      COALESCE(-SUM(points) FILTER (WHERE entry_type = 'redeem'),0)::int AS redeemed,
      COALESCE(-SUM(points) FILTER (WHERE entry_type = 'expire'),0)::int AS expired
    FROM points_ledger WHERE created_at >= ${since}`);
  const liability = await q(`SELECT COALESCE(SUM(GREATEST(points_balance,0)),0)::int AS outstanding FROM guests`);
  const rewards = await q(`SELECT count(*)::int AS used, COALESCE(SUM(discount_applied),0) AS value
    FROM guest_rewards WHERE status = 'used' AND used_at >= ${since}`);
  const referrals = await q(`SELECT count(*) FILTER (WHERE status = 'rewarded')::int AS success, count(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM referrals WHERE created_at >= ${since}`);
  const engagement = await q(`SELECT count(DISTINCT guest_id) FILTER (WHERE status = 'sent')::int AS reached,
      count(DISTINCT guest_id) FILTER (WHERE clicked_at IS NOT NULL OR opened_at IS NOT NULL OR read_at IS NOT NULL)::int AS engaged
    FROM notifications WHERE category = 'marketing' AND created_at >= ${since}`);
  const monthly = (await client.query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
      count(*)::int AS total, count(*) FILTER (WHERE is_repeat)::int AS repeat
    FROM bookings WHERE status NOT IN ('cancelled','refunded') AND created_at >= now() - interval '12 months'
    GROUP BY 1 ORDER BY 1`)).rows;
  return {
    members, returningGuests: returning.c, bookings,
    repeatRate: bookings.total ? Math.round((1000 * bookings.repeat) / bookings.total) / 10 : 0,
    points, liability, rewards, referrals, engagement,
    engagementRate: engagement.reached ? Math.round((1000 * engagement.engaged) / engagement.reached) / 10 : 0,
    monthly,
  };
}

/** تصنيف الضيوف حسب النشاط والقيمة */
export const SEGMENT_SQL = `CASE
  WHEN g.completed_stays = 0 THEN 'new'
  WHEN s.last_stay < current_date - 365 THEN 'dormant'
  WHEN s.spend >= 5000 OR g.completed_stays >= 5 THEN 'vip'
  WHEN g.completed_stays >= 2 THEN 'repeat'
  ELSE 'active' END`;
export const SEGMENT_LABELS = { new: 'جديد', active: 'نشط', repeat: 'متكرر', vip: 'عالي القيمة', dormant: 'خامل' };
