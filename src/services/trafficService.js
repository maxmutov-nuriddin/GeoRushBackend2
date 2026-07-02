// ─── Piyoda trafik — anonim agregat hisoblagich ───────────────────────────────
// Har valid GPS nuqta ~110m katakka (lat/lng 3 kasr) + hafta kuni + soat bucket'iga
// tushadi. userId FAQAT xotirada dedup uchun ishlatiladi (bir user bir katak-soatda
// bir marta sanaladi) — DB'ga HECH QACHON yozilmaydi, shuning uchun to'liq anonim.
// Buffer davriy ravishda "TrafficCell" jadvaliga UPSERT increment bilan tushadi.
// Bu B2B/B2G mahsulot xomashyosi: "qaysi nuqtadan qachon qancha odam o'tadi".
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const FLUSH_INTERVAL_MS = parseInt(process.env.TRAFFIC_FLUSH_INTERVAL_MS || '60000');
const MAX_BUFFER_KEYS = 20000; // himoya: buffer haddan oshsa darhol flush

// key `${cellLat}|${cellLng}|${dow}|${hour}` -> { count, users:Set }
let buffer = new Map();
let flushTimer = null;
let flushing = false;

function record(userId, lat, lng) {
  const now = new Date();
  const cellLat = Math.round(lat * 1000) / 1000; // ~110m
  const cellLng = Math.round(lng * 1000) / 1000;
  const dow = now.getDay();     // 0=yakshanba (UTC emas — server vaqti)
  const hour = now.getHours();
  const key = `${cellLat}|${cellLng}|${dow}|${hour}`;

  let entry = buffer.get(key);
  if (!entry) {
    entry = { count: 0, users: new Set() };
    buffer.set(key, entry);
  }
  if (entry.users.has(userId)) return; // shu katak-soatda allaqachon sanalgan
  entry.users.add(userId);
  entry.count += 1;

  if (buffer.size >= MAX_BUFFER_KEYS) flush().catch(() => {});
}

async function flush() {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = new Map();
  try {
    const rows = [];
    for (const [key, { count }] of batch) {
      const [cellLat, cellLng, dow, hour] = key.split('|').map(Number);
      // Barcha qiymatlar o'zimiz hosil qilgan raqamlar — SQL-injection xavfi yo'q
      if ([cellLat, cellLng, dow, hour, count].some((n) => !Number.isFinite(n))) continue;
      rows.push(`(${cellLat}, ${cellLng}, ${dow}, ${hour}, ${count}, NOW())`);
    }
    if (!rows.length) return;
    // Bitta so'rovda hammasi — hot path'ga N ta round-trip yuk bo'lmasin
    await prisma.$executeRawUnsafe(`
      INSERT INTO "TrafficCell" ("cellLat", "cellLng", "dow", "hour", "count", "updatedAt")
      VALUES ${rows.join(',')}
      ON CONFLICT ("cellLat", "cellLng", "dow", "hour")
      DO UPDATE SET "count" = "TrafficCell"."count" + EXCLUDED."count", "updatedAt" = NOW()
    `);
  } catch (err) {
    logger.warn('Traffic flush failed:', err.message.split('\n')[0]);
  } finally {
    flushing = false;
  }
}

function startTrafficFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

// Graceful shutdown (SIGTERM) — qolgan bucket'lar yo'qolmasin
async function flushTraffic() {
  return flush();
}

module.exports = { record, startTrafficFlusher, flushTraffic };
