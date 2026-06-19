const bcrypt = require('bcryptjs');
// Umumiy (yagona) Prisma instansi — har modulda alohida `new PrismaClient()` ulanish
// pulini ko'paytirib, ko'p foydalanuvchida ulanishlarni tugatadi. Bitta pool ishlatamiz.
const { prisma } = require('../config/database');
const { setPlayerTeam } = require('../socket/index');
const onlineStore = require('../services/onlineStore');
const { TIERS } = require('../config/tiers');
const { invalidateUserCache } = require('../middleware/auth');
const { recordPremiumPurchase, discountedSom, baseSomFor } = require('../services/premiumLedger');
const { mergeAllOwnTerritories } = require('../services/territoryMergeBackfill');

// Admin pagination uchun `take` qiymatini chegaralash — `?limit=999999` kabi so'rov
// katta javob/DoS yaratmasin. Default destructuring (20/30/50) saqlanadi; faqat yuqori
// chegara (200) qo'yiladi va noto'g'ri/manfiy qiymat default'ga tushadi.
function clampLimit(value, fallback = 20, max = 200) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, max);
  return Math.min(n, max);
}

// ─── Dashboard stats ───────────────────────────────────────────────────────────
async function getStats(req, res, next) {
  try {
    const now = new Date();
    const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const week      = new Date(Date.now() - 7  * 86400000);
    const month     = new Date(Date.now() - 30 * 86400000);

    const [
      totalUsers, bannedUsers, adminUsers,
      totalTerritories, totalTeams, eventsToday,
      onlineUsers, antiCheatToday, warningsTotal,
      newToday, newYesterday, newWeek, newMonth,
      premiumTotal, premiumPro, premiumUltra,
      premiumWeek, premiumMonth,
      coinsResult, revPurchase,
      revPurchaseMonth, paidPurchasesCount, freeGrantsCount, baseAgg, gameAgg,
      revToday, revWeek, revPro, revUltra, userAvg, usersInTeam, publicTeams, antiCheatTypes,
      playSum, activeUsers, churnedUsers, dailyToday,
    ] = await Promise.all([
      prisma.user.count({ where: { isAdmin: false } }),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.user.count({ where: { isAdmin: true } }),
      // Admin akkauntlari statistikaga kirmaydi (relation orqali — bu jadvallarda isAdmin yo'q).
      // NOT { ...isAdmin: true } — admin'larni chiqaradi, egasiz (null) yozuvlarni saqlaydi.
      prisma.territory.count({ where: { owner: { isAdmin: false } } }),
      prisma.team.count({ where: { NOT: { owner: { isAdmin: true } } } }),
      prisma.gameEvent.count({ where: { createdAt: { gte: today }, NOT: { actor: { isAdmin: true } } } }),
      prisma.user.count({ where: { isOnline: true, isAdmin: false } }),
      prisma.antiCheatLog.count({ where: { createdAt: { gte: today }, user: { isAdmin: false } } }),
      prisma.warning.count({ where: { user: { isAdmin: false } } }),
      // Ro'yxatdan o'tganlar
      prisma.user.count({ where: { createdAt: { gte: today }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: yesterday, lt: today }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: week }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: month }, isAdmin: false } }),
      // Premium statistika — admin akkauntlari daromad/statistikaga kirmaydi (isAdmin: false)
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, premiumTier: 'pro', premiumIsGift: false, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, premiumTier: 'ultra', premiumIsGift: false, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, updatedAt: { gte: week }, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, updatedAt: { gte: month }, isAdmin: false } }),
      // Coins iqtisodi
      prisma.user.aggregate({ _sum: { coins: true }, where: { isAdmin: false } }),
      // HAQIQIY daromad — chegirmadan keyingi to'langan summalar yig'indisi
      prisma.premiumPurchase.aggregate({ _sum: { amountSom: true, amountStars: true } }).catch(() => null),
      // Bu oygi haqiqiy daromad (chegirmadan keyin to'langan)
      prisma.premiumPurchase.aggregate({ where: { createdAt: { gte: month } }, _sum: { amountSom: true, amountStars: true } }).catch(() => null),
      // To'lovli xaridlar soni (ledger yozuvlari — har biri haqiqiy to'lov)
      prisma.premiumPurchase.count().catch(() => 0),
      // Faol tekin/bonus (sovg'a) premiumlar — daromad EMAS
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, premiumIsGift: true, isAdmin: false } }),
      // To'liq (chegirmasiz) narx yig'indisi — berilgan chegirmani hisoblash uchun (base − paid)
      prisma.premiumPurchase.aggregate({ _sum: { baseSom: true } }).catch(() => null),
      // O'yin iqtisodi: jami egallangan hudud + jami masofa (admin'siz)
      prisma.user.aggregate({ where: { isAdmin: false }, _sum: { totalArea: true, totalDistance: true } }),
      // Daromad dinamikasi (haqiqiy to'langan so'm): bugun va bu hafta
      prisma.premiumPurchase.aggregate({ where: { createdAt: { gte: today } }, _sum: { amountSom: true } }).catch(() => null),
      prisma.premiumPurchase.aggregate({ where: { createdAt: { gte: week } }, _sum: { amountSom: true } }).catch(() => null),
      // Daromad tarif bo'yicha (haqiqiy to'langan so'm)
      prisma.premiumPurchase.aggregate({ where: { tier: 'pro' }, _sum: { amountSom: true } }).catch(() => null),
      prisma.premiumPurchase.aggregate({ where: { tier: 'ultra' }, _sum: { amountSom: true } }).catch(() => null),
      // Foydalanuvchi o'rtachalari (admin'siz)
      prisma.user.aggregate({ where: { isAdmin: false }, _avg: { level: true, xp: true } }),
      // Jamoadagi o'yinchilar + ochiq jamoalar
      prisma.user.count({ where: { isAdmin: false, teamId: { not: null } } }),
      prisma.team.count({ where: { isPublic: true } }),
      // Anti-cheat turlari bo'yicha taqsimot (admin'siz)
      prisma.antiCheatLog.groupBy({ by: ['type'], _count: { type: true }, where: { user: { isAdmin: false } } }).catch(() => []),
      // Sessiya vaqti (o'rtacha = jami / sessiyalar soni) — admin'siz
      prisma.user.aggregate({ where: { isAdmin: false }, _sum: { totalPlaytimeSec: true, sessionCount: true } }).catch(() => null),
      // Saqlanish: faol (30 kun ichida ko'rilgan) va chiqib ketgan (30 kundan oldin oxirgi marta)
      prisma.user.count({ where: { isAdmin: false, lastSeen: { gte: month } } }),
      prisma.user.count({ where: { isAdmin: false, lastSeen: { lt: month } } }),
      // Bugungi kunlik agregat (DailyStat) — bugungi sessiya soni + ilova vaqti.
      // dayKey today (lokal yarim tun) bilan bir xil — socket disconnect'dagi kalit bilan mos.
      prisma.$queryRawUnsafe(
        `SELECT "playtimeSec"::float8 AS playtime, "sessionCount" AS sessions
           FROM "DailyStat" WHERE "date" = $1`,
        `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
      ).catch(() => []),
    ]);

    // Bugungi sessiya ko'rsatkichlari (DailyStat'dan)
    const dayRow = Array.isArray(dailyToday) && dailyToday[0] ? dailyToday[0] : null;
    const totalPlaytimeSecToday = dayRow ? Math.round(dayRow.playtime || 0) : 0;
    const totalSessionsToday    = dayRow ? Number(dayRow.sessions || 0) : 0;
    const avgSessionSecToday    = totalSessionsToday > 0 ? Math.round(totalPlaytimeSecToday / totalSessionsToday) : 0;

    // Taxminiy daromad (so'm)
    const estimatedRevenueSom = (premiumPro * 39900) + (premiumUltra * 79900);
    const estimatedRevenueStars = (premiumPro * 150) + (premiumUltra * 300);

    res.json({
      totalUsers, bannedUsers, adminUsers,
      totalTerritories, totalTeams, eventsToday,
      onlineUsers, antiCheatToday, warningsTotal,
      // Registratsiya
      newToday, newYesterday, newWeek, newMonth,
      // Premium
      premiumTotal, premiumPro, premiumUltra,
      premiumWeek, premiumMonth,
      // Daromad (taxminiy — hozirgi aktiv obunalar asosida)
      estimatedRevenueSom,
      estimatedRevenueStars,
      // HAQIQIY daromad — chegirmadan keyingi haqiqatda to'langan summalar
      realRevenueSom:   revPurchase?._sum?.amountSom   || 0,
      realRevenueStars: revPurchase?._sum?.amountStars || 0,
      totalCoinsInCirculation: coinsResult._sum.coins || 0,
      // ── Bu oygi haqiqiy daromad (chegirmadan keyin haqiqatda to'langan) ──
      realRevenueSomMonth:   revPurchaseMonth?._sum?.amountSom   || 0,
      realRevenueStarsMonth: revPurchaseMonth?._sum?.amountStars || 0,
      // To'lovli xaridlar soni va FAOL tekin/bonus berilgan premiumlar (tekin — daromadga kirmaydi)
      paidPurchasesCount,
      freeGrantsCount,
      // Jami berilgan chegirma (so'm) = to'liq narx − haqiqatda to'langan
      totalDiscountSom: Math.max(0, (baseAgg?._sum?.baseSom || 0) - (revPurchase?._sum?.amountSom || 0)),
      // O'yin iqtisodi
      totalAreaCaptured: gameAgg?._sum?.totalArea || 0,
      totalDistanceM:    gameAgg?._sum?.totalDistance || 0,
      // ── Daromad dinamikasi (haqiqiy to'langan so'm) ──
      realRevenueSomToday: revToday?._sum?.amountSom || 0,
      realRevenueSomWeek:  revWeek?._sum?.amountSom  || 0,
      revProSom:   revPro?._sum?.amountSom   || 0,
      revUltraSom: revUltra?._sum?.amountSom || 0,
      // ── Foydalanuvchi tahlili ──
      avgLevel: Math.round((userAvg?._avg?.level || 0) * 10) / 10,
      avgXp:    Math.round(userAvg?._avg?.xp || 0),
      usersInTeam,
      publicTeams,
      // Anti-cheat turlari bo'yicha taqsimot
      antiCheatByType: (antiCheatTypes || []).map(t => ({ type: t.type, count: t._count.type })).sort((a, b) => b.count - a.count),
      // ── Sessiya va saqlanish (retention) ──
      avgSessionSec: (playSum?._sum?.sessionCount || 0) > 0
        ? Math.round((playSum._sum.totalPlaytimeSec || 0) / playSum._sum.sessionCount) : 0,
      totalSessions:    playSum?._sum?.sessionCount    || 0,
      totalPlaytimeSec: playSum?._sum?.totalPlaytimeSec || 0,
      activeUsers,    // 30 kun ichida faol bo'lganlar
      churnedUsers,   // 30 kundan beri kirmaganlar (chiqib ketgan)
      // ── Bugungi (kunlik) faollik — har kuni yangilanadi ──
      avgSessionSecToday,      // bugungi o'rtacha sessiya (soniya)
      totalPlaytimeSecToday,   // bugun ilovada o'tkazilgan jami vaqt (soniya)
      totalSessionsToday,      // bugungi UMUMIY kirib-chiqishlar (UNIK EMAS)
    });
  } catch (err) { next(err); }
}

// ─── Users ─────────────────────────────────────────────────────────────────────
async function getUsers(req, res, next) {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    
    const searchCondition = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } }
      ]
    } : {};
    const where = { isAdmin: false, ...searchCondition };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, username: true, phone: true, color: true, xp: true, level: true, totalArea: true, territoriesCaptured: true, isOnline: true, isAdmin: true, isBanned: true, createdAt: true, lastSeen: true, teamId: true, termsAccepted: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: clampLimit(limit)
      }),
      prisma.user.count({ where }),
    ]);
    
    const mappedUsers = users.map(u => ({ ...u, _id: u.id }));
    res.json({ users: mappedUsers, total, page: Number(page), limit: Number(limit) });
  } catch (err) { next(err); }
}

async function getUser(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { team: { select: { name: true, tag: true, color: true } } }
    });
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    
    delete user.passwordHash;
    delete user.passwordResetToken;
    delete user.passwordResetExpires;
    user._id = user.id;

    const territories = await prisma.territory.count({ where: { ownerId: req.params.id } });
    res.json({ user: { ...user, territoriesCount: territories } });
  } catch (err) { next(err); }
}

async function updateUser(req, res, next) {
  try {
    const { xp, level, color } = req.body;
    const update = {};
    if (xp !== undefined) update.xp = Math.max(0, Number(xp));
    if (level !== undefined) update.level = Math.max(1, Number(level));
    if (color !== undefined) update.color = color;
    
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: update,
      select: { id: true, username: true, xp: true, level: true, color: true, coins: true }
    });
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    res.json({ user: { ...user, _id: user.id } });
  } catch (err) { next(err); }
}

async function givePremium(req, res, next) {
  try {
    const days = Math.max(1, Math.min(365, Number(req.body.days) || 30));
    const MS   = days * 24 * 60 * 60 * 1000;
    const tier = req.body.tier === 'ultra' ? 'ultra' : 'pro';
    // bonus=true bo'lganda welcome coins BERILMAYDI (tekinga, sovg'a sifatida)
    const isBonus     = req.body.bonus === true || req.body.bonus === 'true';
    const welcomeCoins = isBonus ? 0 : TIERS[tier].welcomeCoins;

    // Agar hali faol premium bo'lsa — muddatini uzaytirish
    const existing = await prisma.user.findUnique({ where: { id: req.params.id }, select: { premiumUntil: true } });
    if (!existing) return res.status(404).json({ error: 'Topilmadi' });

    const base = (existing.premiumUntil && existing.premiumUntil > new Date())
      ? existing.premiumUntil.getTime()
      : Date.now();
    const premiumUntil = new Date(base + MS);

    const updateDoc = { isPremium: true, premiumUntil, premiumTier: tier, premiumIsGift: isBonus };
    if (welcomeCoins > 0) updateDoc.coins = { increment: welcomeCoins };

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: updateDoc,
      select: { id: true, username: true, isPremium: true, premiumUntil: true, premiumTier: true, coins: true }
    });

    // Sovg'a (bonus) emas — HAQIQIY xarid (odatda karta orqali chek bilan).
    // Admin chekdagi chegirmali summani `paidAmount` bilan yuboradi; yuborilmasa
    // chegirma foizidan yoki to'liq narxdan hisoblanadi. Daromad ledger'iga yoziladi.
    if (!isBonus) {
      const period   = days >= 365 ? 'yearly' : 'monthly';
      const discountPct = Math.max(0, Math.min(100, Number(req.body.discountPct) || 0));
      const promoCode = req.body.promoCode ? String(req.body.promoCode) : null;
      const baseSom   = baseSomFor(tier, period);
      const amountSom = req.body.paidAmount != null
        ? Math.max(0, Math.round(Number(req.body.paidAmount)) || 0)
        : discountedSom(tier, period, discountPct);
      await recordPremiumPurchase({
        userId: user.id, tier, period, method: 'card',
        amountSom, baseSom, discountPct, promoCode,
      });
    }

    res.json({ ok: true, user: { ...user, _id: user.id }, addedDays: days, tier, isBonus, coinsGiven: welcomeCoins });
  } catch (err) { next(err); }
}

async function removePremium(req, res, next) {
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isPremium: false, premiumUntil: null, premiumTier: 'free', premiumIsGift: false },
      select: { id: true, username: true, isPremium: true }
    });
    res.json({ ok: true, user: { ...user, _id: user.id } });
  } catch (err) { next(err); }
}

async function giveCoins(req, res, next) {
  try {
    const { amount, reason = 'Admin sovg\'asi' } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount > 0 bo\'lishi kerak' });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { coins: { increment: Math.round(Number(amount)) } },
      select: { id: true, username: true, coins: true }
    });
    res.json({ ok: true, username: user.username, coins: user.coins, given: Math.round(Number(amount)), reason });
  } catch (err) { next(err); }
}

async function banUser(req, res, next) {
  try {
    const { banned } = req.body;
    const reqUserId = req.user.id || req.user._id;
    if (req.params.id === reqUserId.toString()) {
      return res.status(400).json({ error: 'O\'zingizni ban qila olmaysiz' });
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isBanned: Boolean(banned) },
      select: { id: true, username: true, isBanned: true, socketId: true }
    });

    // Ban qilinayotgan user hozir online bo'lsa — socketini uzish.
    // user:{id} room orqali — Redis adapter bilan boshqa instance'dagi socket ham
    // uziladi; bitta instance rejimida avvalgi bilan bir xil effekt.
    invalidateUserCache(user.id);

    if (Boolean(banned)) {
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${user.id}`).emit('banned', { message: 'Akkaunt bloklangan' });
        io.in(`user:${user.id}`).disconnectSockets(true);
      }
    }

    res.json({ user: { _id: user.id, username: user.username, isBanned: user.isBanned } });
  } catch (err) { next(err); }
}

