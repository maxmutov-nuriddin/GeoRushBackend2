// ─────────────────────────────────────────────────────────────────────────────
// Admin INSIGHTS — FAQAT O'QISH (read-only) analitika endpointlari.
// Hammasi yangi/qo'shimcha: mavjud controllerlarga, o'yin logikasiga yoki yozish
// (mutation) oqimlariga TEGMAYDI. Har biri adminAuth ortida (admin.js router.use).
// Maqsad: backend allaqachon saqlayotgan, lekin admin'da ko'rsatilmagan ma'lumotlarni
// yuzaga chiqarish (geo, daromad detali, referral funnel, retention, takroriy cheater,
// support metrikalari, promokod statistikasi).
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

// ── 1) Geografik taqsimot — qaysi davlat/shaharda nechta o'yinchi ───────────────
async function getGeoDistribution(req, res, next) {
  try {
    const base = { isAdmin: false };
    const [byCountry, byCity, withGeo, total] = await Promise.all([
      prisma.user.groupBy({
        by: ['country'],
        where: { ...base, country: { not: null } },
        _count: { country: true },
      }),
      prisma.user.groupBy({
        by: ['city'],
        where: { ...base, city: { not: null } },
        _count: { city: true },
      }),
      prisma.user.count({ where: { ...base, OR: [{ country: { not: null } }, { city: { not: null } }] } }),
      prisma.user.count({ where: base }),
    ]);

    const countries = byCountry
      .map((r) => ({ name: r.country, count: r._count.country }))
      .sort((a, b) => b.count - a.count);
    const cities = byCity
      .map((r) => ({ name: r.city, count: r._count.city }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    res.json({
      countries,
      cities,
      withGeo,                       // geo ma'lumoti bor userlar
      withoutGeo: total - withGeo,   // geo ma'lumoti yo'q
      total,
    });
  } catch (err) { next(err); }
}

// ── 2) Daromad detali — tier/method bo'yicha + 30 kunlik dinamika + ARPU ────────
async function getRevenueBreakdown(req, res, next) {
  try {
    const since30 = new Date(Date.now() - 30 * DAY);

    const [byTier, byMethod, allTimeSom, payingUsers, totalUsers, giftCount, recent] = await Promise.all([
      prisma.premiumPurchase.groupBy({
        by: ['tier'],
        _sum: { amountSom: true, amountStars: true },
        _count: { _all: true },
      }),
      prisma.premiumPurchase.groupBy({
        by: ['method'],
        _sum: { amountSom: true, amountStars: true },
        _count: { _all: true },
      }),
      prisma.premiumPurchase.aggregate({ _sum: { amountSom: true, amountStars: true } }),
      prisma.premiumPurchase.findMany({ distinct: ['userId'], select: { userId: true } }),
      prisma.user.count({ where: { isAdmin: false } }),
      prisma.user.count({ where: { isAdmin: false, premiumIsGift: true, isPremium: true } }),
      prisma.premiumPurchase.findMany({
        where: { createdAt: { gte: since30 } },
        select: { amountSom: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // 30 kunlik kunlik daromad seriyasi (so'm)
    const dailyMap = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - (29 - i) * DAY);
      dailyMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const p of recent) {
      const k = new Date(p.createdAt).toISOString().slice(0, 10);
      if (k in dailyMap) dailyMap[k] += p.amountSom || 0;
    }
    const dailySeries = Object.entries(dailyMap).map(([date, som]) => ({ date, som }));

    const paying = payingUsers.length;
    const totalSom = allTimeSom?._sum?.amountSom || 0;

    res.json({
      byTier: byTier.map((t) => ({ tier: t.tier, som: t._sum.amountSom || 0, stars: t._sum.amountStars || 0, count: t._count._all })),
      byMethod: byMethod.map((m) => ({ method: m.method, som: m._sum.amountSom || 0, stars: m._sum.amountStars || 0, count: m._count._all })),
      totalSom,
      totalStars: allTimeSom?._sum?.amountStars || 0,
      payingUsers: paying,
      giftPremiums: giftCount,                                            // tekin/sovg'a berilgan aktiv premium
      conversionPct: totalUsers > 0 ? Math.round((paying / totalUsers) * 1000) / 10 : 0,  // to'lovchilar %
      arpuSom: paying > 0 ? Math.round(totalSom / paying) : 0,            // har to'lovchidan o'rtacha daromad
      dailySeries,
    });
  } catch (err) { next(err); }
}

// ── 3) Referral / viral funnel — K-factor va top referrerlar ────────────────────
async function getReferralFunnel(req, res, next) {
  try {
    const [total, completed, pending, totalUsers, friendships, topRaw] = await Promise.all([
      prisma.referral.count(),
      prisma.referral.count({ where: { status: 'completed' } }),
      prisma.referral.count({ where: { status: 'pending' } }),
      prisma.user.count({ where: { isAdmin: false } }),
      prisma.friendship.count(),
      prisma.referral.groupBy({
        by: ['referrerId'],
        where: { status: 'completed' },
        _count: { referrerId: true },
        orderBy: { _count: { referrerId: 'desc' } },
        take: 20,
      }),
    ]);

    // Top referrerlarning username'larini olamiz
    const ids = topRaw.map((r) => r.referrerId);
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, color: true, level: true } })
      : [];
    const uMap = Object.fromEntries(users.map((u) => [u.id, u]));
    const topReferrers = topRaw.map((r) => ({
      ...(uMap[r.referrerId] || { id: r.referrerId, username: '—' }),
      invited: r._count.referrerId,
    }));

    res.json({
      total,
      completed,
      pending,
      completionPct: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
      kFactor: totalUsers > 0 ? Math.round((completed / totalUsers) * 100) / 100 : 0,  // o'rtacha taklif/user
      friendships,
      topReferrers,
    });
  } catch (err) { next(err); }
}

// ── 4) Retention — DAU/WAU/MAU + yangi foydalanuvchi dinamikasi ──────────────────
async function getRetentionCohorts(req, res, next) {
  try {
    const now = Date.now();
    const base = { isAdmin: false };
    const [dau, wau, mau, total] = await Promise.all([
      prisma.user.count({ where: { ...base, lastSeen: { gte: new Date(now - DAY) } } }),
      prisma.user.count({ where: { ...base, lastSeen: { gte: new Date(now - 7 * DAY) } } }),
      prisma.user.count({ where: { ...base, lastSeen: { gte: new Date(now - 30 * DAY) } } }),
      prisma.user.count({ where: base }),
    ]);

    // So'nggi 14 kun: har kuni nechta yangi ro'yxatdan o'tgan
    const newByDay = await prisma.user.findMany({
      where: { ...base, createdAt: { gte: new Date(now - 14 * DAY) } },
      select: { createdAt: true },
    });
    const dayMap = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(now - (13 - i) * DAY);
      dayMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const u of newByDay) {
      const k = new Date(u.createdAt).toISOString().slice(0, 10);
      if (k in dayMap) dayMap[k] += 1;
    }
    const newUsersSeries = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

    res.json({
      dau, wau, mau, total,
      stickiness: mau > 0 ? Math.round((dau / mau) * 1000) / 10 : 0,  // DAU/MAU % (jalb darajasi)
      newUsersSeries,
    });
  } catch (err) { next(err); }
}

// ── 5) Takroriy cheaterlar — eng ko'p anti-cheat belgisi olganlar ───────────────
async function getRepeatCheaters(req, res, next) {
  try {
    const raw = await prisma.antiCheatLog.groupBy({
      by: ['userId'],
      _sum: { count: true },
      _count: { _all: true },
      orderBy: { _sum: { count: 'desc' } },
      take: 30,
    });
    const ids = raw.map((r) => r.userId).filter(Boolean);
    const users = ids.length
      ? await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true, color: true, level: true, isBanned: true },
        })
      : [];
    const uMap = Object.fromEntries(users.map((u) => [u.id, u]));
    const offenders = raw.map((r) => ({
      ...(uMap[r.userId] || { id: r.userId, username: '—' }),
      flagCount: r._sum.count || 0,
      logEntries: r._count._all,
    }));
    res.json({ offenders });
  } catch (err) { next(err); }
}

