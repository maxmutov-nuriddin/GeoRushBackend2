const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { prisma } = require('../config/database');
const { recordFailedAttempt, recordSuccess, getIp } = require('../middleware/ipBlocker');
const { tierOf, entitlementsPublic } = require('../config/tiers');
const { invalidateUserCache } = require('../middleware/auth');
const logger = require('../utils/logger');

// tokenVersion berilsa JWT'ga `tv` claim qo'shiladi (token-revoke uchun). Berilmasa
// claim QO'SHILMAYDI — token "legacy" sifatida ishlaydi va revoke-tekshiruvidan o'tadi
// (biror call-site o'tkazib yuborilsa ham hech qachon noto'g'ri 401 bermaydi).
function generateToken(userId, username, tokenVersion) {
  const payload = { userId, username };
  if (typeof tokenVersion === 'number') payload.tv = tokenVersion;
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

// ── Secrets 1 — Bosqich 1: httpOnly cookie (QO'SHIMCHA, hali o'qilmaydi) ──────
// Web klient kelajakda access tokenни localStorage o'rniga shu httpOnly cookie'dan
// oladi (XSS token o'g'irlay olmaydi). HOZIR cookie faqat O'RNATILADI; authenticate
// uni hali O'QIMAYDI, shuning uchun Bearer ishlatuvchi joriy klientlar (mobil + web)
// uchun HECH NARSA o'zgarmaydi. Frontend backend'dan boshqa domenda → cross-site:
// productionда SameSite=None + Secure shart (dev http'da lax + secure'siz).
const ACCESS_COOKIE = 'gr_at';
function setAccessCookie(res, token) {
  const prod = process.env.NODE_ENV === 'production';
  try {
    res.cookie(ACCESS_COOKIE, token, {
      httpOnly: true,
      secure: prod,
      sameSite: prod ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  } catch { /* best-effort — cookie javobni hech qachon buzmaydi */ }
}
function clearAccessCookie(res) {
  try { res.clearCookie(ACCESS_COOKIE, { path: '/' }); } catch { /* best-effort */ }
}

const REFRESH_TOKEN_BYTES = 48; // 96 char hex
const REFRESH_TOKEN_TTL_DAYS = 30;

// Bazada faqat SHA-256 hash saqlanadi — DB sizib chiqsa ham tokenlar ishlatib bo'lmaydi.
// Client har doim xom (raw) tokenni oladi va yuboradi.
function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Maxfiy qiymatlarni (OTP-hash, token) constant-time solishtirish — `===` har belgida
// erta to'xtaб timing side-channel (necha belgi to'g'ri ekanini sizdirish) ochadi.
// timingSafeEqual faqat teng uzunlikdagi bufer talab qiladi → avval uzunlikni tekshiramiz.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({ data: { token: hashRefreshToken(token), userId, expiresAt } });
  return token;
}

// Avval hash bo'yicha, topilmasa eski plaintext yozuvlar bo'yicha qidiradi
// (hashing'dan OLDIN berilgan tokenlar logout bo'lib qolmasligi uchun).
// Rotation tufayli plaintext yozuvlar birinchi almashinuvdayoq hash'ga o'tadi.
async function findRefreshTokenRecord(raw) {
  const record = await prisma.refreshToken.findUnique({ where: { token: hashRefreshToken(raw) } });
  if (record) return record;
  return prisma.refreshToken.findUnique({ where: { token: raw } });
}

function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    phone: u.phone || null,
    color: u.color,
    xp: u.xp,
    level: u.level,
    teamId: u.teamId || null,
    totalArea: u.totalArea || 0,
    totalDistance: u.totalDistance || 0,
    territoriesCaptured: u.territoriesCaptured || 0,
    territoriesLost: u.territoriesLost || 0,
    termsAccepted: u.termsAccepted || false,
    isAdmin: u.isAdmin || false,
    coins:        u.coins || 0,
    activeSkins: {
      color:  u.activeSkinColor  || null,
      marker: u.activeSkinMarker || null,
      trail:  u.activeSkinTrail  || null,
    },
    isPremium:    !!(u.isPremium && u.premiumUntil && new Date() < new Date(u.premiumUntil)),
    premiumUntil: u.premiumUntil || null,
    tier:         tierOf(u),
    entitlements: entitlementsPublic(tierOf(u)),
  };
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9) return '998' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '998' + digits.slice(1);
  return digits;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// ─── Login (faqat telefon) ────────────────────────────────────────────────────