async function toggleAdmin(req, res, next) {
  try {
    const reqUserId = req.user.id || req.user._id;
    if (req.params.id === reqUserId.toString()) {
      return res.status(400).json({ error: 'O\'z admin huquqingizni o\'zgartira olmaysiz' });
    }
    const { isAdmin } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isAdmin: Boolean(isAdmin) },
      select: { id: true, username: true, isAdmin: true }
    });
    invalidateUserCache(user.id);
    res.json({ user: { ...user, _id: user.id } });
  } catch (err) { next(err); }
}

async function deleteUser(req, res, next) {
  try {
    const reqUserId = req.user.id || req.user._id;
    if (req.params.id === reqUserId.toString()) {
      return res.status(400).json({ error: 'O\'zingizni o\'chira olmaysiz' });
    }
    const userId = req.params.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, teamId: true }
    });
    if (!user) return res.status(404).json({ error: 'Topilmadi' });

    // FK (RESTRICT) bog'lanishlar user o'chirilishidan OLDIN tozalanadi — aks holda
    // hududi/anti-cheat logi/jamoa so'rovi bor har qanday userda delete 500 berardi.
    const territories = await prisma.territory.findMany({
      where: { ownerId: userId },
      select: { id: true, teamId: true, area: true }
    });
    await prisma.territory.deleteMany({ where: { ownerId: userId } });
    await prisma.teamRequest.deleteMany({ where: { userId } });
    await prisma.antiCheatLog.deleteMany({ where: { userId } });
    await prisma.warning.deleteMany({ where: { OR: [{ userId }, { adminId: userId }] } });

    // Jamoa maydonlari — hudud qaysi jamoa nomidan egallangan bo'lsa o'shanikidan ayiriladi
    const byTeam = new Map();
    for (const t of territories) {
      if (t.teamId) byTeam.set(t.teamId, (byTeam.get(t.teamId) || 0) + (t.area || 0));
    }
    for (const [teamId, area] of byTeam) {
      await prisma.team.update({
        where: { id: teamId },
        data: { totalArea: { decrement: area } }
      }).catch(() => {});
    }

    if (user.teamId) {
      await prisma.team.update({
        where: { id: user.teamId },
        data: { memberCount: { decrement: 1 } }
      }).catch(() => {});
    }
    await prisma.team.updateMany({ where: { ownerId: userId }, data: { ownerId: null } });

    await prisma.user.delete({ where: { id: userId } });
    invalidateUserCache(userId);

    const io = req.app.get('io');
    if (io) {
      for (const t of territories) {
        io.to('global').emit('territory:removed', { territoryId: t.id.toString() });
      }
    }

    res.json({ message: 'O\'chirildi' });
  } catch (err) { next(err); }
}

