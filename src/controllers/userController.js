const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
// Umumiy (yagona) Prisma instansi — ulanish pulini tejaydi (alohida client emas).
const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { tierOf, entitlements } = require('../config/tiers');
const { getTerritoriesInBounds } = require('../services/territoryService');
const { suggestRoadGaps } = require('../services/roadSuggestService');
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

    // 13 haftalik (91 kun) faollik kalendari + streak uchun kengroq oyna olamiz.
    const CAL_DAYS = 91;
    const since = new Date(Date.now() - CAL_DAYS * 24 * 60 * 60 * 1000);
    const events = await prisma.gameEvent.findMany({
      where: {
        type: 'territory_captured',
        actorId: userId,
        createdAt: { gte: since }
      },
      select: { data: true, createdAt: true }
    });

    // Kun bo'yicha guruhlash: { 'YYYY-MM-DD': { count, area } }
    const byDay = new Map();
    for (const e of events) {
      const key = new Date(e.createdAt).toISOString().slice(0, 10);
      const cur = byDay.get(key) || { count: 0, area: 0 };
      cur.count += 1;
      cur.area += e.data?.area || 0;
      byDay.set(key, cur);
    }

    // Faollik kalendari (eng eski → bugun), GitHub uslubidagi to'r uchun.
    const calendar = [];
    for (let i = CAL_DAYS - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const v = byDay.get(key) || { count: 0, area: 0 };
      calendar.push({ date: key, count: v.count, area: v.area });
    }

    // Streak — bugundan (yoki kechadan) orqaga uzluksiz faol kunlar.
    const todayKey = new Date(); todayKey.setHours(0, 0, 0, 0);
    let current = 0;
    for (let i = 0; ; i++) {
      const d = new Date(todayKey); d.setDate(d.getDate() - i);
      const v = byDay.get(d.toISOString().slice(0, 10));
      if (v && v.count > 0) { current += 1; continue; }
      // Bugun hali o'ynamagan bo'lsa ham streak buzilmaydi — kechadan boshlanadi.
      if (i === 0) continue;
      break;
    }
    // Eng uzun streak — oyna ichidagi maksimal uzluksiz seriya.
    let longest = 0, run = 0;
    for (const day of calendar) {
      if (day.count > 0) { run += 1; longest = Math.max(longest, run); }
      else run = 0;
    }

    const activeDays = calendar.filter((d) => d.count > 0).length;
    const totalArea = calendar.reduce((s, d) => s + d.area, 0);
    const totalCaptures = calendar.reduce((s, d) => s + d.count, 0);
    const bestDay = calendar.reduce((b, d) => (d.count > (b?.count || 0) ? d : b), null);

    // Eski ilova versiyalari uchun haftalik (oxirgi 7 kun) saqlanadi.
    const weekly = calendar.slice(-7);

    const summary = {
      current, longest, activeDays, totalArea, totalCaptures,
      bestDay: bestDay && bestDay.count > 0 ? bestDay : null,
      windowDays: CAL_DAYS,
    };

    // Strategik xarita — Ultra (heatmap tier). heatPoints eski ilovalar uchun saqlanadi.
    let heatPoints = [];
    let strategic = null;
    if (ent.stats === 'heatmap') {
      const asGeo = (p) => (typeof p === 'string' ? JSON.parse(p) : p);
      const centroidOfRing = (ring) => {
        if (!ring || !ring.length) return null;
        let lat = 0, lng = 0;
        for (const c of ring) { lng += c[0]; lat += c[1]; }
        return [lat / ring.length, lng / ring.length];
      };
      const haversine = (a, b) => {
        const R = 6371000, toR = Math.PI / 180;
        const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
      };

      const myTerrs = await prisma.territory.findMany({
        where: { ownerId: userId },
        select: { id: true, polygon: true, area: true },
        take: 300,
      });

      const mine = [];
      let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
      for (const t of myTerrs) {
        const ring = asGeo(t.polygon)?.coordinates?.[0] || [];
        if (!ring.length) continue;
        for (const [lng, lat] of ring) {
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
        }
        mine.push({ polygon: ring, area: t.area || 0, centroid: centroidOfRing(ring) });
      }

      heatPoints = mine.map((m) => (m.centroid ? [m.centroid[0], m.centroid[1], Math.min(1, m.area / 50000)] : null)).filter(Boolean);

      if (mine.length) {
        // Yaqinroq ko'rinish: floor ~0.0045° (≈500 m). Chegarada TEGIB turgan qo'shni rivallar
        // baribir bbox'ga kiradi (ular mening hududim chetiga ulanган → ST_Intersects ushlaydi),
        // lekin xarita ko'proq zumlanib, atrof detalliroq ko'rinadi. bbox ham ko'rinishni, ham
        // raqib qidiruvini boshqaradi.
        const padLat = Math.max((maxLat - minLat) * 0.35, 0.0045);
        const padLng = Math.max((maxLng - minLng) * 0.35, 0.0045);
        const bbox = { swLat: minLat - padLat, swLng: minLng - padLng, neLat: maxLat + padLat, neLng: maxLng + padLng };

        let inZone = [];
        try { inZone = await getTerritoriesInBounds(bbox.swLat, bbox.swLng, bbox.neLat, bbox.neLng); } catch (_) { inZone = []; }

        const rivals = [];
        const areaByOwner = new Map(); // ownerId -> { username, color, area }
        for (const t of inZone) {
          if (String(t.ownerId) === userId) continue;
          const ring = asGeo(t.polygon)?.coordinates?.[0] || [];
          if (!ring.length) continue;
          const color = t.ownerColor || '#ff4444';
          const username = t.ownerUsername || '?';
          rivals.push({ polygon: ring, area: t.area || 0, color, username, centroid: centroidOfRing(ring) });
          const cur = areaByOwner.get(String(t.ownerId)) || { username, color, area: 0 };
          cur.area += t.area || 0;
          areaByOwner.set(String(t.ownerId), cur);
        }

        const myArea = mine.reduce((s, m) => s + m.area, 0);
        const ownersSorted = [...areaByOwner.values(), { area: myArea, me: true }].sort((a, b) => b.area - a.area);
        const rankInZone = ownersSorted.findIndex((o) => o.me) + 1;
        const biggestNeighbor = [...areaByOwner.values()].sort((a, b) => b.area - a.area)[0] || null;

        const myCentroids = mine.map((m) => m.centroid).filter(Boolean);
        let contested = 0;
        for (const r of rivals) {
          if (r.centroid && myCentroids.some((mc) => haversine(mc, r.centroid) < 300)) contested++;
        }

        // Tavsiyalar FAQAT haqiqiy YO'L bo'ylab chiziladi (OSM yo'llaridan hudud chetidagi bo'sh
        // bo'laklar). Eski to'r-katak (katta to'rtburchak, yo'l ustida emas) fallback OLIB TASHLANDI.
        // maxWaitMs: Overpass tez javob bersa yo'l-tavsiyalar DARHOL chiqadi (≤3s); sekin bo'lsa sahifa
        // qotmaydi — fonda keshlanadi, keyingi ochishda chiqadi.
        let gaps = [];
        try {
          const roadGaps = await suggestRoadGaps(bbox, mine.map((m) => m.polygon), rivals.map((r) => r.polygon), { maxWaitMs: 3000 });
          if (roadGaps && roadGaps.length) gaps = roadGaps;
        } catch (_) { /* tavsiyasiz */ }

        strategic = {
          bbox,
          mine: mine.map((m) => ({ polygon: m.polygon, area: m.area })),
          rivals: rivals.slice(0, 120).map((r) => ({ polygon: r.polygon, area: r.area, color: r.color, username: r.username })),
          gaps,
          myArea: Math.round(myArea),
          myCount: mine.length,
          rankInZone,
          rivalCount: areaByOwner.size,
          contested,
          biggestNeighbor: biggestNeighbor ? { username: biggestNeighbor.username, area: Math.round(biggestNeighbor.area) } : null,
        };
      }
    }

    res.json({ weekly, calendar, summary, heatPoints, strategic, stats: ent.stats });
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
