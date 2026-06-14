const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
// Umumiy (yagona) Prisma instansi — ulanish pulini tejaydi (alohida client emas).
const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { tierOf, entitlements } = require('../config/tiers');
const { escapeHtml } = require('../utils/telegram');
const { invalidateUserCache } = require('../middleware/auth');

async function getProfile(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        team: {
          select: { name: true, color: true, tag: true }
        }
      }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const isMe = String(user.id) === String(req.user.id);

    // Hamma uchun ochiq (public) maydonlar. phone/telegramChatId/expoPushToken/
    // lastLocation/coins kabi shaxsiy maydonlar FAQAT egasining o'ziga qaytariladi —
    // aks holda istalgan login qilgan user boshqalarning raqami va joylashuvini ko'rardi.
    const publicProfile = {
      id: user.id,
      username: user.username,
      color: user.color,
      avatarUrl: user.avatarUrl,
      xp: user.xp,
      level: user.level,
      totalArea: user.totalArea,
      totalDistance: user.totalDistance,
      territoriesCaptured: user.territoriesCaptured,
      territoriesLost: user.territoriesLost,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      createdAt: user.createdAt,
      teamId: user.teamId,
      isPremium: !!(user.isPremium && user.premiumUntil && new Date() < new Date(user.premiumUntil)),
      premiumUntil: user.premiumUntil,
      premiumTier: user.premiumTier,
      activeSkinMarker: user.activeSkinMarker,
      activeSkinTrail: user.activeSkinTrail,
    };

    let profile = publicProfile;
    if (isMe) {
      const { passwordHash, socketId, passwordResetToken, passwordResetExpires, ...own } = user;
      profile = { ...own, isPremium: publicProfile.isPremium };
    }

    res.json({
      user: {
        ...profile,
        teamName: user.team?.name,
        teamColor: user.team?.color,
        teamTag: user.team?.tag,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, color } = req.body;
    const updates = {};
    if (username) updates.username = username;
    if (color) updates.color = color;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const userId = req.user.id || req.user._id;

    const user = await prisma.user.update({
      where: { id: userId },
      data: updates,
      select: { username: true, color: true, xp: true, level: true, teamId: true }
    });

    if (color) {
      await prisma.territory.updateMany({
        where: { ownerId: userId },
        data: { color }
      });
      const io = getIo();
      if (io) io.emit('user:colorUpdate', { userId: userId.toString(), color });
    }

    res.json({ user });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username already taken' });
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    // Route validatori (newPassword min 6) endi haqiqatda qo'llanadi — avval natija
    // tekshirilmasdi, shuning uchun zaif (masalan 1 belgili) parol o'tib ketardi.
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id || req.user._id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);
    // Parol o'zgartirilganda HAMMA qurilmadan chiqarish:
    //  - tokenVersion++ → boshqa qurilmalardagi mavjud access tokenlar darhol bekor bo'ladi
    //  - barcha refresh tokenlar o'chiriladi → ular yangi token ololmaydi (qayta login shart)
    // Joriy qurilma ham chiqib, yangi parol bilan qayta kiradi (xavfsiz, kutilgan xulq).
    // Mijozlar 401 → refresh urinadi → refresh yo'q → login ekraniga (silliq, crash yo'q).
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, tokenVersion: { increment: 1 } }
    });
    await prisma.refreshToken.deleteMany({ where: { userId } });
    invalidateUserCache(userId);
    res.json({ message: 'Password updated', loggedOutEverywhere: true });
  } catch (err) {
    next(err);
  }
}

async function getOnlinePlayers(req, res, next) {
  try {
    const players = await prisma.user.findMany({
      where: {
        isOnline: true,
        isAdmin: false,
        lastLocation: { not: null }
      },
      select: { id: true, username: true, color: true, level: true, teamId: true, lastLocation: true }
    });

    res.json({
      players: players.map((p) => ({
        id: p.id,
        username: p.username,
        color: p.color,
        level: p.level,
        teamId: p.teamId,
        lat: p.lastLocation?.coordinates?.[1],
        lng: p.lastLocation?.coordinates?.[0],
      })),
    });
  } catch (err) {
    next(err);
  }
}

// O'chirilayotgan hududlar bo'yicha jamoa maydonlarini to'g'ri kamaytirish:
// faqat o'sha jamoa nomidan egallangan hududlar (t.teamId) hisobga olinadi.
// Avval barcha maydon joriy jamoadan ayirilardi — jamoa statistikasi buzilardi.
async function decrementTeamAreas(territories) {
  const byTeam = new Map();
  for (const t of territories) {
    if (t.teamId) byTeam.set(t.teamId, (byTeam.get(t.teamId) || 0) + (t.area || 0));
  }
  for (const [teamId, area] of byTeam) {
    await prisma.team.update({
      where: { id: teamId },
      data: { totalArea: { decrement: area } }
    }).catch(() => {}); // jamoa o'chirilgan bo'lishi mumkin
  }
}

async function clearMyData(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const territories = await prisma.territory.findMany({ where: { ownerId: userId } });

    await prisma.territory.deleteMany({ where: { ownerId: userId } });
    await prisma.gameEvent.deleteMany({ where: { actorId: userId } });

    await prisma.user.update({
      where: { id: userId },
      data: {
        xp: 0, level: 1, totalArea: 0, totalDistance: 0, territoriesCaptured: 0, territoriesLost: 0,
        lastLocation: null
      }
    });

    await decrementTeamAreas(territories);

    const io = getIo();
    if (io) {
      for (const t of territories) {
        io.to('global').emit('territory:removed', { territoryId: t.id.toString() });
      }
    }

    res.json({ message: 'All data cleared' });
  } catch (err) {
    next(err);
  }
}

