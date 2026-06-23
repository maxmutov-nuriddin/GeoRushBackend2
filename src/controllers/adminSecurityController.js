// ─────────────────────────────────────────────────────────────────────────────
// Admin SECURITY — xavfsizlik analitikasi (read-only).
// Ban, warning, anti-cheat va login faoliyati statistikalari.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getSecurityAnalytics(req, res, next) {
  try {
    const now = Date.now();
    const since24h = new Date(now - DAY);
    const since7d  = new Date(now - 7 * DAY);
    const since30d = new Date(now - 30 * DAY);

    const [
      bannedCount, totalWarnings,
      antiCheat24h, antiCheat7d, antiCheat30d,
      warnLow, warnMedium, warnHigh,
      loginActivity24h,
    ] = await Promise.all([
      prisma.user.count({ where: { isBanned: true } }),
      prisma.warning.count(),
      prisma.antiCheatLog.count({ where: { createdAt: { gte: since24h } } }),
      prisma.antiCheatLog.count({ where: { createdAt: { gte: since7d } } }),
      prisma.antiCheatLog.count({ where: { createdAt: { gte: since30d } } }),
      prisma.warning.count({ where: { severity: 'low' } }),
      prisma.warning.count({ where: { severity: 'medium' } }),
      prisma.warning.count({ where: { severity: 'high' } }),
      prisma.user.count({ where: { isAdmin: false, lastSeen: { gte: since24h } } }),
    ]);

    // ── Top flagged users (eng ko'p anti-cheat yozuvlari) ──
    const topFlaggedRaw = await prisma.antiCheatLog.groupBy({
      by: ['userId'],
      _sum: { count: true },
      _count: { _all: true },
      orderBy: { _sum: { count: 'desc' } },
      take: 10,
    });
    const flaggedIds = topFlaggedRaw.map(r => r.userId).filter(Boolean);
    const flaggedUsers = flaggedIds.length
      ? await prisma.user.findMany({
          where: { id: { in: flaggedIds } },
          select: { id: true, username: true, color: true, level: true, isBanned: true },
        })
      : [];
    const uMap = Object.fromEntries(flaggedUsers.map(u => [u.id, u]));
    const topFlagged = topFlaggedRaw.map(r => ({
      ...(uMap[r.userId] || { id: r.userId, username: '—' }),
      totalFlags: r._sum.count || 0,
      logEntries: r._count._all,
    }));

    // ── So'nggi banlar (isBanned=true, updatedAt bo'yicha tartiblangan) ──
    const recentBans = await prisma.user.findMany({
      where: { isBanned: true },
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: {
        id: true, username: true, color: true, level: true,
        updatedAt: true, createdAt: true,
      },
    });

    // ── Anti-cheat type taqsimoti ──
    const antiCheatByType = await prisma.antiCheatLog.groupBy({
      by: ['type'],
      _sum: { count: true },
      _count: { _all: true },
    });
    const typeDistribution = antiCheatByType.map(r => ({
      type: r.type,
      totalFlags: r._sum.count || 0,
      entries: r._count._all,
    })).sort((a, b) => b.totalFlags - a.totalFlags);

    res.json({
      overview: {
        bannedUsers: bannedCount,
        totalWarnings,
        loginActivity24h,
      },
      antiCheat: {
        last24h: antiCheat24h,
        last7d: antiCheat7d,
        last30d: antiCheat30d,
        byType: typeDistribution,
      },
      warnings: {
        total: totalWarnings,
        low: warnLow,
        medium: warnMedium,
        high: warnHigh,
      },
      topFlagged,
      recentBans,
    });
  } catch (err) { next(err); }
}

module.exports = { getSecurityAnalytics };
