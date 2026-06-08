const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { prisma } = require('../config/database');
const { recordFailedAttempt, recordSuccess, getIp } = require('../middleware/ipBlocker');
const { tierOf, entitlementsPublic } = require('../config/tiers');

function generateToken(userId, username) {
  return jwt.sign({ userId, username }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
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
    const token = generateToken(user.id, user.username);
    res.json({ token, user: serializeUser(user) });
  } catch (err) { next(err); }
}

async function getMe(req, res) {
  res.json({ user: serializeUser(req.user) });
}

async function refreshToken(req, res) {
  const token = generateToken(req.user.id, req.user.username);
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
      ? existing.otpHash === inputHash
      : existing.otp === otp.trim();
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

    const { username, phone, password, otpToken, color = '#00ff88' } = req.body;

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

    const token = generateToken(user.id, user.username);
    res.status(201).json({ token, user: serializeUser(user) });
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
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });
    
    await prisma.oTPSession.delete({ where: { id: session.id } });

    res.json({ message: 'Parol muvaffaqiyatli yangilandi' });
  } catch (err) { next(err); }
}

module.exports = {
  login, getMe, refreshToken,
  requestOtp, verifyOtp, registerWithPhone, resetPasswordWithPhone,
};