// ─── Territories ───────────────────────────────────────────────────────────────
async function getTerritories(req, res, next) {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    let ownerFilter = {};
    if (search) {
      const matchedUsers = await prisma.user.findMany({
        where: { username: { contains: search, mode: 'insensitive' } },
        select: { id: true }
      });
      ownerFilter = { ownerId: { in: matchedUsers.map(u => u.id) } };
    }

    const [territories, total] = await Promise.all([
      prisma.territory.findMany({
        where: ownerFilter,
        select: { id: true, ownerId: true, teamId: true, area: true, color: true, capturedAt: true, owner: { select: { username: true, color: true, level: true } }, team: { select: { name: true, tag: true } } },
        orderBy: { capturedAt: 'desc' },
        skip,
        take: clampLimit(limit)
      }),
      prisma.territory.count({ where: ownerFilter }),
    ]);
    
    const mappedTerritories = territories.map(t => ({ ...t, _id: t.id }));
    res.json({ territories: mappedTerritories, total, page: Number(page), limit: Number(limit) });
  } catch (err) { next(err); }
}

async function deleteTerritory(req, res, next) {
  try {
    const territory = await prisma.territory.delete({ where: { id: req.params.id } });
    await Promise.all([
      prisma.user.update({
        where: { id: territory.ownerId },
        data: { totalArea: { decrement: territory.area }, territoriesCaptured: { decrement: 1 } }
      }),
      territory.teamId
        ? prisma.team.update({
            where: { id: territory.teamId },
            data: { totalArea: { decrement: territory.area } }
          })
        : Promise.resolve(),
    ]);
    res.json({ message: 'O\'chirildi' });
  } catch (err) { next(err); }
}

