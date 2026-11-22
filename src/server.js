import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { loadSessions, csrfProtect, flash } from './lib/web.js';
import { AppError } from './lib/errors.js';
import * as fmt from './lib/format.js';
import { getSettingSync } from './services/settings.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(dir, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        // سمات style المضمنة لعرض أشرطة التقدم وألوان المستويات؛ السكربتات تبقى مقيدة بالكامل
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
  }));

  // واجهة التكامل تحتاج الجسم الخام للتحقق من التوقيع، لذلك تُركب قبل محللات النماذج
  app.use('/api', apiRoutes);

  app.use(express.static(path.join(dir, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 30, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => { flash(res, 'error', 'محاولات كثيرة، حاول بعد قليل'); res.redirect(req.originalUrl); } });
  app.use(['/login', '/signup', '/verify', '/admin/login'], (req, res, next) => (req.method === 'POST' ? authLimiter(req, res, next) : next()));

  app.use((req, res, next) => {
    res.locals.fmt = fmt;
    res.locals.L = fmt.LABELS;
    res.locals.brand = getSettingSync('brand_name', 'منزال');
    res.locals.appUrl = config.appUrl;
    res.locals.title = null;
    next();
  });
  app.use(loadSessions);
  app.use(csrfProtect);

  app.use(publicRoutes);
  app.use(authRoutes);
  app.use('/account', accountRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'الصفحة غير موجودة', status: 404, message: 'الصفحة التي تبحث عنها غير موجودة.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) console.error(err);
    const message = err instanceof AppError ? err.message : 'حدث خطأ غير متوقع. حاول مرة أخرى.';
    if (req.accepts(['html', 'json']) === 'json') return res.status(status).json({ error: message, code: err.code });
    // أخطاء النماذج: نعيد المستخدم لنفس الصفحة مع الرسالة
    if (err instanceof AppError && req.method === 'POST' && status < 500 && err.code !== 'csrf') {
      flash(res, 'error', message);
      return res.redirect(req.get('referer') || '/');
    }
    res.status(status).render('error', { title: 'خطأ', status, message });
  });
  return app;
}
