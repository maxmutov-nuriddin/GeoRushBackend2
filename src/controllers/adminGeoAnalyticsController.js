// ─────────────────────────────────────────────────────────────────────────────
// Admin GEO ANALYTICS — geografik ma'lumotlar tahlili.
// Read-only. adminAuth ortida ishlaydi.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');
const { decLocation } = require('../utils/fieldCrypto');

async function getGeoAnalyticsData(req, res, next) {
  try {
    const base = { isAdmin: false };

    // ── 1) Users by country & city ──
    const [byCountryRaw, byCityRaw, totalUsers, totalTerritories] = await Promise.all([
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
      prisma.user.count({ where: base }),
      prisma.territory.count(),
    ]);

    const allCountries = byCountryRaw
      .map(r => ({ name: r.country, count: r._count.country }))
      .sort((a, b) => b.count - a.count);

    const allCities = byCityRaw
      .map(r => ({ name: r.city, count: r._count.city }))
      .sort((a, b) => b.count - a.count);

    // ── 2) Top 10 ──
    const topCountries = allCountries.slice(0, 10);
    const topCities = allCities.slice(0, 10);

    // ── 3) Users with geo vs without geo ──
    const withGeo = await prisma.user.count({
      where: { ...base, OR: [{ country: { not: null } }, { city: { not: null } }] },
    });
    const withoutGeo = totalUsers - withGeo;

    // ── 4) Users with lastLocation ──
    const withLocation = await prisma.user.count({
      where: { ...base, lastLocation: { not: null } },  // Prisma treats null vs not-null for Json
    });

    // ── 5) Territory density (territories per user avg) ──
    const usersWithTerritories = await prisma.territory.groupBy({
      by: ['ownerId'],
      _count: { _all: true },
    });
    const territoryDensity = totalUsers > 0
      ? Math.round((totalTerritories / totalUsers) * 100) / 100
      : 0;

    // ── 6) Recent locations (last 20 users with lastLocation, ordered by lastSeen) ──
    const recentLocations = await prisma.user.findMany({
      where: { ...base, lastLocation: { not: null } },
      orderBy: { lastSeen: 'desc' },
      take: 20,
      select: {
        id: true,
        username: true,
        color: true,
        level: true,
        city: true,
        country: true,
        lastLocation: true,
        lastSeen: true,
      },
    });

    // ── 7) Geo coverage by country (percent of total users) ──
    const geoCoverage = topCountries.map(c => ({
      ...c,
      percent: totalUsers > 0 ? Math.round((c.count / totalUsers) * 1000) / 10 : 0,
    }));

    res.json({
      totalUsers,
      totalCountries: allCountries.length,
      totalCities: allCities.length,
      topCountries,
      topCities,
      allCountries,
      allCities,
      withGeo,
      withoutGeo,
      withLocation,
      territoryDensity,
      totalTerritories,
      recentLocations: recentLocations.map(u => ({ ...u, lastLocation: decLocation(u.lastLocation) })),
      geoCoverage,
    });
  } catch (err) { next(err); }
}

module.exports = { getGeoAnalyticsData };
