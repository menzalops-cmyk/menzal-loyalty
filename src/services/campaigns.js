// الحملات التسويقية: تحديد الجمهور، الجدولة، الإرسال (مع احترام الموافقات)، وقياس النتائج.
import { AppError } from '../lib/errors.js';
import { notify } from './notifications.js';
import { issueVoucher } from './rewards.js';
import { audit } from '../lib/audit.js';
import { pool, tx } from '../db.js';

/**
 * بناء استعلام الجمهور من معايير الشريحة. كل القيم تمرر كمعاملات (لا حقن SQL).
 * المعايير:
 *  stayed_within_days   أقام إقامة مكتملة خلال آخر N يوم
 *  no_rebook            لم يحجز مرة أخرى بعد آخر إقامة مكتملة (ولا يوجد حجز قادم)
 *  inactive_days        لا يوجد أي حجز منذ N يوم
 *  min_stays/max_stays  عدد الإقامات المكتملة
 *  tier_id, min_points, home_city, never_stayed
 */
export function buildSegmentQuery(seg = {}) {
  const where = [`g.status = 'active'`];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const int = (v) => (v === '' || v == null ? null : Number.parseInt(v, 10));

  if (int(seg.stayed_within_days)) {
    where.push(`EXISTS (SELECT 1 FROM bookings b WHERE b.guest_id = g.id AND b.status = 'completed' AND b.check_out >= current_date - ${p(int(seg.stayed_within_days))}::int)`);
  }
  if (seg.no_rebook === true || seg.no_rebook === 'true' || seg.no_rebook === 'on') {
    where.push(`g.completed_stays > 0 AND NOT EXISTS (
      SELECT 1 FROM bookings nb WHERE nb.guest_id = g.id AND nb.status IN ('pending','confirmed','checked_in','completed')
        AND nb.created_at > (SELECT max(lb.completed_at) FROM bookings lb WHERE lb.guest_id = g.id AND lb.status = 'completed'))`);
  }
  if (int(seg.inactive_days)) {
    where.push(`NOT EXISTS (SELECT 1 FROM bookings b WHERE b.guest_id = g.id AND b.status <> 'cancelled' AND b.created_at >= now() - make_interval(days => ${p(int(seg.inactive_days))}))`);
  }
  if (int(seg.min_stays) != null) where.push(`g.completed_stays >= ${p(int(seg.min_stays))}`);
  if (int(seg.max_stays) != null) where.push(`g.completed_stays <= ${p(int(seg.max_stays))}`);
  if (seg.never_stayed === true || seg.never_stayed === 'on') where.push('g.completed_stays = 0');
  if (int(seg.tier_id)) where.push(`g.tier_id = ${p(int(seg.tier_id))}`);
  if (int(seg.min_points)) where.push(`g.points_balance >= ${p(int(seg.min_points))}`);
  if (seg.home_city) where.push(`g.home_city = ${p(String(seg.home_city))}`);
  return { sql: `SELECT g.* FROM guests g WHERE ${where.join(' AND ')}`, params };
}

/** معاينة حجم الجمهور وعدد من يمكن الوصول إليهم بكل قناة */
export async function previewAudience(segment, client = pool) {
  const { sql, params } = buildSegmentQuery(segment);
  const r = (await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE email IS NOT NULL AND consent_email_marketing)::int AS email,
            count(*) FILTER (WHERE phone IS NOT NULL AND consent_whatsapp AND consent_whatsapp_marketing)::int AS whatsapp
       FROM (${sql}) s`, params,
  )).rows[0];
  return r;
}

/**
 * إرسال حملة: إنشاء الإشعارات (مع تسجيل غير المؤهلين كـ "تخطي" للقياس)، وإصدار المكافأة إن وجدت.
 * testGuestIds: إرسال تجريبي لضيوف محددين دون تغيير حالة الحملة.
 */
export async function sendCampaign(campaignId, { testGuestIds = null, actorId = null } = {}) {
  return tx(async (client) => {
    const c = (await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
    if (!c) throw new AppError('الحملة غير موجودة', { status: 404 });
    if (!testGuestIds && !['draft', 'scheduled'].includes(c.status)) throw new AppError('تم إرسال هذه الحملة مسبقًا');
    let recipients;
    if (testGuestIds) {
      recipients = (await client.query('SELECT * FROM guests WHERE id = ANY($1)', [testGuestIds])).rows;
    } else {
      const { sql, params } = buildSegmentQuery(c.segment);
      recipients = (await client.query(sql, params)).rows;
      await client.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [campaignId]);
    }
    let count = 0;
    const testTag = testGuestIds ? `test:${Date.now()}` : 'live';
    for (const g of recipients) {
      let vars = {};
      if (c.reward_id && !testGuestIds) {
        const { voucher, reward } = await issueVoucher(client, {
          guestId: g.id, rewardId: c.reward_id, source: 'campaign', sourceRef: String(c.id), skipEligibility: true, notifyGuest: false,
        });
        if (voucher) vars = { code: voucher.code, reward_name: reward?.name || '' };
      }
      const created = await notify(client, {
        guestId: g.id, subject: testGuestIds ? `[تجربة] ${c.subject || ''}` : c.subject, body: c.body, vars,
        category: 'marketing', channels: ['in_app', ...c.channels.filter((ch) => ch !== 'in_app')],
        link: c.segment?.link || '/account', dedupeKey: `campaign:${c.id}:${testTag}`,
        campaignId: testGuestIds ? null : c.id, recordSkipped: !testGuestIds,
      });
      if (created.some((n) => n.status !== 'skipped')) count++;
    }
    if (!testGuestIds) {
      await client.query(`UPDATE campaigns SET status = 'sent', sent_at = now(), recipients_count = $2 WHERE id = $1`, [campaignId, count]);
    }
    await audit({ actorType: actorId ? 'staff' : 'system', actorId, action: testGuestIds ? 'campaign.test' : 'campaign.send', entity: 'campaign', entityId: campaignId, data: { recipients: count } }, client);
    return { recipients: count, audience: recipients.length };
  });
}

/** إرسال الحملات المجدولة المستحقة (يستدعيها العامل الخلفي) */
export async function runScheduledCampaigns() {
  const due = (await pool.query(`SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now()`)).rows;
  for (const { id } of due) await sendCampaign(id);
  return due.length;
}

/** نتائج الحملة: الوصول، الفتح، النقر، الحجوزات والإيرادات المنسوبة */
export async function campaignStats(campaignId, client = pool) {
  const n = (await client.query(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND channel <> 'in_app')::int AS sent,
            count(*) FILTER (WHERE status = 'sent' AND channel = 'in_app')::int AS in_app,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
            count(DISTINCT guest_id) FILTER (WHERE clicked_at IS NOT NULL OR read_at IS NOT NULL)::int AS engaged
       FROM notifications WHERE campaign_id = $1`, [campaignId],
  )).rows[0];
  const b = (await client.query(
    `SELECT count(*)::int AS bookings, COALESCE(SUM(total_amount - refunded_amount),0) AS revenue
       FROM bookings WHERE campaign_id = $1 AND status NOT IN ('cancelled','refunded')`, [campaignId],
  )).rows[0];
  const reached = (await client.query(`SELECT count(DISTINCT guest_id)::int AS c FROM notifications WHERE campaign_id = $1 AND status = 'sent'`, [campaignId])).rows[0].c;
  return { ...n, ...b, reached, engagementRate: reached ? Math.round((1000 * n.engaged) / reached) / 10 : 0 };
}
