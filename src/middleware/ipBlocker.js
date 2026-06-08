const BLOCK_DURATION = 7 * 60 * 1000; // 7 daqiqa
const MAX_ATTEMPTS = 3;

// ip -> { count, blockedUntil }
const store = new Map();

// Eskirgan yozuvlarni tozalash (har 10 daqiqada)
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of store) {
    if (!rec.blockedUntil || now > rec.blockedUntil + BLOCK_DURATION) {
      store.delete(ip);
    }
  }
}, 10 * 60 * 1000);

function getIp(req) {
  // 'trust proxy' o'rnatilgani uchun Express req.ip ni to'g'ri hisoblaydi —
  // eng o'ngdagi ishonchsiz hop (haqiqiy client). x-forwarded-for'ni qo'lda
  // o'qib birinchi qiymatni olish spoof qilinadi (client soxta header yuborishi mumkin).
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function ipBlockMiddleware(req, res, next) {
  const ip = getIp(req);
  const now = Date.now();
  const rec = store.get(ip);

  if (rec?.blockedUntil && now < rec.blockedUntil) {
    const remainingSec = Math.ceil((rec.blockedUntil - now) / 1000);
    const remainingMin = Math.ceil(remainingSec / 60);
    return res.status(429).json({
      error: `Siz ${remainingMin} daqiqaga bloklangansiz. Iltimos, ${remainingMin} daqiqadan keyin urinib ko'ring.`,
      code: 'IP_BLOCKED',
      blockedUntil: rec.blockedUntil,
      retryAfterSeconds: remainingSec,
    });
  }

  next();
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let rec = store.get(ip);

  if (!rec) {
    rec = { count: 0, blockedUntil: null };
  } else if (rec.blockedUntil && now > rec.blockedUntil) {
    // Blok muddati o'tgan — qayta boshlash
    rec = { count: 0, blockedUntil: null };
  }

  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.blockedUntil = now + BLOCK_DURATION;
  }
  store.set(ip, rec);
  return rec;
}

function recordSuccess(ip) {
  store.delete(ip);
}

module.exports = { ipBlockMiddleware, recordFailedAttempt, recordSuccess, getIp };
