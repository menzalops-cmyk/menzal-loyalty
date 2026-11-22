// واجهة التكامل مع منصة/نظام حجوزات خارجي (PMS / Channel Manager / موقع الحجز).
// المنصة ترسل أحداث الحجز إلى هذا العنوان، ونظام الولاء يمنح النقاط عند وصول حالة completed.
import express, { Router } from 'express';
import crypto from 'node:crypto';
import { pool, tx } from '../db.js';
import { config } from '../config.js';
import { recordBooking, transition } from '../services/bookings.js';
import { audit } from '../lib/audit.js';
import { AppError } from '../lib/errors.js';

const r = Router();

function verifySignature(raw, header) {
  if (!config.bookingWebhookSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.bookingWebhookSecret).update(raw).digest('hex')}`;
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PATH_TO = {
  confirmed: ['confirmed'],
  checked_in: ['confirmed', 'checked_in'],
  completed: ['confirmed', 'checked_in', 'completed'],
  cancelled: ['cancelled'],
  refunded: ['refunded'],
};

/** نقل حجز موجود إلى حالة جديدة عبر الخطوات المسموحة فقط */
async function advance(client, booking, target) {
  const order = ['pending', 'confirmed', 'checked_in', 'completed'];
  let current = booking.status;
  for (const step of PATH_TO[target] || []) {
    if (current === step) continue;
    if (order.includes(step) && order.indexOf(step) <= order.indexOf(current)) continue;
    if (step === 'checked_in' && current === 'confirmed' && target === 'completed') {
      // يمكن الانتقال مباشرة من confirmed إلى completed
      continue;
    }
    const b = await transition(client, booking.id, step, { actor: 'integration:webhook' });
    current = b.status;
  }
  return current;
}

r.post('/integrations/bookings', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
  try {
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!verifySignature(raw, req.get('x-menzal-signature'))) return res.status(401).json({ error: 'invalid signature' });
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid json' }); }
    const eventId = String(payload.event_id || '').slice(0, 120);
    const bk = payload.booking || {};
    if (!eventId || !bk.external_ref) return res.status(422).json({ error: 'event_id and booking.external_ref are required' });
    const provider = String(payload.provider || 'external').slice(0, 40);

    const ins = await pool.query(
      `INSERT INTO integration_events (provider, event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, event_id) DO UPDATE SET error = NULL, payload = EXCLUDED.payload
       WHERE integration_events.processed_at IS NULL RETURNING id`,
      [provider, eventId, String(payload.type || 'booking.upsert'), payload],
    );
    if (!ins.rowCount) return res.json({ ok: true, duplicate: true });
    const evId = ins.rows[0].id;

    try {
      const result = await tx(async (c) => {
        const unit = (await c.query('SELECT id FROM units WHERE external_id = $1 OR id::text = $2', [String(bk.unit_external_id || ''), String(bk.unit_id || '')])).rows[0];
        if (!unit) throw new AppError(`unit not found: ${bk.unit_external_id || bk.unit_id}`, { status: 422 });
        const status = String(bk.status || 'pending');
        if (!['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'refunded'].includes(status)) throw new AppError('invalid status', { status: 422 });
        let booking = (await c.query(`SELECT * FROM bookings WHERE source = 'external' AND external_ref = $1 FOR UPDATE`, [String(bk.external_ref)])).rows[0];
        if (!booking) {
          booking = await recordBooking(c, {
            contactName: bk.guest?.name || 'ضيف', contactEmail: bk.guest?.email, contactPhone: bk.guest?.phone,
            unitId: unit.id, checkIn: bk.check_in, checkOut: bk.check_out, guestsCount: Number(bk.guests_count) || 1,
            total: bk.total_amount != null ? Number(bk.total_amount) : undefined, externalRef: String(bk.external_ref),
            status: status === 'refunded' ? 'completed' : status,
          }, { actor: 'integration:webhook', source: 'external' });
          if (status === 'refunded') booking = await transition(c, booking.id, 'refunded', { actor: 'integration:webhook' });
        } else {
          await advance(c, booking, status);
          if (bk.refunded_amount != null && booking.status === 'completed') {
            const diff = Number(bk.refunded_amount) - Number(booking.refunded_amount);
            if (diff > 0) await transition(c, booking.id, 'partial_refund', { actor: 'integration:webhook', refundAmount: diff });
          }
        }
        const fresh = (await c.query('SELECT id, booking_ref, status, guest_id FROM bookings WHERE id = $1', [booking.id])).rows[0];
        await audit({ actorType: 'integration', action: 'webhook.booking', entity: 'booking', entityId: fresh.id, data: { eventId, status } }, c);
        return fresh;
      });
      await pool.query('UPDATE integration_events SET processed_at = now() WHERE id = $1', [evId]);
      res.json({ ok: true, booking: result });
    } catch (e) {
      await pool.query('UPDATE integration_events SET error = $2 WHERE id = $1', [evId, e.message]);
      // الحدث يبقى غير معالج مع سبب الخطأ، ويمكن إعادة إرساله بنفس event_id بعد إصلاح المشكلة
      res.status(e.status || 500).json({ error: e.message });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

export default r;
