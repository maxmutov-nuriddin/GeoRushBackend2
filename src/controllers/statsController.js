const { prisma } = require('../config/database');
const logger = require('../utils/logger');

// Landing sahifaning ochiq statistikasi (auth shart emas). Sahifa har ochilganda
// DB'ni count qilmaslik uchun natijani jarayon xotirasida 5 daqiqa cache qilamiz.
let cache = { data: null, at: 0 };
const TTL_MS = 5 * 60 * 1000;

// GET /api/stats/public
// { players, countries, territories, uptime } — barchasi HAQIQIY qiymat.
// uptime — env PUBLIC_STAT_UPTIME (o'lchangan SLA %); belgilanmasa null.
async function getPublicStats(req, res, next) {
  try {
    if (cache.data && Date.now() - cache.at < TTL_MS) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(cache.data);
    }

    const [players, territories, countryRows] = await Promise.all([
      prisma.user.count({ where: { isAdmin: false, isBanned: false } }),
      prisma.territory.count({ where: { owner: { isAdmin: false } } }),
      prisma.user.findMany({
        where: { isAdmin: false, country: { not: null } },
        distinct: ['country'],
        select: { country: true },
      }),
    ]);

    const countries = countryRows.filter((r) => r.country && r.country.trim()).length;

    const uptimeEnv = parseFloat(process.env.PUBLIC_STAT_UPTIME);
    const uptime = Number.isFinite(uptimeEnv) ? uptimeEnv : null;

    const data = { players, countries, territories, uptime };
    cache = { data, at: Date.now() };

    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    // Stats yiqilsa landing'ni buzmaylik — bo'sh javob, frontend "tez kunda" ko'rsatadi.
    logger.warn('getPublicStats failed:', err.message);
    res.status(200).json({ players: null, countries: null, territories: null, uptime: null });
  }
}

module.exports = { getPublicStats };