async function deleteAccount(req, res, next) {
  try {
    const { password } = req.body;
    const userId = req.user.id || req.user._id;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(400).json({ error: 'Parol noto\'g\'ri' });

    const territories = await prisma.territory.findMany({
      where: { ownerId: userId },
      select: { id: true, teamId: true, area: true }
    });

    await prisma.territory.deleteMany({ where: { ownerId: userId } });
    await decrementTeamAreas(territories);

    if (user.teamId) {
      await prisma.team.update({
        where: { id: user.teamId },
        data: { memberCount: { decrement: 1 } }
      }).catch(() => {});
    }

    await prisma.team.updateMany({
      where: { ownerId: userId },
      data: { ownerId: null }
    });

    // Majburiy (required) FK bog'lanishlar user o'chirilishidan OLDIN tozalanishi shart —
    // aks holda Postgres RESTRICT tufayli delete 500 bilan yiqiladi (har anti-cheat
    // logi yoki jamoa so'rovi bor foydalanuvchida shunday bo'lardi).
    await prisma.teamRequest.deleteMany({ where: { userId } });
    await prisma.antiCheatLog.deleteMany({ where: { userId } });
    await prisma.warning.deleteMany({ where: { OR: [{ userId }, { adminId: userId }] } });

    await prisma.user.delete({ where: { id: userId } });

    const io = getIo();
    if (io) {
      for (const t of territories) {
        io.to('global').emit('territory:removed', { territoryId: t.id.toString() });
      }
    }

    res.json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
}

async function savePushToken(req, res, next) {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    const userId = req.user.id || req.user._id;
    await prisma.user.update({
      where: { id: userId },
      data: { expoPushToken: token }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function acceptTerms(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    await prisma.user.update({
      where: { id: userId },
      data: { termsAccepted: true }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function getActivity(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true, premiumUntil: true, premiumTier: true }
    });
    const ent = entitlements(tierOf(u));
    if (ent.stats === 'basic') {
      return res.status(403).json({ error: 'Statistika Pro yoki Ultra uchun', code: 'STATS_LOCKED' });
    }

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const events = await prisma.gameEvent.findMany({
      where: {
        type: 'territory_captured',
        actorId: userId,
        createdAt: { gte: since }
      },
      select: { data: true, createdAt: true }
    });

    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const nextDate = new Date(d); nextDate.setDate(d.getDate() + 1);
      const dayEvents = events.filter((e) => e.createdAt >= d && e.createdAt < nextDate);
      weekly.push({
        date: d.toISOString().slice(0, 10),
        count: dayEvents.length,
        area: dayEvents.reduce((sum, e) => sum + (e.data?.area || 0), 0),
      });
    }

    let heatPoints = [];
    if (ent.stats === 'heatmap') {
      const terrs = await prisma.territory.findMany({
        where: { ownerId: userId },
        select: { polygon: true, area: true },
        take: 300
      });
      heatPoints = terrs.map((tr) => {
        const ring = tr.polygon?.coordinates?.[0] || [];
        if (!ring.length) return null;
        let lat = 0, lng = 0;
        for (const c of ring) { lng += c[0]; lat += c[1]; }
        return [lat / ring.length, lng / ring.length, Math.min(1, (tr.area || 0) / 50000)];
      }).filter(Boolean);
    }

    res.json({ weekly, heatPoints, stats: ent.stats });
  } catch (err) {
    next(err);
  }
}

async function setLocationMeta(req, res, next) {
  try {
    const { city, country } = req.body;
    const update = {};
    if (typeof city === 'string') update.city = city.trim().slice(0, 80) || null;
    if (typeof country === 'string') update.country = country.trim().slice(0, 80) || null;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'city/country required' });
    const userId = req.user.id || req.user._id;
    await prisma.user.update({
      where: { id: userId },
      data: update
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function sendSupport(req, res, next) {
  try {
    const { telegramUsername, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return res.status(503).json({ error: 'Support not configured' });

    const { username } = req.user;
    const tg = telegramUsername ? `@${telegramUsername.replace(/^@/, '')}` : '—';
    const now = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    // Foydalanuvchi qiymatlari HTML-escape — Markdown inyeksiya/buzilishi yo'q.
    const text = [
      `🎮 <b>GeoRush — Foydalanuvchi murojaati</b>`,
      ``,
      `👤 <b>Ism:</b> ${escapeHtml(username)}`,
      `📱 <b>Telegram:</b> ${escapeHtml(tg)}`,
      `🕐 <b>Vaqt:</b> ${now}`,
      ``,
      `💬 <b>Xabar:</b>`,
      escapeHtml(message.trim()),
    ].join('\n');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Failed to send' });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function sendPublicSupport(req, res, next) {
  try {
    const { phone, telegramUsername, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return res.status(503).json({ error: 'Support not configured' });

    const tg  = telegramUsername ? `@${telegramUsername.replace(/^@/, '')}` : '—';
    const ph  = phone || '—';
    const now = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    // Foydalanuvchi qiymatlari HTML-escape — Markdown inyeksiya/buzilishi yo'q.
    const text = [
      `🎮 <b>GeoRush — Yordam so'rovi</b>`,
      ``,
      `📱 <b>Telefon:</b> ${escapeHtml(ph)}`,
      `✈️ <b>Telegram:</b> ${escapeHtml(tg)}`,
      `🕐 <b>Vaqt:</b> ${now}`,
      ``,
      `💬 <b>Xabar:</b>`,
      escapeHtml(message.trim()),
    ].join('\n');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Failed to send' });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, updateProfile, changePassword, getOnlinePlayers, clearMyData, deleteAccount, savePushToken, acceptTerms, setLocationMeta, getActivity, sendSupport, sendPublicSupport };
