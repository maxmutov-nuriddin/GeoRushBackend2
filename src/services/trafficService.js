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

// Soat/kun bucket'lari HAR DOIM O'zbekiston vaqtida (UTC+5) hisoblanadi — server
// qayerda turishidan qat'i nazar (Render = UTC; usiz "eng gavjum soat" 5 soatga adashadi).
const TZ_OFFSET_MIN = parseInt(process.env.TRAFFIC_TZ_OFFSET_MIN || '300');

// GPS sakrashiga qarshi gisterezis: katak faqat foydalanuvchining KAMIDA 2 ta KETMA-KET
// nuqtasi shu katakka tushsagina sanaladi. Yurishda har katakka o'nlab nuqta tushadi
// (2s interval, ~110m katak), shuning uchun haqiqiy o'tish hech qachon yo'qolmaydi;
// bitta adashgan nuqta (qo'shni katakka "sachrash") esa endi hisobga kirmaydi.
const CONFIRM_POINTS = 2;
let pending = new Map(); // userId -> { key, streak }
const MAX_PENDING = 50000;

// Kunlik REAL yuruvchilar — userId FAQAT xotirada (Set), bazaga faqat UMUMIY SON
// yoziladi (TrafficDaily.walkers). "Bugun nechta odam yurdi" savoliga aniq javob.
let dayWalkers = new Set();
let dayStamp = '';

// key `${cellLat}|${cellLng}|${dow}|${hour}` -> { count }
let buffer = new Map();
let flushTimer = null;
let flushing = false;

// Dedup buffer'dan MUSTAQIL yashaydi: buffer har flush'da (60s) yangilanadi, lekin
// "bir user bir katak-SOATDA bir marta" qoidasi butun soat davomida amal qilishi kerak.
// Aks holda bir joyda turgan odam har flush oynasida qayta sanalib, raqamni shishirardi.
// Soat almashganda to'liq tozalanadi (userId shu Set'dan boshqa hech qayerda yashamaydi).
let seen = new Set();   // `${cellLat}|${cellLng}|${userId}`
let seenStamp = '';     // `${dow}|${hour}`
const MAX_SEEN = 300000; // himoya: xotira cheksiz o'smasin

function record(userId, lat, lng) {
  // UTC+offset — serverning o'z vaqt mintaqasiga bog'liq emas
  const shifted = new Date(Date.now() + TZ_OFFSET_MIN * 60000);

  // Kunlik yuruvchi hisobi — gisterezis/dedup'dan OLDIN: bitta valid nuqta ham
  // "bu odam bugun yurdi" degani. Kun (UZ vaqti) almashsa Set yangilanadi.
  const dstr = shifted.toISOString().slice(0, 10);
  if (dstr !== dayStamp) { dayStamp = dstr; dayWalkers = new Set(); }
  dayWalkers.add(userId);
  const cellLat = Math.round(lat * 1000) / 1000; // ~110m
  const cellLng = Math.round(lng * 1000) / 1000;
  const dow = shifted.getUTCDay();   // 0=yakshanba, O'zbekiston vaqtida
  const hour = shifted.getUTCHours();

  // Gisterezis: shu katakda 2-nuqta kelgandagina davom etamiz
  const cellId = `${cellLat}|${cellLng}`;
  const p = pending.get(userId);
  if (!p || p.key !== cellId) {
    if (pending.size >= MAX_PENDING) pending.clear();
    pending.set(userId, { key: cellId, streak: 1 });
    return; // birinchi nuqta — hali tasdiqlanmagan
  }
  if (p.streak < CONFIRM_POINTS) p.streak += 1;
  if (p.streak < CONFIRM_POINTS) return;

  const stamp = `${dow}|${hour}`;
  if (stamp !== seenStamp) { seenStamp = stamp; seen = new Set(); }
  const seenKey = `${cellLat}|${cellLng}|${userId}`;
  if (seen.has(seenKey)) return; // shu katak-soatda allaqachon sanalgan
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.add(seenKey);

  const key = `${cellLat}|${cellLng}|${dow}|${hour}`;
  let entry = buffer.get(key);
  if (!entry) {
    entry = { count: 0 };
    buffer.set(key, entry);
  }
  entry.count += 1;

  if (buffer.size >= MAX_BUFFER_KEYS) flush().catch(() => {});
}

async function flush() {
  if (flushing || (buffer.size === 0 && dayWalkers.size === 0)) return;
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
    if (rows.length) {
    // Bitta so'rovda hammasi — hot path'ga N ta round-trip yuk bo'lmasin
    await prisma.$executeRawUnsafe(`
      INSERT INTO "TrafficCell" ("cellLat", "cellLng", "dow", "hour", "count", "updatedAt")
      VALUES ${rows.join(',')}
      ON CONFLICT ("cellLat", "cellLng", "dow", "hour")
      DO UPDATE SET "count" = "TrafficCell"."count" + EXCLUDED."count", "updatedAt" = NOW()
    `);
    }

    // Kunlik yuruvchilar soni — GREATEST bilan (restart bo'lsa kamayib ketmasin)
    if (dayStamp && dayWalkers.size > 0) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "TrafficDaily" ("date", "walkers", "updatedAt") VALUES ($1, $2, NOW())
        ON CONFLICT ("date")
        DO UPDATE SET "walkers" = GREATEST("TrafficDaily"."walkers", EXCLUDED."walkers"), "updatedAt" = NOW()
      `, dayStamp, dayWalkers.size);
    }
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
