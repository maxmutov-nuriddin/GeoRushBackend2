const jwt = require('jsonwebtoken');
const { prisma } = require('../config/database');
const { hitUserRateLimit } = require('./userRateLimiter');

// ── Foydalanuvchi cache (30 soniya TTL) ───────────────────────────────────────
// Har REST so'rovda DB ga bormaslik uchun. Ban/delete/role o'zgarganda
// invalidateUserCache chaqiriladi — shunda keyingi so'rov yangi ma'lumot oladi.
// Banned userlar cache'ga kirmaydi (ban tekshiruvi har doim DB'dan).
const USER_CACHE_TTL = 30_000;
const _userCache = new Map(); // userId → { user, at }

function _getCached(uid) {
  const e = _userCache.get(uid);
  if (!e) return null;
  if (Date.now() - e.at > USER_CACHE_TTL) { _userCache.delete(uid); return null; }
  return e.user;
}
function _setCache(uid, user) { _userCache.set(uid, { user, at: Date.now() }); }
function invalidateUserCache(uid) { _userCache.delete(uid); }

// ── Secrets 1 — Bosqich 2: token manbai (Bearer header YOKI httpOnly cookie) ──
// Token AVVAL Authorization: Bearer'dan olinadi (mobil + joriy web — XULQ AYNAN O'ZGARMAYDI).
// Bearer YO'Q bo'lsa, httpOnly cookie (gr_at) ko'riladi (kelajakdagi web klient uchun).
// Cookie cross-site (SameSite=None) → CSRF himoyasi SHART: faqat Origin allowed ro'yxatда
// VA custom header (X-Requested-With) bo'lganda qabul qilinadi. Cross-site hujumchi custom
// header qo'sha olmaydi — CORS preflight ALLOWED_ORIGINS bilan uni bloklaydi.
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL    || 'http://localhost:5174',
  process.env.LANDING_URL  || 'http://localhost:5175',
].filter(Boolean);
const ACCESS_COOKIE = 'gr_at';

function _readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return null;
}

function _extractToken(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  // Bearer yo'q → cookie fallback (faqat CSRF-xavfsiz bo'lsa)
  const cookieTok = _readCookie(req, ACCESS_COOKIE);
  if (cookieTok) {
    const origin = req.headers.origin;
    const csrfOk = !!req.headers['x-requested-with'];
    const originOk = !!origin && ALLOWED_ORIGINS.includes(origin);
    if (csrfOk && originOk) return cookieTok;
  }
  return null;
}

const USER_SELECT = {
  id: true, username: true, phone: true, teamId: true, color: true, xp: true, level: true,
  totalArea: true, totalDistance: true, territoriesCaptured: true, territoriesLost: true,
  isOnline: true, expoPushToken: true, termsAccepted: true, isAdmin: true, isBanned: true,
  coins: true, ownedSkins: true, activeSkinColor: true, activeSkinMarker: true, activeSkinTrail: true,
  isPremium: true, premiumUntil: true, premiumTier: true,
  tokenVersion: true,
};

async function authenticate(req, res, next) {
  const token = _extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    let user = _getCached(decoded.userId);
    if (!user) {
      user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: USER_SELECT });
      if (user && !user.isBanned) _setCache(decoded.userId, user);
    }

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Akkaunt bloklangan', code: 'BANNED' });

    // Token bekor qilish tekshiruvi — FAQAT token'da `tv` bor VA user.tokenVersion bilan
    // mos kelmasa rad etiladi. Eski (tv'siz) tokenlar va migration'gacha bo'lgan holatlar
    // tekshiruvdan o'tib ketadi — shuning uchun hech kim kutilmaganda logout bo'lmaydi.
    if (typeof decoded.tv === 'number' && typeof user.tokenVersion === 'number'
        && decoded.tv !== user.tokenVersion) {
      return res.status(401).json({ error: 'Sessiya bekor qilingan, qaytadan kiring', code: 'TOKEN_REVOKED' });
    }

    // Per-user API rate-limit (IP emas — har akkaunt bo'yicha). Login PUBLIC bo'lgani uchun
    // bu yerga kelmaydi — faqat authenticate qilingan REST so'rovlar sanaladi. Jonli xarita
    // socketда, u ham bu sanoqqa kirmaydi. Limit oshsa 429 + Retry-After.
    const rl = hitUserRateLimit(user.id);
    if (!rl.ok) {
      res.set('Retry-After', String(rl.retryAfterSec));
      return res.status(429).json({
        error: 'Juda ko\'p so\'rov yuborildi. Biroz kuting.',
        code: 'USER_RATE_LIMITED',
        retryAfterSeconds: rl.retryAfterSec,
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Ban tekshiruvi — faqat connect paytida bir marta (har event'da emas).
    // isAdmin ham olinadi: kelajakda admin socket eventlarida ishlatish uchun.
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { isBanned: true, isAdmin: true },
    });
    if (!user) return next(new Error('User not found'));
    if (user.isBanned) return next(new Error('Account banned'));
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    socket.isAdmin = user.isAdmin || false;
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
}

module.exports = { authenticate, authenticateSocket, invalidateUserCache };
