// "Xavfsiz marshrut" — piyoda yo'nalishni OSRM (foot profil) beradi, biz esa har
// variantni O'ZIMIZNING TrafficCell gavjumlik ma'lumoti bilan baholaymiz: shu soatda
// odamlar yuradigan kataklardan o'tadigan yo'l = yorug'/odamli = xavfsizroq.
// FAQAT KO'RSATISH uchun — o'yin logikasiga (capture/XP) aloqasi yo'q.
//
// Tashqi bog'liqlik saboqlari (Overpass prod'da yiqilgan edi): OSRM chaqiruvi qattiq
// timeout bilan, xato bo'lsa toza xabar qaytadi — hech narsa osilib qolmaydi.
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const OSRM_BASE = process.env.OSRM_FOOT_URL || 'https://routing.openstreetmap.de/routed-foot';
const OSRM_TIMEOUT_MS = 9000;
const MAX_DIST_KM = 15;          // juda uzoq so'rovlar rad (bepul router + telefon UX)
const TZ_OFFSET_MIN = parseInt(process.env.TRAFFIC_TZ_OFFSET_MIN || '300');
const COUNT_CAP = 5;             // bitta katakning ballga hissasi shu bilan cheklanadi

function toCell(v) { return Math.round(v * 1000) / 1000; }

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Hozirgi (O'zbekiston vaqti) soat atrofidagi 3 soatlik oynada gavjum kataklarni olamiz.
// Shahar miqyosida bu bir necha ming qator — xotirada Map bo'lib ketadi.
async function loadBusyCells() {
  const shifted = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
  const dow = shifted.getUTCDay();
  const hour = shifted.getUTCHours();
  const hours = [(hour + 23) % 24, hour, (hour + 1) % 24];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "cellLat", "cellLng", SUM("count")::int AS c
     FROM "TrafficCell"
     WHERE "dow" = $1 AND "hour" = ANY($2::int[]) AND "count" > 0
     GROUP BY "cellLat", "cellLng"
     LIMIT 30000`,
    dow, hours
  );
  const map = new Map();
  for (const r of rows) map.set(`${r.cellLat}|${r.cellLng}`, r.c);
  return map;
}

// Marshrut geometriyasi kesib o'tadigan unikal kataklar bo'yicha gavjumlik balli (0..1).
function scoreRoute(coordinates, busy) {
  const cells = new Set();
  for (const [lng, lat] of coordinates) cells.add(`${toCell(lat)}|${toCell(lng)}`);
  if (cells.size === 0) return { score: 0, busyCells: 0, totalCells: 0 };
  let sum = 0, hit = 0;
  for (const key of cells) {
    const c = busy.get(key) || 0;
    if (c > 0) { hit += 1; sum += Math.min(c, COUNT_CAP); }
  }
  return {
    score: Math.round((sum / (cells.size * COUNT_CAP)) * 100) / 100,
    busyCells: hit,
    totalCells: cells.size,
  };
}

// POST /api/safe-route { fromLat, fromLng, toLat, toLng }
async function getSafeRoute(req, res) {
  const { fromLat, fromLng, toLat, toLng } = req.body || {};
  const nums = [fromLat, fromLng, toLat, toLng];
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return res.status(400).json({ error: 'BAD_COORDS' });
  }
  if (Math.abs(fromLat) > 90 || Math.abs(toLat) > 90 || Math.abs(fromLng) > 180 || Math.abs(toLng) > 180) {
    return res.status(400).json({ error: 'BAD_COORDS' });
  }
  if (haversineKm(fromLat, fromLng, toLat, toLng) > MAX_DIST_KM) {
    return res.status(400).json({ error: 'TOO_FAR' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSRM_TIMEOUT_MS);
  try {
    const url = `${OSRM_BASE}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}` +
      `?alternatives=true&geometries=geojson&overview=full&steps=false`;
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'GeoRush/1.0' } });
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const data = await r.json();
    if (data.code !== 'Ok' || !data.routes?.length) {
      return res.status(404).json({ error: 'NO_ROUTE' });
    }

    const busy = await loadBusyCells();
    const scored = data.routes.map((rt) => {
      const s = scoreRoute(rt.geometry.coordinates, busy);
      return {
        distanceM: Math.round(rt.distance),
        durationMin: Math.round(rt.duration / 60),
        coordinates: rt.geometry.coordinates, // [lng,lat][]
        ...s,
      };
    });

    // Eng gavjum (xavfsizroq) variant; teng bo'lsa qisqasi.
    const best = [...scored].sort((a, b) => (b.score - a.score) || (a.distanceM - b.distanceM))[0];
    const fastest = [...scored].sort((a, b) => a.distanceM - b.distanceM)[0];

    // To'g'ri chiziq 15km ichida bo'lsa ham, REAL yo'l haddan tashqari uzun bo'lsa rad
    // (piyoda UX + bepul routerga hurmat).
    if (fastest.distanceM > 25000) {
      return res.status(400).json({ error: 'TOO_FAR' });
    }

    res.json({
      safe: best,
      fastestDistanceM: fastest.distanceM,
      sameAsFastest: best === fastest,
      // Ma'lumot kamligi haqida halol signal — frontend "hali kam joy o'rganilgan" deb ko'rsatadi
      lowData: best.busyCells < 3,
    });
  } catch (err) {
    logger.warn('safe-route failed:', err.message);
    res.status(502).json({ error: 'ROUTER_UNAVAILABLE' });
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/safe-route/arrived { arrived, distanceM, durationMin }
// Navigatsiya tugaganda: foydalanuvchi manzilga yetib keldimi — DB'ga yoziladi (xavfsizlik
// analitikasi: nechta xavfsiz yetib borish, o'rtacha masofa). Xom GPS SAQLANMAYDI.
async function recordArrival(req, res, next) {
  try {
    const me = String(req.user.id);
    const arrived = req.body?.arrived === true;
    const distanceM = Math.max(0, Math.round(Number(req.body?.distanceM) || 0));
    const durationMin = Math.max(0, Math.round(Number(req.body?.durationMin) || 0));
    const { randomUUID } = require('crypto');
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SafeArrival" ("id","userId","arrived","distanceM","durationMin")
       VALUES ($1,$2,$3,$4,$5)`,
      randomUUID(), me, arrived, distanceM, durationMin
    ).catch((e) => logger.warn('SafeArrival insert skip:', e.message.split('\n')[0]));
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { getSafeRoute, recordArrival };
