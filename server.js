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
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const territoryRoutes = require('./src/routes/territories');
const teamRoutes = require('./src/routes/teams');
const leaderboardRoutes = require('./src/routes/leaderboard');
const mapRoute = require('./src/routes/map');
const adminRoutes = require('./src/routes/admin');
const adminSetupRoutes = require('./src/routes/adminSetup');
const shopRoutes    = require('./src/routes/shop');
const premiumRoutes = require('./src/routes/premium');
const contactRoutes = require('./src/routes/contact');
const { globalLimiter } = require('./src/middleware/rateLimiter');
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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api', globalLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/admin-setup', adminSetupRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/territories', territoryRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
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

async function start() {
  try {
    await initializeDatabase();
    await initBot();

    // Premium expiry sweep — darrov bir marta, keyin har soatda. unref() — process chiqishini bloklamaydi.
    sweepExpiredPremium();
    setInterval(sweepExpiredPremium, PREMIUM_SWEEP_INTERVAL_MS).unref();

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
