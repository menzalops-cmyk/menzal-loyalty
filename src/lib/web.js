// أدوات الويب: الجلسات، حماية CSRF، التحقق من الصلاحيات، ومعالجة الأخطاء.
import { pool } from '../db.js';
import { config } from '../config.js';
import { hmac, randomToken, safeEqual } from './crypto.js';
import { can } from './permissions.js';
import { AppError } from './errors.js';

const COOKIE = { guest: 'mz_sid', staff: 'mz_staff' };
const cookieOpts = (maxAgeMs) => ({ httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: maxAgeMs, path: '/' });

export async function createSession(res, actorType, actorId) {
  const token = randomToken();
  const days = actorType === 'staff' ? 1 : 30;
  await pool.query(
    `INSERT INTO sessions (token_hash, actor_type, actor_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5))`,
    [hmac(token), actorType, actorId, randomToken(16), days],
  );
  res.cookie(COOKIE[actorType], token, cookieOpts(days * 86400000));
}

export async function destroySession(req, res, actorType) {
  const t = req.cookies[COOKIE[actorType]];
  if (t) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hmac(t)]);
  res.clearCookie(COOKIE[actorType], { path: '/' });
}

/** تحميل جلسة الضيف/الموظف + رمز CSRF لكل طلب */
export async function loadSessions(req, res, next) {
  try {
    let csrf = req.cookies.mz_csrf;
    if (!csrf || csrf.length < 20) {
      csrf = randomToken(16);
      res.cookie('mz_csrf', csrf, cookieOpts(7 * 86400000));
    }
    req.csrfToken = csrf;
    res.locals.csrf = csrf;
    for (const type of ['guest', 'staff']) {
      const t = req.cookies[COOKIE[type]];
      if (!t) continue;
      const s = (await pool.query(`SELECT * FROM sessions WHERE token_hash = $1 AND actor_type = $2 AND expires_at > now()`, [hmac(t), type])).rows[0];
      if (!s) continue;
      if (type === 'guest') {
        const g = (await pool.query(`SELECT * FROM guests WHERE id = $1 AND status = 'active'`, [s.actor_id])).rows[0];
        if (g) { req.guest = g; res.locals.guest = g; }
      } else {
        const u = (await pool.query('SELECT id, email, name, role FROM staff_users WHERE id = $1 AND active', [s.actor_id])).rows[0];
        if (u) { req.staff = u; res.locals.staff = u; }
      }
    }
    res.locals.can = (perm) => Boolean(req.staff && can(req.staff.role, perm));
    res.locals.path = req.path;
    res.locals.flash = req.cookies.mz_flash ? JSON.parse(Buffer.from(req.cookies.mz_flash, 'base64url').toString()) : null;
    if (req.cookies.mz_flash) res.clearCookie('mz_flash', { path: '/' });
    next();
  } catch (e) { next(e); }
}

export function flash(res, type, message) {
  res.cookie('mz_flash', Buffer.from(JSON.stringify({ type, message })).toString('base64url'), { httpOnly: true, sameSite: 'lax', maxAge: 30000, path: '/' });
}

/** التحقق من رمز CSRF لكل طلب يغير البيانات (نموذج double-submit) */
export function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // إلغاء الاشتراك بنقرة واحدة (RFC 8058) يُرسل من برامج البريد بدون رمز؛ الرمز السري في الرابط هو التحقق
  if (req.path.startsWith('/unsubscribe/')) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token');
  if (!sent || !req.cookies.mz_csrf || !safeEqual(sent, req.cookies.mz_csrf)) {
    return next(new AppError('انتهت صلاحية الصفحة، أعد تحميلها وحاول مرة أخرى', { status: 403, code: 'csrf' }));
  }
  next();
}

export const requireGuest = (req, res, next) => (req.guest ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
export const requireStaff = (req, res, next) => (req.staff ? next() : res.redirect('/admin/login'));
export const requirePerm = (perm) => (req, res, next) => {
  if (!req.staff) return res.redirect('/admin/login');
  if (!can(req.staff.role, perm)) return next(new AppError('ليست لديك صلاحية للوصول إلى هذه الصفحة', { status: 403 }));
  next();
};

/** تغليف المعالجات غير المتزامنة */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** عند خطأ أعمال في نموذج: العودة لنفس الصفحة مع رسالة */
export const back = (req, res, err, fallback = '/') => {
  flash(res, 'error', err.message);
  const ref = req.get('referer');
  res.redirect(ref && ref.startsWith(config.appUrl) ? ref : (ref?.startsWith('/') ? ref : fallback));
};

export const clientIp = (req) => req.ip;
