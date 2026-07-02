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

// ── Jonli globus (landing) — anonim hudud nuqtalari ─────────────────────────
// Faqat markaz-nuqta + rang + vaqt qaytadi: username/ID/geometriya YO'Q.
// Xuddi shu 5 daqiqalik jarayon-ichi cache uslubi.
let globeCache = { data: null, at: 0 };
const GLOBE_LIMIT = 800;

// GeoJSON Polygon markazi — tashqi halqa o'rtachasi (ko'rsatish uchun yetarli aniqlik)
function polygonCenter(polygon) {
  try {
    const ring = polygon?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;
    let sLng = 0, sLat = 0;
    for (const [lng, lat] of ring) { sLng += lng; sLat += lat; }
    return [sLat / ring.length, sLng / ring.length];
  } catch { return null; }
}

// GET /api/stats/globe
// { points: [{ lat, lng, color, t }], total } — t = capturedAt (epoch ms, puls uchun)
async function getGlobePoints(req, res) {
  try {
    if (globeCache.data && Date.now() - globeCache.at < TTL_MS) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(globeCache.data);
    }

    const [rows, total] = await Promise.all([
      prisma.territory.findMany({
        where: { owner: { isAdmin: false, isBanned: false } },
        select: { polygon: true, color: true, capturedAt: true },
        orderBy: { capturedAt: 'desc' },
        take: GLOBE_LIMIT,
      }),
      prisma.territory.count({ where: { owner: { isAdmin: false } } }),
    ]);

    const points = [];
    for (const r of rows) {
      const c = polygonCenter(r.polygon);
      if (!c) continue;
      // Koordinata ~1km aniqlikkacha yaxlitlanadi — shaxsiy manzil aniqlanmasin
      points.push({
        lat: Math.round(c[0] * 100) / 100,
        lng: Math.round(c[1] * 100) / 100,
        color: r.color || '#00ff88',
        t: new Date(r.capturedAt).getTime(),
      });
    }

    const data = { points, total };
    globeCache = { data, at: Date.now() };

    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    logger.warn('getGlobePoints failed:', err.message);
    res.status(200).json({ points: [], total: null });
  }
}

module.exports = { getPublicStats, getGlobePoints };
