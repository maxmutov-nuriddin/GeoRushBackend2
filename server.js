require('dotenv').config();
// Sentry — dotenv'dan keyin (SENTRY_DSN ni o'qishi uchun), boshqa modullardan oldin.
const Sentry = require('./instrument');

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.stack || err.message);
  // Sentry'ga yuborib, flush qilingach (maks 2s) chiqamiz — avvalgi exit(1) xulqi saqlanadi.
  Sentry.captureException(err);
  Sentry.close(2000).then(() => process.exit(1), () => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason?.stack || reason);
  Sentry.captureException(reason);
  Sentry.close(2000).then(() => process.exit(1), () => process.exit(1));
});
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const { initializeDatabase } = require('./src/config/database');
const { initializeSocket } = require('./src/socket');
const { setIo } = require('./src/socket/ioInstance');
const { flushAllPendingDistances } = require('./src/socket/handlers/locationHandler');
const { initBot } = require('./src/bot/otpBot');
const { initSupportBot } = require('./src/bot/supportBot');
const { runMergeBackfillOnce } = require('./src/services/territoryMergeBackfill');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const territoryRoutes = require('./src/routes/territories');
const teamRoutes = require('./src/routes/teams');
const leaderboardRoutes = require('./src/routes/leaderboard');
const friendRoutes = require('./src/routes/friends');
const referralRoutes = require('./src/routes/referral');
const mapRoute = require('./src/routes/map');
const adminRoutes = require('./src/routes/admin');
const adminSetupRoutes = require('./src/routes/adminSetup');
const shopRoutes    = require('./src/routes/shop');
const premiumRoutes = require('./src/routes/premium');
const contactRoutes = require('./src/routes/contact');
const { globalLimiter } = require('./src/middleware/rateLimiter');
const { securityMonitor } = require('./src/middleware/securityMonitor');
const { hppGuard } = require('./src/middleware/hpp');
const errorHandler = require('./src/middleware/errorHandler');
const logger = require('./src/utils/logger');
const { prisma } = require('./src/config/database');

// Premium muddati tugaganlarni davriy tozalash (data-hygiene).
// O'qishlar baribir premiumUntil ni dinamik tekshiradi; bu faqat isPremium flag'ini
// to'g'rilab turadi — kelajakda { isPremium: true } bo'yicha filtr xato bermasin.
const PREMIUM_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // har soatda
function sweepExpiredPremium() {
  prisma.user.updateMany({
    where: { isPremium: true, premiumUntil: { lt: new Date() } },
    data: { isPremium: false }
  }).catch((err) => logger.error('Premium sweep failed', err));
}

// Muddati o'tgan refresh tokenlarni davriy tozalash (data-hygiene).
// Token faqat ishlatilganda o'chiriladi — tashlab ketilgan qurilmalarning eskirgan
// yozuvlari shu sweep'siz abadiy qolib jadval cheksiz o'sadi. deleteMany idempotent,
// shuning uchun scale-out (ko'p instance) rejimida ham xavfsiz.
const REFRESH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // kuniga bir marta
function sweepExpiredRefreshTokens() {
  prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: new Date() } }
  }).then((r) => {
    if (r.count > 0) logger.info(`Refresh token sweep: ${r.count} ta eskirgan yozuv o'chirildi`);
  }).catch((err) => logger.error('Refresh token sweep failed', err));
}

const app = express();
// Render/nginx kabi reverse-proxy orqasida ishlaganda haqiqiy client IP'ni olish uchun.
// Bu bo'lmasa rate-limit va ipBlocker hamma so'rovni bitta IP sifatida ko'radi (yoki spoof qilinadi).
// Render bitta proxy hop ishlatadi → 1 (true emas — true barcha hopga ishonadi, xavfsizroq emas).
app.set('trust proxy', 1);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL    || 'http://localhost:5174',
  process.env.LANDING_URL  || 'http://localhost:5175',
  'https://georushweb.netlify.app',
  'https://www.georush.uz',
  'https://georush.uz',
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    // localhost/127.0.0.1 originlar faqat production BO'LMAGAN muhitda (lokal dev) ruxsat etiladi.
    // Productionда (NODE_ENV==='production') faqat ALLOWED_ORIGINS amal qiladi.
    if (process.env.NODE_ENV !== 'production' &&
        (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
};

const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 1e6,
});

// ── Scale-out (ixtiyoriy): REDIS_URL berilsa Socket.IO Redis adapter yoqiladi ──
// Shunda io.to(room).emit barcha instance'larga yetadi va bir nechta instance
// parallel ishlay oladi. REDIS_URL yo'q bo'lsa — hech narsa o'zgarmaydi (bitta
// instance, in-memory adapter, avvalgi xulq). Batafsil: SCALING.md
const { isRedisEnabled, createRedisClient } = require('./src/config/redis');
if (isRedisEnabled()) {
  const { createAdapter } = require('@socket.io/redis-adapter');
  const pubClient = createRedisClient('socket-pub');
  const subClient = createRedisClient('socket-sub');
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO Redis adapter yoqildi (scale-out rejimi)');
}

