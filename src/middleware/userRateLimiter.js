// Foydalanuvchi (userId) bo'yicha API rate-limit — IP emas, AUTHENTIKATSIYA qilingan
// foydalanuvchi bo'yicha. Bitta NAT-IP ortidagi ko'p o'yinchi bir-birini bloklamaydi
// (har kim o'z hisobidan oladi); aksincha bitta odam ko'p IP'dan bombardimon qilolmaydi.
//
// Realizatsiya: in-memory fixed-window (MVP, bitta instance uchun). SCALE-OUT bo'lsa
// REDIS_URL bor — INCR+EXPIRE'ga ko'chiriladi.
//
// Chegara env orqali: USER_RATE_LIMIT_PER_MIN (default 300). Oddiy faol o'yin ≈ 30
// REST/daqiqa (jonli xarita SOCKETда — bu sanoqqa kirmaydi), shuning uchun 300 ≈ 10x
// zaxira: haqiqiy o'yinchi deyarli urilmaydi, bot (daqiqada minglab) baribir to'xtaydi.
// Monitoringдан so'ng kerak bo'lsa env bilan pasaytiriladi.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.USER_RATE_LIMIT_PER_MIN || 300);

const buckets = new Map(); // userId -> { count, resetAt }

// Eskirgan bucket'larni davriy tozalash — xotira cheksiz o'smasin. unref → process'ni bloklamaydi.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now > b.resetAt) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

// Bitta so'rovni hisobga oladi. { ok, retryAfterSec } qaytaradi.
function hitUserRateLimit(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(userId, b);
  }
  b.count += 1;
  if (b.count > MAX_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

module.exports = { hitUserRateLimit, MAX_PER_WINDOW };