// ─── Teams ─────────────────────────────────────────────────────────────────────
async function getTeams(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        select: { id: true, name: true, tag: true, color: true, memberCount: true, totalArea: true, isPublic: true, createdAt: true, ownerId: true, owner: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: clampLimit(limit)
      }),
      prisma.team.count(),
    ]);
    const mappedTeams = teams.map(t => ({ ...t, _id: t.id }));
    res.json({ teams: mappedTeams, total, page: Number(page), limit: Number(limit) });
  } catch (err) { next(err); }
}

async function deleteTeam(req, res, next) {
  try {
    const teamId = req.params.id;
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    if (!team) return res.status(404).json({ error: 'Topilmadi' });

    const members = await prisma.user.findMany({
      where: { teamId },
      select: { id: true }
    });

    // Majburiy FK bog'lanishlar (marker, so'rovlar) jamoadan OLDIN o'chiriladi —
    // aks holda markerli/so'rovli jamoani o'chirish RESTRICT tufayli 500 berardi.
    await prisma.user.updateMany({ where: { teamId }, data: { teamId: null } });
    await prisma.teamRequest.deleteMany({ where: { teamId } });
    await prisma.teamMarker.deleteMany({ where: { teamId } });
    await prisma.team.delete({ where: { id: teamId } });

    // Onlayn a'zolarning socket roomlarini ham yangilab qo'yamiz
    const io = req.app.get('io');
    if (io) {
      for (const m of members) setPlayerTeam(io, m.id, null);
    }

    res.json({ message: 'O\'chirildi' });
  } catch (err) { next(err); }
}

