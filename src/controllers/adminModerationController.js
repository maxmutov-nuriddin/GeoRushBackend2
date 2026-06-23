// ─────────────────────────────────────────────────────────────────────────────
// Admin MODERATION — ogohlantirish (warning) va moderatsiya analitikasi.
// Read-only endpoint, adminAuth ortida.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getModerationAnalytics(req, res, next) {
  try {
    const now = Date.now();
    const since7d = new Date(now - 7 * DAY);

    const [
      totalWarnings, warnLow, warnMedium, warnHigh,
      totalTerritories, totalTeams,
      bannedCount,
    ] = await Promise.all([
      prisma.warning.count(),
      prisma.warning.count({ where: { severity: 'low' } }),
      prisma.warning.count({ where: { severity: 'medium' } }),
      prisma.warning.count({ where: { severity: 'high' } }),
      prisma.territory.count(),
      prisma.team.count(),
      prisma.user.count({ where: { isBanned: true } }),
    ]);

    // ── So'nggi 20 warning (admin va user ma'lumotlari bilan) ──
    const recentWarnings = await prisma.warning.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        user: {
          select: { id: true, username: true, color: true, level: true, isBanned: true },
        },
        admin: {
          select: { id: true, username: true },
        },
      },
    });

    // ── Banlangan foydalanuvchilar (so'nggi warninglari bilan) ──
    const bannedUsers = await prisma.user.findMany({
      where: { isBanned: true },
      orderBy: { updatedAt: 'desc' },
      take: 30,
      select: {
        id: true, username: true, color: true, level: true,
        createdAt: true, updatedAt: true,
        warningsReceived: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { reason: true, severity: true, createdAt: true },
        },
      },
    });
    const bannedList = bannedUsers.map(u => ({
      id: u.id,
      username: u.username,
      color: u.color,
      level: u.level,
      createdAt: u.createdAt,
      bannedAt: u.updatedAt,
      lastWarning: u.warningsReceived[0] || null,
    }));

    // ── 7 kunlik warning trendi ──
    const last7Warnings = await prisma.warning.findMany({
      where: { createdAt: { gte: since7d } },
      select: { createdAt: true, severity: true },
    });
    const trendMap = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(now - (6 - i) * DAY);
      trendMap[d.toISOString().slice(0, 10)] = { low: 0, medium: 0, high: 0, total: 0 };
    }
    for (const w of last7Warnings) {
      const k = new Date(w.createdAt).toISOString().slice(0, 10);
      if (k in trendMap) {
        trendMap[k][w.severity] = (trendMap[k][w.severity] || 0) + 1;
        trendMap[k].total += 1;
      }
    }
    const weeklyTrend = Object.entries(trendMap).map(([date, counts]) => ({
      date,
      ...counts,
    }));

    res.json({
      overview: {
        totalWarnings,
        low: warnLow,
        medium: warnMedium,
        high: warnHigh,
        bannedUsers: bannedCount,
      },
      content: {
        totalTerritories,
        totalTeams,
      },
      recentWarnings: recentWarnings.map(w => ({
        id: w.id,
        reason: w.reason,
        severity: w.severity,
        createdAt: w.createdAt,
        user: w.user,
        admin: w.admin,
      })),
      bannedList,
      weeklyTrend,
    });
  } catch (err) { next(err); }
}

module.exports = { getModerationAnalytics };
