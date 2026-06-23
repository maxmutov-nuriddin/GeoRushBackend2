// ─────────────────────────────────────────────────────────────────────────────
// Admin CONTENT ANALYTICS — hududlar, jamoalar va markerlar bo'yicha statistika.
// Read-only. adminAuth ortida ishlaydi.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getContentAnalytics(req, res, next) {
  try {
    const since30 = new Date(Date.now() - 30 * DAY);

    // ── 1) Totals ──
    const [totalTerritories, totalTeams, totalMarkers] = await Promise.all([
      prisma.territory.count(),
      prisma.team.count(),
      prisma.teamMarker.count(),
    ]);

    // ── 2) Territory stats: total area, average area, largest ──
    const areaAgg = await prisma.territory.aggregate({
      _sum: { area: true },
      _avg: { area: true },
      _max: { area: true },
    });

    const largestTerritory = await prisma.territory.findFirst({
      orderBy: { area: 'desc' },
      select: {
        id: true, name: true, emoji: true, area: true, color: true, capturedAt: true,
        owner: { select: { id: true, username: true, color: true } },
      },
    });

    // ── 3) Team stats: average members, most popular ──
    const teamAgg = await prisma.team.aggregate({
      _avg: { memberCount: true },
      _max: { memberCount: true },
    });

    const mostPopularTeam = await prisma.team.findFirst({
      orderBy: { memberCount: 'desc' },
      select: { id: true, name: true, tag: true, color: true, memberCount: true, totalArea: true },
    });

    // ── 4) Recent territories (last 20) ──
    const recentTerritories = await prisma.territory.findMany({
      orderBy: { capturedAt: 'desc' },
      take: 20,
      select: {
        id: true, name: true, emoji: true, area: true, color: true, capturedAt: true,
        owner: { select: { id: true, username: true, color: true } },
      },
    });

    // ── 5) Named vs unnamed territories ──
    const namedCount = await prisma.territory.count({
      where: { name: { not: null } },
    });
    const unnamedCount = totalTerritories - namedCount;

    // ── 6) Content creation trend (territories per day, last 30 days) ──
    const recentTerr = await prisma.territory.findMany({
      where: { capturedAt: { gte: since30 } },
      select: { capturedAt: true },
    });
    const dailyMap = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(Date.now() - (29 - i) * DAY);
      dailyMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const t of recentTerr) {
      const k = new Date(t.capturedAt).toISOString().slice(0, 10);
      if (k in dailyMap) dailyMap[k] += 1;
    }
    const creationTrend = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    // ── 7) Top territory owners ──
    const topOwnersRaw = await prisma.territory.groupBy({
      by: ['ownerId'],
      _count: { _all: true },
      _sum: { area: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });
    const ownerIds = topOwnersRaw.map(r => r.ownerId);
    const ownerUsers = ownerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, username: true, color: true, level: true },
        })
      : [];
    const oMap = Object.fromEntries(ownerUsers.map(u => [u.id, u]));
    const topOwners = topOwnersRaw.map(r => ({
      ...(oMap[r.ownerId] || { id: r.ownerId, username: '—' }),
      territories: r._count._all,
      totalArea: Math.round((r._sum.area || 0) * 100) / 100,
    }));

    res.json({
      totalTerritories,
      totalTeams,
      totalMarkers,
      totalArea: Math.round((areaAgg._sum.area || 0) * 100) / 100,
      averageArea: Math.round((areaAgg._avg.area || 0) * 100) / 100,
      maxArea: Math.round((areaAgg._max.area || 0) * 100) / 100,
      largestTerritory,
      avgTeamMembers: Math.round((teamAgg._avg.memberCount || 0) * 10) / 10,
      maxTeamMembers: teamAgg._max.memberCount || 0,
      mostPopularTeam,
      recentTerritories,
      namedCount,
      unnamedCount,
      creationTrend,
      topOwners,
    });
  } catch (err) { next(err); }
}

module.exports = { getContentAnalytics };