// ─── Events ────────────────────────────────────────────────────────────────────
async function getEvents(req, res, next) {
  try {
    const { page = 1, limit = 50, type = '' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const filter = type ? { type } : {};
    const [events, total] = await Promise.all([
      prisma.gameEvent.findMany({
        where: filter,
        include: { actor: { select: { username: true, color: true } }, target: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: clampLimit(limit)
      }),
      prisma.gameEvent.count({ where: filter }),
    ]);
    const mappedEvents = events.map(e => ({ ...e, _id: e.id }));
    res.json({ events: mappedEvents, total, page: Number(page), limit: Number(limit) });
  } catch (err) { next(err); }
}

// ─── Online players ────────────────────────────────────────────────────────────
async function getOnline(req, res, next) {
  try {
    const users = await prisma.user.findMany({
      where: { isOnline: true, isAdmin: false },
      select: { id: true, username: true, color: true, level: true, lastSeen: true },
      orderBy: { lastSeen: 'desc' },
      take: 5000, // onlayn o'yinchilar soni — render chegarasi bilan bir xil
    });
    const mappedUsers = users.map(u => ({ ...u, _id: u.id }));
    res.json({ users: mappedUsers });
  } catch (err) { next(err); }
}

// ─── Warnings ─────────────────────────────────────────────────────────────────
async function getUserWarnings(req, res, next) {
  try {
    const warnings = await prisma.warning.findMany({
      where: { userId: req.params.id },
      include: { admin: { select: { username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500, // bitta userning ogohlantirishlari — amalda kam; faqat eng yomon holat chegarasi
    });
    const mappedWarnings = warnings.map(w => ({ ...w, _id: w.id }));
    res.json({ warnings: mappedWarnings });
  } catch (err) { next(err); }
}

async function addWarning(req, res, next) {
  try {
    const { reason, severity = 'medium' } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'reason majburiy' });
    
    const reqUserId = req.user.id || req.user._id;
    const warning = await prisma.warning.create({
      data: {
        userId: req.params.id,
        adminId: reqUserId.toString(),
        reason: reason.trim(),
        severity,
      }
    });
    const count = await prisma.warning.count({ where: { userId: req.params.id } });
    
    // Auto-ban after 3 high severity warnings
    if (severity === 'high' && count >= 3) {
      await prisma.user.update({ where: { id: req.params.id }, data: { isBanned: true } });
    }
    res.json({ warning: { ...warning, _id: warning.id }, totalWarnings: count });
  } catch (err) { next(err); }
}

async function deleteWarning(req, res, next) {
  try {
    await prisma.warning.delete({ where: { id: req.params.wid } });
    res.json({ message: "O'chirildi" });
  } catch (err) { next(err); }
}

async function getUserActivity(req, res, next) {
  try {
    const { limit = 30 } = req.query;
    const events = await prisma.gameEvent.findMany({
      where: { actorId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(limit, 30)
    });
    const mappedEvents = events.map(e => ({ ...e, _id: e.id }));
    res.json({ events: mappedEvents });
  } catch (err) { next(err); }
}

// ─── Territory history ────────────────────────────────────────────────────────
async function getTerritoryHistory(req, res, next) {
  try {
    const events = await prisma.gameEvent.findMany({
      where: { territoryId: req.params.id },
      include: { actor: { select: { username: true, color: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const mappedEvents = events.map(e => ({ ...e, _id: e.id }));
    res.json({ events: mappedEvents });
  } catch (err) { next(err); }
}

// ─── Anti-Cheat ───────────────────────────────────────────────────────────────
async function getAntiCheatLogs(req, res, next) {
  try {
    const { page = 1, limit = 50, type = '', userId = '' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const filter = {};
    if (type) filter.type = type;
    if (userId) filter.userId = userId;

    const [logs, total, typeCounts] = await Promise.all([
      prisma.antiCheatLog.findMany({
        where: filter,
        include: { user: { select: { username: true, color: true, level: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: clampLimit(limit)
      }),
      prisma.antiCheatLog.count({ where: filter }),
      prisma.antiCheatLog.groupBy({
        by: ['type'],
        _sum: { count: true }
      }),
    ]);
    
    const typeCountMap = {};
    typeCounts.forEach(t => { typeCountMap[t.type] = t._sum.count || 0; });
    const mappedLogs = logs.map(l => ({ ...l, _id: l.id }));
    
    res.json({ logs: mappedLogs, total, typeCounts: typeCountMap, page: Number(page), limit: Number(limit) });
  } catch (err) { next(err); }
}

async function getUserAntiCheat(req, res, next) {
  try {
    const logs = await prisma.antiCheatLog.findMany({
      where: { userId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const mappedLogs = logs.map(l => ({ ...l, _id: l.id }));
    res.json({ logs: mappedLogs });
  } catch (err) { next(err); }
}

async function clearAntiCheatLogs(req, res, next) {
  try {
    const { type = '', userId = '' } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (userId) filter.userId = userId;
    const result = await prisma.antiCheatLog.deleteMany({ where: filter });
    res.json({ deleted: result.count });
  } catch (err) { next(err); }
}

// ─── Live Map ─────────────────────────────────────────────────────────────────
async function getLiveMap(req, res, next) {
  try {
    // Scale rejimida barcha instance'lardagi onlayn o'yinchilar (Redis mirror);
    // bitta instance rejimida — lokal Map (avvalgidek). 5000 — render chegarasi.
    const socketMap = await onlineStore.getAllObject(5000);

    const [territories, recentLogs, onlineUsers, allEvents] = await Promise.all([
      prisma.territory.findMany({
        select: { id: true, ownerId: true, teamId: true, polygon: true, area: true, color: true, owner: { select: { username: true, color: true } } },
        // Heatmap eng so'nggi hududlar bo'yicha; 5000 — shu fayldagi onlayn-render chegarasi
        // bilan bir xil. Kam bo'lsa xulq o'zgarmaydi; ko'p bo'lsa og'ir poligon-JSONB payload
        // va xotira chegaralanadi (avval BARCHA hudud cheksiz tortilardi).
        orderBy: { capturedAt: 'desc' },
        take: 5000,
      }),
      prisma.antiCheatLog.findMany({
        where: { createdAt: { gte: new Date(Date.now() - 3600000) }, lat: { not: null } },
        include: { user: { select: { username: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100
      }),
      prisma.user.findMany({
        where: { isOnline: true, isAdmin: false },
        select: { id: true, username: true, color: true, level: true, lastLocation: true },
        take: 5000, // onlayn o'yinchilar — render chegarasi bilan bir xil
      }),
      // territoryId null bo'lganlar (hududi allaqachon o'chirilgan eski eventlar)
      // hotspot bo'la olmaydi — ularni DB darajasida chiqarib tashlaymiz, aks holda
      // bu so'rov vaqt o'tishi bilan cheksiz o'sib live-map'ni sekinlashtiradi.
      prisma.gameEvent.findMany({
        where: { type: 'territory_captured', data: { not: null }, territoryId: { not: null } },
        select: { territoryId: true, data: true },
        // Hotspot = SO'NGGI janglar. Eng yangi 10000 capture bilan cheklaymiz — jadval
        // har zabt bilan abadiy o'sgani uchun bu so'rov vaqt o'tib eng katta sekinlashish
        // manbai edi. Bundan kam capture bo'lsa natija aynan bir xil.
        orderBy: { createdAt: 'desc' },
        take: 10000,
      }),
    ]);

    // Hududlar zabt etilgan (stolenFrom bo'sh emas) — jang maydoni aniqlash
    const hotspotIds = allEvents.filter(e => {
       const d = e.data;
       return d && Array.isArray(d.stolenFrom) && d.stolenFrom.length > 0;
    }).map(e => e.territoryId);

    const hotSet = new Set(hotspotIds.map(id => id?.toString()).filter(Boolean));

    const players = onlineUsers.map(u => {
      const userId = u.id.toString();
      const live = socketMap[userId];
      const liveLocation = (live?.lat != null && live?.lng != null)
        ? { type: 'Point', coordinates: [live.lng, live.lat] }
        : null;
      return {
        _id: userId,
        username: u.username,
        color: u.color,
        level: u.level,
        lastLocation: liveLocation || u.lastLocation || null,
        isLive: liveLocation != null,
      };
    });

    // Heatmap: hudud markazlari (centroid) + maydon intensivligi
    const heatPoints = [];
    for (const t of territories) {
      const coords = t.polygon?.coordinates?.[0];
      if (!coords || coords.length < 3) continue;
      const n = coords.length;
      const lng = coords.reduce((s, c) => s + c[0], 0) / n;
      const lat = coords.reduce((s, c) => s + c[1], 0) / n;
      heatPoints.push([lat, lng, Math.min(1, Math.max(0.1, (t.area || 100) / 20000))]);
    }

    const territoriesOut = territories.map(t => ({
      ...t,
      _id: t.id,
      isHotspot: hotSet.has(t.id?.toString()),
    }));

    const mappedLogs = recentLogs.map(l => ({ ...l, _id: l.id }));
    res.json({ players, territories: territoriesOut, suspiciousMarkers: mappedLogs, heatPoints });
  } catch (err) { next(err); }
}

// ─── Analytics ────────────────────────────────────────────────────────────────
async function getAnalytics(req, res, next) {
  try {
    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week  = new Date(Date.now() -  7 * 86400000);
    const month = new Date(Date.now() - 30 * 86400000);

    // Ma'lumotlarni xotirada guruhlash uchun barcha mos yozuvlarni olamiz
    const [
      dauCount, wauCount, mauCount,
      newUsersToday, newUsersWeek, newUsersMonth,
      territoriesTotal, territoriesToday,
      distanceResult, topPlayers,
      recentEvents, recentUsersWeek, recentUsersMonth,
      recentTerritories, topCoins,
    ] = await Promise.all([
      prisma.user.count({ where: { lastSeen: { gte: today }, isAdmin: false } }),
      prisma.user.count({ where: { lastSeen: { gte: week }, isAdmin: false } }),
      prisma.user.count({ where: { lastSeen: { gte: month }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: today }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: week }, isAdmin: false } }),
      prisma.user.count({ where: { createdAt: { gte: month }, isAdmin: false } }),
      prisma.territory.count({ where: { owner: { isAdmin: false } } }),
      prisma.territory.count({ where: { capturedAt: { gte: today }, owner: { isAdmin: false } } }),
      prisma.user.aggregate({ _sum: { totalDistance: true }, where: { isAdmin: false } }),
      prisma.user.findMany({
        where: { isAdmin: false },
        select: { id: true, username: true, color: true, level: true, xp: true, totalArea: true, totalDistance: true, territoriesCaptured: true, coins: true, isPremium: true, premiumTier: true },
        orderBy: { xp: 'desc' },
        take: 10
      }),
      prisma.gameEvent.findMany({ where: { createdAt: { gte: week }, NOT: { actor: { isAdmin: true } } }, select: { createdAt: true } }),
      prisma.user.findMany({ where: { createdAt: { gte: week }, isAdmin: false }, select: { createdAt: true } }),
      prisma.user.findMany({ where: { createdAt: { gte: month }, isAdmin: false }, select: { createdAt: true } }),
      prisma.territory.findMany({ where: { capturedAt: { gte: week }, owner: { isAdmin: false } }, select: { capturedAt: true } }),
      prisma.user.findMany({
        where: { isAdmin: false },
        select: { id: true, username: true, color: true, coins: true, isPremium: true, premiumTier: true },
        orderBy: { coins: 'desc' },
        take: 10
      }),
    ]);

    const groupByDate = (arr, dateField) => {
      const map = {};
      for (const item of arr) {
        const d = item[dateField].toISOString().split('T')[0];
        map[d] = (map[d] || 0) + 1;
      }
      return Object.keys(map).sort().map(k => ({ _id: k, count: map[k] }));
    };

    const dailyEvents = groupByDate(recentEvents, 'createdAt');
    const weeklyRegistrations = groupByDate(recentUsersWeek, 'createdAt');
    const monthlyRegistrations = groupByDate(recentUsersMonth, 'createdAt');
    const dailyTerritories = groupByDate(recentTerritories, 'capturedAt');

    res.json({
      dau: dauCount, wau: wauCount, mau: mauCount,
      newUsersToday, newUsersWeek, newUsersMonth,
      territoriesTotal, territoriesToday,
      totalDistance: distanceResult._sum.totalDistance || 0,
      topPlayers: topPlayers.map(p => ({ ...p, _id: p.id })),
      topCoins: topCoins.map(p => ({ ...p, _id: p.id })),
      dailyEvents, weeklyRegistrations, monthlyRegistrations, dailyTerritories,
    });
  } catch (err) { next(err); }
}

// ─── Economy ──────────────────────────────────────────────────────────────────
async function getEconomy(req, res, next) {
  try {
    const now = new Date();
    const week  = new Date(Date.now() -  7 * 86400000);
    const month = new Date(Date.now() - 30 * 86400000);

    const [
      xpResult, coinsResult, topXp, topArea, topDist, topCoins,
      premiumPro, premiumUltra, premiumNew7d, premiumNew30d,
      revAll, revMonth,
    ] = await Promise.all([
      prisma.user.aggregate({ _sum: { xp: true }, where: { isAdmin: false } }),
      prisma.user.aggregate({ _sum: { coins: true }, where: { isAdmin: false } }),
      prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, username: true, color: true, level: true, xp: true, isPremium: true, premiumTier: true }, orderBy: { xp: 'desc' }, take: 20 }),
      prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, username: true, color: true, totalArea: true, isPremium: true, premiumTier: true }, orderBy: { totalArea: 'desc' }, take: 10 }),
      prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, username: true, color: true, totalDistance: true, isPremium: true, premiumTier: true }, orderBy: { totalDistance: 'desc' }, take: 10 }),
      prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, username: true, color: true, coins: true, isPremium: true, premiumTier: true }, orderBy: { coins: 'desc' }, take: 10 }),
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, premiumTier: 'pro', premiumIsGift: false, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, premiumUntil: { gt: now }, premiumTier: 'ultra', premiumIsGift: false, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, updatedAt: { gte: week }, isAdmin: false } }),
      prisma.user.count({ where: { isPremium: true, updatedAt: { gte: month }, isAdmin: false } }),
      prisma.premiumPurchase.aggregate({ _sum: { amountSom: true, amountStars: true } }).catch(() => null),
      prisma.premiumPurchase.aggregate({ where: { createdAt: { gte: month } }, _sum: { amountSom: true, amountStars: true } }).catch(() => null),
    ]);

    const revSom   = premiumPro * 39900 + premiumUltra * 79900;
    const revStars = premiumPro * 150   + premiumUltra * 300;

    const mapIds = arr => arr.map(a => ({ ...a, _id: a.id }));

    res.json({
      totalXpDistributed:   xpResult._sum.xp  || 0,
      totalCoinsCirculation: coinsResult._sum.coins || 0,
      leaderboardXp:   mapIds(topXp),
      leaderboardArea: mapIds(topArea),
      leaderboardDist: mapIds(topDist),
      leaderboardCoins: mapIds(topCoins),
      premiumPro, premiumUltra,
      premiumTotal:  premiumPro + premiumUltra,
      premiumNew7d, premiumNew30d,
      estimatedRevenueSom: revSom,
      estimatedRevenueStars: revStars,
      // HAQIQIY daromad — chegirmadan keyingi to'langan summalar yig'indisi (PremiumPurchase)
      realRevenueSom:    revAll?._sum?.amountSom   || 0,
      realRevenueStars:  revAll?._sum?.amountStars || 0,
      realRevenueSom30d: revMonth?._sum?.amountSom   || 0,
      realRevenueStars30d: revMonth?._sum?.amountStars || 0,
    });
  } catch (err) { next(err); }
}

async function seasonReset(req, res, next) {
  try {
    const { confirm } = req.body;
    if (confirm !== 'SEASON_RESET') {
      return res.status(400).json({ error: 'Tasdiqlash kodi noto\'g\'ri. "SEASON_RESET" yuboring' });
    }
    await Promise.all([
      prisma.territory.deleteMany({}),
      prisma.user.updateMany({
        where: { isAdmin: false },
        data: { xp: 0, level: 1, totalArea: 0, territoriesCaptured: 0, territoriesLost: 0 }
      }),
      prisma.team.updateMany({ data: { totalArea: 0 } }),
    ]);
    req.app.get('io')?.to('global').emit('season:reset', { message: 'Yangi mavsum boshlandi!' });
    res.json({ message: 'Mavsum reset qilindi' });
  } catch (err) { next(err); }
}

// ─── Admin o'z profili ─────────────────────────────────────────────────────────
async function getMe(req, res, next) {
  try {
    const reqUserId = req.user.id || req.user._id;
    const user = await prisma.user.findUnique({
      where: { id: reqUserId.toString() },
      select: { id: true, username: true, phone: true, color: true, xp: true, level: true, isAdmin: true, termsAccepted: true, createdAt: true }
    });
    res.json({ user: { ...user, _id: user.id } });
  } catch (err) { next(err); }
}

async function updateMe(req, res, next) {
  try {
    const { username } = req.body;
    if (!username?.trim()) return res.status(400).json({ error: 'username majburiy' });
    const reqUserId = req.user.id || req.user._id;
    
    const taken = await prisma.user.findFirst({
      where: { username: username.trim(), id: { not: reqUserId.toString() } }
    });
    if (taken) return res.status(409).json({ error: 'Bu username allaqachon band' });
    
    const user = await prisma.user.update({
      where: { id: reqUserId.toString() },
      data: { username: username.trim() },
      select: { id: true, username: true }
    });
    res.json({ user: { ...user, _id: user.id } });
  } catch (err) { next(err); }
}

async function verifyPassword(req, res, next) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password majburiy' });
    const reqUserId = req.user.id || req.user._id;
    
    const user = await prisma.user.findUnique({ where: { id: reqUserId.toString() } });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Parol noto\'g\'ri' });
    res.json({ valid: true });
  } catch (err) { next(err); }
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Barcha maydonlar majburiy' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Yangi parol kamida 6 ta belgi bo\'lishi kerak' });
    
    const reqUserId = req.user.id || req.user._id;
    const user = await prisma.user.findUnique({ where: { id: reqUserId.toString() } });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Joriy parol noto\'g\'ri' });
    
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: reqUserId.toString() },
      data: { passwordHash }
    });
    res.json({ message: 'Parol muvaffaqiyatli yangilandi' });
  } catch (err) { next(err); }
}

// Hudud birlashtirish — qo'lda ishga tushirish (Shell kerak emas).
// ?apply=true → haqiqiy birlashtirish; aks holda DRY-RUN (faqat hisobot).
async function mergeTerritories(req, res, next) {
  try {
    const apply = req.query.apply === 'true' || req.body?.apply === true;
    const stats = await mergeAllOwnTerritories({ apply });
    res.json({ apply, ...stats });
  } catch (err) { next(err); }
}

module.exports = {
  getStats, getUsers, getUser, updateUser, banUser, toggleAdmin, deleteUser,
  getUserWarnings, addWarning, deleteWarning, getUserActivity,
  getTerritories, deleteTerritory, getTerritoryHistory,
  getTeams, deleteTeam,
  getEvents, getOnline,
  getAntiCheatLogs, getUserAntiCheat, clearAntiCheatLogs,
  getLiveMap,
  getAnalytics,
  getEconomy, seasonReset,
  giveCoins, givePremium, removePremium,
  mergeTerritories,
  getMe, updateMe, verifyPassword, changePassword,
};
