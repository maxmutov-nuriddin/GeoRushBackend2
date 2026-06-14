const jwt = require('jsonwebtoken');
const { prisma } = require('../config/database');

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

const USER_SELECT = {
  id: true, username: true, phone: true, teamId: true, color: true, xp: true, level: true,
  totalArea: true, totalDistance: true, territoriesCaptured: true, territoriesLost: true,
  isOnline: true, expoPushToken: true, termsAccepted: true, isAdmin: true, isBanned: true,
  coins: true, ownedSkins: true, activeSkinColor: true, activeSkinMarker: true, activeSkinTrail: true,
  isPremium: true, premiumUntil: true, premiumTier: true,
  tokenVersion: true,
};

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
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
