// ─────────────────────────────────────────────────────────────────────────────
// Admin REGIONS ANALYTICS — mintaqaviy taqsimot va o'sish tahlili.
// Read-only. adminAuth ortida ishlaydi.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getRegionsAnalytics(req, res, next) {
  try {
    const base = { isAdmin: false };
    const since30 = new Date(Date.now() - 30 * DAY);

    // ── 1) All unique countries with user counts ──
    const countriesRaw = await prisma.user.groupBy({
      by: ['country'],
      where: { ...base, country: { not: null } },
      _count: { country: true },
      _avg: { xp: true, level: true },
    });
    const countries = countriesRaw
      .map(r => ({
        name: r.country,
        userCount: r._count.country,
        avgXp: Math.round(r._avg.xp || 0),
        avgLevel: Math.round((r._avg.level || 0) * 10) / 10,
      }))
      .sort((a, b) => b.userCount - a.userCount);

    // ── 2) All unique cities with user counts ──
    const citiesRaw = await prisma.user.groupBy({
      by: ['city'],
      where: { ...base, city: { not: null } },
      _count: { city: true },
    });
    const cities = citiesRaw
      .map(r => ({ name: r.city, userCount: r._count.city }))
      .sort((a, b) => b.userCount - a.userCount);

    // ── 3) Regional activity — estimate events per country
    //    (join user.country with GameEvent.actorId)
    const usersWithCountry = await prisma.user.findMany({
      where: { ...base, country: { not: null } },
      select: { id: true, country: true },
    });
    const userCountryMap = {};
    for (const u of usersWithCountry) userCountryMap[u.id] = u.country;

    const eventActors = await prisma.gameEvent.groupBy({
      by: ['actorId'],
      where: { actorId: { not: null } },
      _count: { _all: true },
    });
    const countryActivity = {};
    for (const e of eventActors) {
      const country = userCountryMap[e.actorId];
      if (country) {
        countryActivity[country] = (countryActivity[country] || 0) + e._count._all;
      }
    }
    const regionalActivity = Object.entries(countryActivity)
      .map(([country, events]) => ({ country, events }))
      .sort((a, b) => b.events - a.events);

    // ── 4) Premium distribution by country ──
    const premiumByCountryRaw = await prisma.user.groupBy({
      by: ['country'],
      where: { ...base, isPremium: true, country: { not: null } },
      _count: { country: true },
    });
    const premiumByCountry = premiumByCountryRaw
      .map(r => ({ country: r.country, premiumUsers: r._count.country }))
      .sort((a, b) => b.premiumUsers - a.premiumUsers);

    // Premium rate per country (premium_count / total_count)
    const countryTotalMap = {};
    for (const c of countries) countryTotalMap[c.name] = c.userCount;
    const premiumDistribution = premiumByCountry.map(p => ({
      ...p,
      totalUsers: countryTotalMap[p.country] || 0,
      premiumRate: countryTotalMap[p.country] > 0
        ? Math.round((p.premiumUsers / countryTotalMap[p.country]) * 1000) / 10
        : 0,
    }));

    // ── 5) Growth by region — new users per country (last 30 days) ──
    const newUsersRaw = await prisma.user.groupBy({
      by: ['country'],
      where: { ...base, country: { not: null }, createdAt: { gte: since30 } },
      _count: { country: true },
    });
    const growthByRegion = newUsersRaw
      .map(r => ({
        country: r.country,
        newUsers: r._count.country,
        totalUsers: countryTotalMap[r.country] || 0,
      }))
      .sort((a, b) => b.newUsers - a.newUsers);

    // ── 6) Summary stats ──
    const totalUsers = await prisma.user.count({ where: base });
    const totalPremium = await prisma.user.count({ where: { ...base, isPremium: true } });

    res.json({
      totalUsers,
      totalPremium,
      totalCountries: countries.length,
      totalCities: cities.length,
      countries,
      cities,
      regionalActivity,
      premiumDistribution,
      growthByRegion,
    });
  } catch (err) { next(err); }
}

module.exports = { getRegionsAnalytics };
