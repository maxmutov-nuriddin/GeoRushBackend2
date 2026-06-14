module.exports = {
  // ── Tezlik chegaralari ────────────────────────────────────────────
  // Piyoda:   maks ~2 m/s  (7 km/h)
  // Yugurish: maks ~5 m/s  (18 km/h)
  // Velosiped maks ~10 m/s (36 km/h) ← ATAYIN yoqilgan gameplay qarori (velotest davri).
  // Qiymatni o'zgartirish kodda EMAS, env orqali: MAX_PLAYER_SPEED_MS=6 (faqat piyoda+yugurish).
  // Velotest yakunida prod env'da 6 qo'yiladi — kod default'i 10 bo'lib qoladi,
  // shunda env'siz lokal/test muhitlar velosiped rejimida ishlayveradi.
  MAX_PLAYER_SPEED_MS: parseFloat(process.env.MAX_PLAYER_SPEED_MS || '10'), // 10 m/s ≈ 36 km/h (velosiped)
  TELEPORT_SPEED_MS: 50,            // 50 m/s — imkonsiz harakat (teleport himoyasi)
  MAX_LOCATION_GAP_MS: 30000,       // Uzoq tanaffus chegarasi (30s)
  // Trail faqat tanaffus uzoq BO'LIB, o'sha tanaffusda shuncha metrdan KO'P siljiganда uziladi.
  // Bir joyda turib pause qilganда (GPS drift <40m) trail SAQLANADI; uzoqqa ketsa (teleport/
  // transport) uziladi (anti-cheat). Env: TRAIL_GAP_MIN_DISTANCE_M.
  TRAIL_GAP_MIN_DISTANCE_M: parseFloat(process.env.TRAIL_GAP_MIN_DISTANCE_M || '40'),
  MIN_LOCATION_INTERVAL_MS: 500,    // Ignore updates faster than 500ms
  ANTICHEAT_NEW_ROW_GAP_MS: 120000, // Anti-cheat: shuncha tanaffusdan keyin yangi "incident" qatori (2 daqiqa)
  ANTICHEAT_FLUSH_MS: 15000,        // Anti-cheat: bitta incident count'ini DB'ga yangilash oralig'i (15s)

  // Territory rules
  TERRITORY_MIN_AREA_M2: 50,        // Minimum 50 m²
  TERRITORY_MAX_AREA_M2: 15_000_000, // Max 15 km²
  MAX_TRAIL_POINTS: parseInt(process.env.MAX_TRAIL_POINTS || '5000'),
  MIN_TRAIL_POINTS_FOR_POLYGON: 4,
  // ~2m — GPS jitter/zigzag (shovqin)ni tozalaydi, chekka tekis chiqadi. Avval ~0.5m edi:
  // juda mayda bo'lgani uchun shovqin nuqtalar o'tib ketib, hudud chekkasi tikanli ko'rinardi.
  // Shakl va maydon (area) deyarli o'zgarmaydi — faqat ortiqcha sachragan nuqtalar olib tashlanadi.
  POLYGON_SIMPLIFY_TOLERANCE: parseFloat(process.env.POLYGON_SIMPLIFY_TOLERANCE || '0.00002'),

  // XP rewards
  XP_PER_100M2: 10,
  XP_TERRITORY_CAPTURE_BONUS: 50,
  XP_INVASION_BONUS: 100,
  XP_PER_LEVEL: 1000,

  // Level thresholds
  LEVELS: [0, 1000, 2500, 5000, 10000, 20000, 40000, 80000, 150000, 300000],

  // Socket rooms
  ROOM_GLOBAL: 'global',

  // Rate limits
  AUTH_RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  AUTH_RATE_LIMIT_MAX: 20,
  LOCATION_UPDATE_RATE_MS: parseInt(process.env.LOCATION_UPDATE_INTERVAL_MS || '2000'),

  // Lokatsiyani DB'ga yozish oralig'i (har user uchun). Masofa xotirada to'planadi va
  // shu oraliqda BIR marta yoziladi. Avval ~6s'da bir yozilardi (har 3 nuqta) →
  // 15s'da DB-zapros ~2.5x kamayadi; env orqali 30000 qilsa ~5x kamayadi.
  // Uzilishda va SIGTERM'da qolgan masofa baribir yoziladi (yo'qotish yo'q).
  // Live xarita pozitsiyani xotiradan (socket) oladi — DB yangiligi 15s bo'lishi yetarli.
  LOCATION_PERSIST_INTERVAL_MS: parseInt(process.env.LOCATION_PERSIST_INTERVAL_MS || '15000'),
};
