const { haversineDistance, calculateSpeed } = require('./geoService');
const constants = require('../config/constants');
const logger = require('../utils/logger');

// In-memory store for last known positions (replace with Redis in production)
const playerPositions = new Map();
// Ketma-ket tezlik-outlier'lar soni — yagona GPS sakrashini haqiqiy relokatsiyadan ajratish uchun
const consecutiveRejects = new Map();

// Shuncha ketma-ket outlier'dan keyin trail reset qilinadi (haqiqiy relokatsiya — masalan
// tunneldan chiqish — foydalanuvchi "qotib" qolmasligi uchun). Bundan kami — yagona GPS spike.
const MAX_CONSECUTIVE_REJECTS = 2;

function validateLocationUpdate(userId, newLat, newLng, clientTimestamp) {
  const now = Date.now();
  const previous = playerPositions.get(userId);

  if (!previous) {
    playerPositions.set(userId, { lat: newLat, lng: newLng, timestamp: now });
    consecutiveRejects.set(userId, 0);
    return { valid: true, isFirstUpdate: true };
  }

  const timeDelta = now - previous.timestamp;
  const distanceM = haversineDistance(previous.lat, previous.lng, newLat, newLng);

  // Ignore if update is too fast (likely duplicate)
  if (timeDelta < constants.MIN_LOCATION_INTERVAL_MS) {
    return { valid: false, reason: 'update_too_fast' };
  }

  // GPS jitter: turgan joyda ham 3-8m xato bo'ladi — kichik masofani o'tkazib yuboramiz
  if (distanceM < 8) {
    playerPositions.set(userId, { lat: newLat, lng: newLng, timestamp: now });
    consecutiveRejects.set(userId, 0);
    return { valid: true, speed: 0, distance: distanceM, trailGap: false };
  }

  const speedMs = distanceM / (timeDelta / 1000);

  // Teleport detection (impossibly fast movement) — har doim trail reset, yangi pozitsiya qabul
  if (speedMs > constants.TELEPORT_SPEED_MS) {
    logger.warn(`Teleport detected for user ${userId}: ${speedMs.toFixed(1)} m/s`);
    playerPositions.set(userId, { lat: newLat, lng: newLng, timestamp: now });
    consecutiveRejects.set(userId, 0);
    return { valid: true, teleport: true };
  }

  // Tezlik chegarasidan oshsa — mashina yoki GPS sakrash
  // (ruxsat etilgan: piyoda ≤2 m/s, yugurish ≤5 m/s, velosiped ≤10 m/s)
  if (speedMs > constants.MAX_PLAYER_SPEED_MS) {
    const rejects = (consecutiveRejects.get(userId) || 0) + 1;
    const bigGap = timeDelta > constants.MAX_LOCATION_GAP_MS;

    // Yagona/qisqa outlier (GPS spike) — nuqtani RAD ETAMIZ, trailni saqlaymiz.
    // Pozitsiyani yangilamaymiz: keyingi nuqta oxirgi TO'G'RI nuqta bilan solishtiriladi.
    // Mashina kabi DAVOMLI tez harakatda esa har nuqta rad etiladi → trail to'planmaydi (cheat himoyasi saqlanadi).
    if (rejects <= MAX_CONSECUTIVE_REJECTS && !bigGap) {
      consecutiveRejects.set(userId, rejects);
      logger.warn(`Speed outlier rejected for user ${userId}: ${speedMs.toFixed(1)} m/s (reject ${rejects})`);
      return { valid: true, reject: true };
    }

    // Ketma-ket ko'p outlier yoki katta vaqt tanaffusi — haqiqiy (uzluksiz) relokatsiya:
    // masalan MASHINA/transport yoki tunneldan chiqish. Bu CHIT EMAS — trailni reset qilib
    // (capture bo'lmasin) yangi pozitsiyani qabul qilamiz, lekin 'teleport' deb LOG QILMAYMIZ.
    // Faqat >TELEPORT_SPEED_MS (imkonsiz sakrash = fake-GPS) yuqorida 'teleport' bo'lib loglanadi.
    logger.warn(`Speed relocate for user ${userId}: ${speedMs.toFixed(1)} m/s (limit ${constants.MAX_PLAYER_SPEED_MS})`);
    playerPositions.set(userId, { lat: newLat, lng: newLng, timestamp: now });
    consecutiveRejects.set(userId, 0);
    return { valid: true, relocate: true, speed: speedMs };
  }

  // Normal harakat — outlier hisoblagichni nollaymiz.
  // Trail "uzilishi" = uzoq tanaffus (>30s) VA o'sha tanaffusда UZOQQA siljish (>40m).
  // Bir joyda turib pause qilgan bo'lsa (masofa kichik) → trailGap=false → yo'l SAQLANADI.
  // Uzoqqa siljish bo'lsa (teleport/transport, GPS sakrash) → trailGap=true → yo'l uziladi.
  const trailGap = timeDelta > constants.MAX_LOCATION_GAP_MS
    && distanceM > constants.TRAIL_GAP_MIN_DISTANCE_M;

  playerPositions.set(userId, { lat: newLat, lng: newLng, timestamp: now });
  consecutiveRejects.set(userId, 0);

  return {
    valid: true,
    speed: speedMs,
    distance: distanceM,
    trailGap,
  };
}

function removePlayer(userId) {
  playerPositions.delete(userId);
  consecutiveRejects.delete(userId);
}

function getPlayerPosition(userId) {
  return playerPositions.get(userId) || null;
}

module.exports = { validateLocationUpdate, removePlayer, getPlayerPosition };