// ── 6) Support metrikalari — ochiq/yopiq, javobsiz, jami xabar ───────────────────
async function getSupportMetrics(req, res, next) {
  try {
    const [openChats, closedChats, needReply, totalChats, totalMessages, last7Messages] = await Promise.all([
      prisma.supportChat.count({ where: { status: 'open' } }),
      prisma.supportChat.count({ where: { status: 'closed' } }),
      prisma.supportChat.count({ where: { unreadCount: { gt: 0 } } }),  // javob kutayotganlar
      prisma.supportChat.count(),
      prisma.supportMessage.count(),
      prisma.supportMessage.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * DAY) } } }),
    ]);
    res.json({
      openChats, closedChats, needReply, totalChats,
      totalMessages, last7Messages,
    });
  } catch (err) { next(err); }
}

// ── 7) Promokod statistikasi — ishlatilishi + keltirgan daromad ─────────────────
async function getPromoStats(req, res, next) {
  try {
    const [codes, revByPromo] = await Promise.all([
      prisma.promoCode.findMany({
        orderBy: { usesCount: 'desc' },
        take: 200,
        select: { id: true, code: true, discountPct: true, maxUses: true, usesCount: true, isActive: true, expiresAt: true, appliesTier: true },
      }),
      prisma.premiumPurchase.groupBy({
        by: ['promoCode'],
        where: { promoCode: { not: null } },
        _sum: { amountSom: true },
        _count: { _all: true },
      }),
    ]);
    const revMap = {};
    for (const r of revByPromo) revMap[r.promoCode] = { som: r._sum.amountSom || 0, uses: r._count._all };
    const enriched = codes.map((c) => ({
      ...c,
      revenueSom: revMap[c.code]?.som || 0,
      paidUses: revMap[c.code]?.uses || 0,
    }));
    res.json({ codes: enriched });
  } catch (err) { next(err); }
}

module.exports = {
  getGeoDistribution,
  getRevenueBreakdown,
  getReferralFunnel,
  getRetentionCohorts,
  getRepeatCheaters,
  getSupportMetrics,
  getPromoStats,
};
