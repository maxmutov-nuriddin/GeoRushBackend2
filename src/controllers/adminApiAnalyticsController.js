// ─────────────────────────────────────────────────────────────────────────────
// Admin API ANALYTICS — foydalanuvchi sessiya va ilova ishlatilishi statistikasi.
// Read-only endpoint, adminAuth ortida.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getApiAnalytics(req, res, next) {
  try {
    const now = Date.now();
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));
    const since24h = new Date(now - DAY);
    const since7d  = new Date(now - 7 * DAY);
    const since30d = new Date(now - 30 * DAY);
    const base = { isAdmin: false };

    const [
      totalUsers,
      activeToday, active7d, active30d,
      onlineNow,
      withPushToken, withSocketId,
    ] = await Promise.all([
      prisma.user.count({ where: base }),
      prisma.user.count({ where: { ...base, lastSeen: { gte: todayStart } } }),
      prisma.user.count({ where: { ...base, lastSeen: { gte: since7d } } }),
      prisma.user.count({ where: { ...base, lastSeen: { gte: since30d } } }),
      prisma.user.count({ where: { ...base, isOnline: true } }),
      prisma.user.count({ where: { ...base, expoPushToken: { not: null } } }),
      prisma.user.count({ where: { ...base, socketId: { not: null } } }),
    ]);

    // ── O'rtacha sessiya va playtime (aggregate) ──
    const agg = await prisma.user.aggregate({
      where: { ...base, sessionCount: { gt: 0 } },
      _avg: { sessionCount: true, totalPlaytimeSec: true },
      _sum: { sessionCount: true, totalPlaytimeSec: true },
      _count: { _all: true },
    });

    const usersWithSessions = agg._count._all;
    const totalSessions = agg._sum.sessionCount || 0;
    const totalPlaytime = agg._sum.totalPlaytimeSec || 0;
    const avgSessionsPerUser = usersWithSessions > 0
      ? Math.round((totalSessions / usersWithSessions) * 10) / 10
      : 0;
    const avgPlaytimePerSession = totalSessions > 0
      ? Math.round(totalPlaytime / totalSessions)
      : 0;
    const avgPlaytimePerUser = usersWithSessions > 0
      ? Math.round(totalPlaytime / usersWithSessions)
      : 0;

    // ── Premium tier taqsimoti ──
    const tierDistribution = await prisma.user.groupBy({
      by: ['premiumTier'],
      where: base,
      _count: { premiumTier: true },
    });
    const tiers = tierDistribution.map(r => ({
      tier: r.premiumTier,
      count: r._count.premiumTier,
    })).sort((a, b) => b.count - a.count);

    // ── Kunlik faol foydalanuvchilar (14 kun) ──
    const activeUsersByDay = await prisma.user.findMany({
      where: { ...base, lastSeen: { gte: new Date(now - 14 * DAY) } },
      select: { lastSeen: true },
    });
    const dayMap = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(now - (13 - i) * DAY);
      dayMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const u of activeUsersByDay) {
      if (u.lastSeen) {
        const k = new Date(u.lastSeen).toISOString().slice(0, 10);
        if (k in dayMap) dayMap[k] += 1;
      }
    }
    const dailyActiveSeries = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

    res.json({
      endpoints: {
        totalEndpoints: 50,
        apiVersion: 'v1',
      },
      users: {
        total: totalUsers,
        activeToday,
        active7d,
        active30d,
        onlineNow,
      },
      sessions: {
        totalSessions,
        usersWithSessions,
        avgSessionsPerUser,
        avgPlaytimePerSession,
        avgPlaytimePerUser,
        totalPlaytimeSec: totalPlaytime,
      },
      devices: {
        withPushToken,
        withSocketId,
        pushTokenCoverage: totalUsers > 0 ? Math.round((withPushToken / totalUsers) * 1000) / 10 : 0,
      },
      tiers,
      dailyActiveSeries,
    });
  } catch (err) { next(err); }
}

module.exports = { getApiAnalytics };