// HTTPS majburiy — Render TLS'ni reverse-proxy'da tugatadi va ichkariga http uzatadi.
// Productionда http kelsa, https'ga 301 redirect (x-forwarded-proto orqali). Render har doim
// x-forwarded-proto qo'yadi → redirect-loop bo'lmaydi. Lokal/dev'да (header yo'q) ishlamaydi.
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

app.use(helmet({
  // HSTS — brauzerni shu domenga FAQAT HTTPS bilan ulanishga majbur qiladi (1 yil).
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // CSP — faqat HTML render'da amal qiladi (JSON API javoblariga ta'sirsiz). /map sahifasi
  // leaflet (unpkg) + OpenStreetMap plitkalari + inline skript/uslub ishlatadi — shularga ruxsat.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://unpkg.com'],
      connectSrc: ["'self'", ...ALLOWED_ORIGINS],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
}));
app.use(cors(corsOptions));
app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
// Anomaliya monitoringi (401/403 spike, request spike) — boshqa middleware'lardan oldin.
app.use(securityMonitor);
// Body-size limit: 2MB. API faqat JSON qabul qiladi (fayl yuklash yo'q); eng katta
// payload — oflayn trail (MAX_TRAIL_POINTS=500 nuqta, ~20KB) — 2MB'dan ancha kichik.
// Avval 10mb edi — kerakmas darajada katta DoS yuzasi ochiq turardi.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Takroriy query-paramlarni skalarga keltirib HTTP Parameter Pollution'ni yopadi.
app.use(hppGuard);

app.use('/api', globalLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin-setup', adminSetupRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/territories', territoryRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/shop',    shopRoutes);
app.use('/api/premium', premiumRoutes);
app.use('/api/contact', contactRoutes);
app.use('/map', mapRoute);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Sentry Express error handler — mavjud errorHandler'dan OLDIN, barcha route'lardan KEYIN.
// Sentry o'chiq bo'lsa (DSN yo'q) bu hech narsa yubormaydi, faqat xatoni keyingi
// middleware'ga (sizning errorHandler) o'tkazadi — javob formati o'zgarmaydi.
Sentry.setupExpressErrorHandler(app);

app.use(errorHandler);

app.set('io', io);
setIo(io);
initializeSocket(io);

const PORT = process.env.PORT || 3001;

// Auth-sekretni start paytida tekshiramiz (fail-fast). Aks holda JWT_SECRET yo'q/zaif
// bo'lsa server jim ishga tushib, faqat birinchi login/verify'da yiqilardi — yoki
// (eng yomoni) zaif sekret bilan ishlab, tokenlarni qalbakilashtirishga yo'l ochardi.
function validateAuthSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET o\'rnatilmagan — server xavfsiz ishga tusha olmaydi.');
  }
  const MIN_LEN = 32;
  if (secret.length < MIN_LEN) {
    const msg = `JWT_SECRET juda qisqa (${secret.length} belgi) — kamida ${MIN_LEN} (tavsiya 64) belgi bo'lishi shart.`;
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    logger.warn(`[XAVFSIZLIK OGOHLANTIRISHI] ${msg}`);
  }
  if (process.env.NODE_ENV === 'production' && /your-super-secret|change-?me|example|secret-key/i.test(secret)) {
    throw new Error('JWT_SECRET namunaviy (placeholder) qiymatda — productionda haqiqiy tasodifiy sekret kerak.');
  }
}

async function start() {
  try {
    validateAuthSecret();
    await initializeDatabase();
    await initBot();
    await initSupportBot();

    // Premium expiry sweep — darrov bir marta, keyin har soatda. unref() — process chiqishini bloklamaydi.
    sweepExpiredPremium();
    setInterval(sweepExpiredPremium, PREMIUM_SWEEP_INTERVAL_MS).unref();

    // Eskirgan refresh tokenlar — darrov bir marta, keyin kuniga bir marta.
    sweepExpiredRefreshTokens();
    setInterval(sweepExpiredRefreshTokens, REFRESH_SWEEP_INTERVAL_MS).unref();

    // Mavjud zonalarni bir marta avtomatik birlashtirish (fonda — boot'ni bloklamaydi).
    // SystemFlag bilan faqat bir marta ishlaydi. TERRITORY_AUTO_MERGE=false bilan o'chadi.
    runMergeBackfillOnce().catch((err) => logger.warn('Hudud birlashtirish (boot) xatosi:', err.message));

    server.listen(PORT, () => {
      logger.info(`GeoRush server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

// Graceful shutdown: SIGTERM (pm2 reload, docker stop, deploy) da masofalarni saqlaydi
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — flushing pending distances before shutdown...');
  try {
    await flushAllPendingDistances();
    logger.info('Pending distances flushed');
  } catch (err) {
    logger.error('Failed to flush distances on SIGTERM', err);
  }
  server.close(() => process.exit(0));
});

module.exports = { app, server, io };