async function login(req, res, next) {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'phone va password required' });

    const ip = getIp(req);
    const user = await prisma.user.findUnique({
      where: { phone: normalizePhone(phone) }
    });
    if (!user) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Noto\'g\'ri raqam yoki parol' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      recordFailedAttempt(ip);
      return res.status(401).json({ error: 'Noto\'g\'ri raqam yoki parol' });
    }

    if (user.isBanned) return res.status(403).json({ error: 'Akkaunt bloklangan', code: 'BANNED' });

    recordSuccess(ip);
    const token = generateToken(user.id, user.username, user.tokenVersion);
    const refreshToken = await createRefreshToken(user.id);
    setAccessCookie(res, token);
    res.json({ token, refreshToken, user: serializeUser(user) });
  } catch (err) { next(err); }
}

async function getMe(req, res) {
  res.json({ user: serializeUser(req.user) });
}

async function refreshToken(req, res) {
  const token = generateToken(req.user.id, req.user.username, req.user.tokenVersion);
  setAccessCookie(res, token);
  res.json({ token });
}

// ─── OTP sessiya yaratish ─────────────────────────────────────────────────────
async function requestOtp(req, res, next) {
  try {
    const { phone, purpose = 'register' } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const normalized = normalizePhone(phone);
    if (normalized.length < 10) return res.status(400).json({ error: 'Noto\'g\'ri raqam formati' });

    if (purpose === 'register') {
      const taken = await prisma.user.findFirst({ where: { phone: normalized } });
      if (taken) return res.status(409).json({ error: 'Bu raqam allaqachon ro\'yxatdan o\'tgan', code: 'PHONE_TAKEN' });
    }

    if (purpose === 'reset') {
      const exists = await prisma.user.findFirst({ where: { phone: normalized } });
      if (!exists) return res.status(404).json({ error: 'Bu raqam topilmadi' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    const otp   = generateOtp();

    await prisma.oTPSession.create({
      data: {
        token, phone: normalized, otp, purpose,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      }
    });

    const rawUsername = process.env.TELEGRAM_BOT_USERNAME;
    if (!rawUsername) {
      return res.status(503).json({ error: 'Telegram bot sozlanmagan. TELEGRAM_BOT_TOKEN ni tekshiring.' });
    }
    const botUsername = rawUsername.replace(/^@/, '');

    const botLink = `https://t.me/${botUsername}?start=${token}`;
    const tgLink  = `tg://resolve?domain=${botUsername}&start=${token}`;

    if (process.env.NODE_ENV === 'development') {
      logger.info(`[DEV] OTP Code for ${normalized}: ${otp}`);
      logger.info(`[DEV] Bot Link: ${botLink}`);
    }

    res.json({ token, botLink, tgLink });
  } catch (err) { next(err); }
}

// ─── OTP kodni tekshirish ─────────────────────────────────────────────────────
async function verifyOtp(req, res, next) {
  try {
    const { token, otp } = req.body;
    if (!token || !otp) return res.status(400).json({ error: 'token va otp required' });

    const ip = getIp(req);

    const existing = await prisma.oTPSession.findFirst({
      where: { token, expiresAt: { gt: new Date() } }
    });

    if (!existing) {
      recordFailedAttempt(ip);
      return res.status(400).json({ error: 'Sessiya topilmadi yoki muddati o\'tgan', code: 'SESSION_EXPIRED' });
    }
    if (!existing.otpSent) return res.status(400).json({ error: 'OTP hali yuborilmagan. Telegram botga o\'ting.', code: 'OTP_NOT_SENT' });

    const inputHash = crypto.createHash('sha256').update(otp.trim()).digest('hex');
    const isCorrect = existing.otpHash
      ? safeEqual(existing.otpHash, inputHash)
      : safeEqual(existing.otp || '', otp.trim());
    if (!isCorrect) {
      recordFailedAttempt(ip);
      return res.status(400).json({ error: 'Noto\'g\'ri kod', code: 'WRONG_OTP' });
    }

    if (existing.verified) {
      return res.status(400).json({ error: 'Sessiya allaqachon tasdiqlangan', code: 'ALREADY_VERIFIED' });
    }

    const session = await prisma.oTPSession.update({
      where: { token },
      data: { verified: true }
    });

    recordSuccess(ip);
    res.json({ verified: true, phone: session.phone, purpose: session.purpose });
  } catch (err) { next(err); }
}

// ─── Telefon orqali ro'yxatdan o'tish ────────────────────────────────────────
async function registerWithPhone(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, phone, password, otpToken, color = '#00ff88', referralCode } = req.body;

    const session = await prisma.oTPSession.findFirst({
      where: {
        token: otpToken, verified: true, purpose: 'register',
        expiresAt: { gt: new Date() },
      }
    });

    if (!session) return res.status(400).json({ error: 'OTP tasdiqlanmagan yoki muddati o\'tgan', code: 'OTP_INVALID' });

    const normalized = session.phone;

    const exists = await prisma.user.findFirst({
      where: { OR: [{ phone: normalized }, { username }] }
    });
    if (exists) return res.status(409).json({ error: 'Username yoki raqam allaqachon band' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        username, phone: normalized, passwordHash, color,
        coins: 50,
        telegramChatId: session.chatId ? String(session.chatId) : null,
      }
    });

    await prisma.oTPSession.delete({ where: { id: session.id } });

    // Referral kodi ixtiyoriy: fire-and-forget, await YO'Q — registratsiya javobini
    // kutdirmaydi va hech qachon buzmaydi (funksiya ichida o'zi try/catch qiladi).
    if (referralCode) {
      const { attachReferralOnRegister } = require('./referralController');
      attachReferralOnRegister(user.id, referralCode);
    }

    const token = generateToken(user.id, user.username, user.tokenVersion);
    const refreshToken = await createRefreshToken(user.id);
    setAccessCookie(res, token);
    res.status(201).json({ token, refreshToken, user: serializeUser(user) });
  } catch (err) { next(err); }
}

