// ─────────────────────────────────────────────────────────────────────────────
// Admin QUEST ANALYTICS — o'yin hodisalari, o'yinchi faolligi va level taqsimoti.
// Read-only. adminAuth ortida ishlaydi.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getQuestAnalytics(req, res, next) {
  try {
    const since30 = new Date(Date.now() - 30 * DAY);
    const eventTypes = ['territory_captured', 'territory_stolen', 'level_up', 'team_created', 'team_joined'];

    // ── 1) Events by type ──
    const byTypeRaw = await prisma.gameEvent.groupBy({
      by: ['type'],
      _count: { _all: true },
    });
    const byTypeMap = {};
    for (const r of byTypeRaw) byTypeMap[r.type] = r._count._all;
    const eventsByType = eventTypes.map(type => ({
      type,
      count: byTypeMap[type] || 0,
    }));
    const totalEvents = byTypeRaw.reduce((s, r) => s + r._count._all, 0);

    // ── 2) Daily events trend (last 30 days) ──
    const recentEvents = await prisma.gameEvent.findMany({
      where: { createdAt: { gte: since30 } },
      select: { createdAt: true },
    });
    const dailyMap = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - (29 - i) * DAY);
      dailyMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const e of recentEvents) {
      const k = new Date(e.createdAt).toISOString().slice(0, 10);
      if (k in dailyMap) dailyMap[k] += 1;
    }
    const dailyTrend = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    // ── 3) Most active players (top 20 by event count) ──
    const topActorsRaw = await prisma.gameEvent.groupBy({
      by: ['actorId'],
      where: { actorId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    });
    const actorIds = topActorsRaw.map(r => r.actorId).filter(Boolean);
    const actorUsers = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, username: true, color: true, level: true, xp: true },
        })
      : [];
    const uMap = Object.fromEntries(actorUsers.map(u => [u.id, u]));
    const mostActivePlayers = topActorsRaw.map(r => ({
      ...(uMap[r.actorId] || { id: r.actorId, username: '—' }),
      eventCount: r._count._all,
    }));

    // ── 4) Level distribution ──
    const levelDistRaw = await prisma.user.groupBy({
      by: ['level'],
      where: { isAdmin: false },
      _count: { _all: true },
      orderBy: { level: 'asc' },
    });
    const levelDistribution = levelDistRaw.map(r => ({
      level: r.level,
      count: r._count._all,
    }));

    // ── 5) Average XP and level ──
    const avgStats = await prisma.user.aggregate({
      where: { isAdmin: false },
      _avg: { xp: true, level: true },
      _count: { _all: true },
    });

    // ── 6) Peak activity hours (events grouped by hour of day) ──
    // Prisma'da raw SQL kerak — barcha hodisalarni soatga guruhlash
    const allEventsForHours = await prisma.gameEvent.findMany({
      select: { createdAt: true },
    });
    const hourMap = {};
    for (let h = 0; h < 24; h++) hourMap[h] = 0;
    for (const e of allEventsForHours) {
      const hour = new Date(e.createdAt).getUTCHours();
      hourMap[hour] += 1;
    }
    const peakHours = Object.entries(hourMap).map(([hour, count]) => ({
      hour: parseInt(hour),
      count,
    }));

    res.json({
      totalEvents,
      eventsByType,
      dailyTrend,
      mostActivePlayers,
      levelDistribution,
      averageXp: Math.round(avgStats._avg.xp || 0),
      averageLevel: Math.round((avgStats._avg.level || 0) * 10) / 10,
      totalUsers: avgStats._count._all,
      peakHours,
    });
  } catch (err) { next(err); }
}

module.exports = { getQuestAnalytics };
