import { pool } from '../db.js';

/** تسجيل عملية في سجل التدقيق. يقبل client لتكون ضمن نفس المعاملة. */
export async function audit({ actorType, actorId = null, action, entity, entityId = null, data = null, ip = null }, client = pool) {
  await client.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorType, actorId, action, entity, entityId == null ? null : String(entityId), data ? JSON.stringify(data) : null, ip],
  );
}