// ─── Telefon orqali parol tiklash ────────────────────────────────────────────
async function resetPasswordWithPhone(req, res, next) {
  try {
    const { otpToken, newPassword } = req.body;
    if (!otpToken || !newPassword) return res.status(400).json({ error: 'otpToken va newPassword required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Parol kamida 6 ta belgi' });

    const session = await prisma.oTPSession.findFirst({
      where: {
        token: otpToken, verified: true, purpose: 'reset',
        expiresAt: { gt: new Date() },
      }
    });

    if (!session) return res.status(400).json({ error: 'OTP tasdiqlanmagan yoki muddati o\'tgan', code: 'OTP_INVALID' });

    const user = await prisma.user.findFirst({ where: { phone: session.phone } });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // tokenVersion oshiriladi → parol tiklashdan OLDIN berilgan barcha access tokenlar
    // (o'g'irlangan bo'lishi mumkin) darhol bekor bo'ladi. Cache ham tozalanadi.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, tokenVersion: { increment: 1 } }
    });
    invalidateUserCache(user.id);

    await prisma.oTPSession.delete({ where: { id: session.id } });

    res.json({ message: 'Parol muvaffaqiyatli yangilandi' });
  } catch (err) { next(err); }
}

// ─── Refresh token orqali yangi access token olish ───────────────────────────
// POST /auth/token  { refreshToken }  → { token, refreshToken }
// Eski refresh token o'chiriladi, yangi token beriladi (rotation).
async function exchangeRefreshToken(req, res, next) {
  try {
    const { refreshToken: incoming } = req.body;
    if (!incoming) return res.status(400).json({ error: 'refreshToken required' });

    const record = await findRefreshTokenRecord(incoming);
    if (!record || new Date() > record.expiresAt) {
      // Eskirgan yoki topilmagan — ikkala holda ham o'chirib tashlaymiz
      if (record) await prisma.refreshToken.delete({ where: { id: record.id } }).catch(() => {});
      return res.status(401).json({ error: 'Refresh token yaroqsiz yoki muddati o\'tgan', code: 'REFRESH_INVALID' });
    }

    const user = await prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, username: true, isBanned: true, tokenVersion: true }
    });
    if (!user) {
      await prisma.refreshToken.delete({ where: { id: record.id } }).catch(() => {});
      return res.status(401).json({ error: 'Foydalanuvchi topilmadi' });
    }
    if (user.isBanned) {
      await prisma.refreshToken.delete({ where: { id: record.id } }).catch(() => {});
      return res.status(403).json({ error: 'Akkaunt bloklangan', code: 'BANNED' });
    }

    // Rotation: eski token o'chiriladi, yangi beriladi
    await prisma.refreshToken.delete({ where: { id: record.id } });
    const newRefreshToken = await createRefreshToken(user.id);
    const newAccessToken = generateToken(user.id, user.username, user.tokenVersion);

    setAccessCookie(res, newAccessToken);
    res.json({ token: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
}

// ─── Logout: refresh tokenni bekor qilish ─────────────────────────────────────
// POST /auth/logout  { refreshToken }
async function logout(req, res, next) {
  try {
    const { refreshToken: incoming } = req.body;
    if (incoming) {
      // Hash'langan ham, eski plaintext yozuv ham bekor qilinadi
      await prisma.refreshToken.deleteMany({
        where: { token: { in: [hashRefreshToken(incoming), incoming] } },
      });
    }
    clearAccessCookie(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = {
  login, getMe, refreshToken, exchangeRefreshToken, logout,
  requestOtp, verifyOtp, registerWithPhone, resetPasswordWithPhone,
};
