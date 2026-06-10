const { validateLocationUpdate } = require('../../services/antiCheatService');
const { haversineDistance } = require('../../services/geoService');
const { prisma } = require('../../config/database');
const constants = require('../../config/constants');
const { tierOf, entitlements } = require('../../config/tiers');
const logger = require('../../utils/logger');

const userTrails = new Map();
const pendingDistance = new Map(); // userId -> accumulated meters (not yet flushed to DB)

// ── Ultra: yaqinlashuv (proximity) bildirishnomasi ───────────────────────────
// Raqib hududingга ~150m ga yaqinlashganda, ONLAYN Ultra egaga real-time ogohlantirish.
// Hot path'da: har user uchun 30s throttle + best-effort (xato bo'lsa jim o'tadi).
const lastProximityAt = new Map();   // userId -> ts
const proximityNotified = new Map(); // `${ownerId}:${attackerId}` -> ts
const PROXIMITY_TTL_MS = 5 * 60 * 1000;

// proximityNotified juftlik-kalitlari disconnect'da tozalanmaydi — chegaradan oshsa
// eskirgan yozuvlarni olib tashlaymiz (cheksiz o'sishning oldini oladi).
function sweepProximityNotified(now) {
  if (proximityNotified.size < 5000) return;
  for (const [key, ts] of proximityNotified) {
    if (now - ts > PROXIMITY_TTL_MS) proximityNotified.delete(key);
  }
}

async function checkProximity(io, onlinePlayers, attackerId, lat, lng) {
  try {
    const now = Date.now();
    if (now - (lastProximityAt.get(attackerId) || 0) < 30000) return;
    lastProximityAt.set(attackerId, now);
    const d = 0.0015; // ~150m bbox
    const box = { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] };
    const terr = await prisma.$queryRaw`
      SELECT "ownerId" FROM "Territory"
      WHERE "ownerId" != ${attackerId}
      AND ST_Intersects(
        ST_GeomFromGeoJSON(polygon::text),
        ST_GeomFromGeoJSON(${JSON.stringify(box)}::json)
      )
      LIMIT 20
    `;
    if (!terr.length) return;
    const attackerName = onlinePlayers.get(attackerId)?.username || 'Raqib';
    const seen = new Set();
    for (const t of terr) {
      const oid = String(t.ownerId);
      if (seen.has(oid)) continue;
      seen.add(oid);
      const online = onlinePlayers.get(oid);
      if (!online?.socketId) continue; // real-time faqat onlayn Ultra egaga
      if (entitlements(online.tier || 'free').notifications !== 'realtime') continue; // faqat Ultra
      const key = `${oid}:${attackerId}`;
      if (now - (proximityNotified.get(key) || 0) < PROXIMITY_TTL_MS) continue; // spam guard
      sweepProximityNotified(now);
      proximityNotified.set(key, now);
      io.to(online.socketId).emit('territory:proximity', { attackerUsername: attackerName });
    }
  } catch { /* proximity — best-effort, hot path'ni bloklamaydi */ }
}

// Anti-cheat log spam'ini yo'qotish: bir user+type uchun bitta "incident" qatori (count bilan).
// Chitchi har 2s'da teleport/spoof bersa ham DB'da bitta qator bo'ladi — soni (count) o'sib boradi.
// Yangi qator faqat voqealar orasida katta tanaffus (ANTICHEAT_NEW_ROW_GAP_MS) bo'lsa ochiladi.
const cheatAgg = new Map(); // `${userId}:${type}` -> { logId, count, lastAt, lastDbAt }

async function logCheat(userId, type, { reason = '', lat = null, lng = null, speed = null } = {}) {
  const key = `${userId}:${type}`;
  const now = Date.now();
  const agg = cheatAgg.get(key);

  // Yangi incident: yozuv yo'q yoki katta tanaffus → yangi qator yaratamiz
  if (!agg || now - agg.lastAt > constants.ANTICHEAT_NEW_ROW_GAP_MS) {
    const fresh = { logId: null, count: 1, lastAt: now, lastDbAt: now };
    cheatAgg.set(key, fresh); // sinxron set — ketma-ket voqealar ikkita qator yaratib yubormaydi
    try {
      const doc = await prisma.antiCheatLog.create({
        data: { userId, type, reason, lat, lng, speed, count: 1 }
      });
      fresh.logId = doc.id;
    } catch { /* ignore */ }
    return;
  }

  // Mavjud incident — count xotirada o'sadi, DB faqat vaqti-vaqti bilan yangilanadi (yozuvlarni kamaytiramiz)
  agg.count += 1;
  agg.lastAt = now;
  if (agg.logId && now - agg.lastDbAt >= constants.ANTICHEAT_FLUSH_MS) {
    agg.lastDbAt = now;
    prisma.antiCheatLog.update({
      where: { id: agg.logId },
      data: { count: agg.count, lat, lng }
    }).catch(() => {});
  }
}

// User uzilganda incident'ning yakuniy count'ini DB'ga yozamiz (oxirgi voqealar yo'qolmasin)
function flushCheat(userId) {
  const prefix = `${userId}:`;
  for (const [key, agg] of cheatAgg) {
    if (!key.startsWith(prefix)) continue;
    if (agg.logId) prisma.antiCheatLog.update({ where: { id: agg.logId }, data: { count: agg.count } }).catch(() => {});
    cheatAgg.delete(key);
  }
}

function handleLocation(io, socket, onlinePlayers) {
  const { userId } = socket;
  let lastUpdateTime = 0;
  let lastValidPoint = null;
  let lastPersistTime = 0; // shu ulanish uchun oxirgi DB-yozuv vaqti (throttle)

  socket.on('location:update', async (data) => {
    const now = Date.now();
    if (now - lastUpdateTime < constants.LOCATION_UPDATE_RATE_MS) return;
    lastUpdateTime = now;

    const { lat, lng } = data;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

    // ── GPS spoofing — SHADOW rejimi (faqat log qiladi, BLOKLAMAYDI) ──────────
    // Android'da expo-location `mocked: true` qaytaradi (mock-location ilovasi yoqilgan).
    // Hozircha faqat AntiCheatLog'ga yozamiz — real ma'lumot to'plangach, ishonch hosil
    // qilib, keyin bloklash qo'shiladi. Eski ilovalar `mocked` yubormaydi → undefined →
    // hech narsa loglanmaydi (to'liq orqaga moslik).
    if (data.mocked === true) {
      // type 'gps_spoof' — admin paneli (AntiCheat.jsx) buni allaqachon "GPS spoof" deb ko'rsatadi.
      // logCheat orqali — har 2s'da spam qator yaratmaydi, bitta incident count'i o'sadi.
      logCheat(userId, 'gps_spoof', { reason: 'shadow: mocked GPS (Android)', lat, lng });
    }

    const validation = validateLocationUpdate(userId, lat, lng, now);

    if (!validation.valid) {
      socket.emit('anticheat:warning', { reason: validation.reason });
      logCheat(userId, 'invalid', { reason: validation.reason, lat, lng });
      return;
    }

    // Tezlik outlier'i (yagona GPS spike) — bu nuqtani butunlay e'tiborsiz qoldiramiz:
    // trailga qo'shmaymiz, broadcast qilmaymiz, masofa qo'shmaymiz. Mavjud trail saqlanadi.
    // (anticheat:warning yubormaymiz — u client trailini reset qilib yuboradi.)
    if (validation.reject) return;

    if (validation.teleport) {
      logCheat(userId, 'teleport', { lat, lng });
    }

    const player = onlinePlayers.get(userId);
    if (player) { player.lat = lat; player.lng = lng; }

    const teamId = onlinePlayers.get(userId)?.teamId || null;
    if (teamId) {
      io.to(`team:${teamId}`).emit('player:moved', {
        userId, lat, lng, teamId,
        markerSkin: player?.markerSkin || null,
        trailSkin:  player?.trailSkin  || null,
        isPremium:  player?.isPremium  || false,
        tier:       player?.tier       || 'free',
      });
    }

    // Ultra yaqinlashuv ogohlantirishi — fire-and-forget (await yo'q, hot path tez qoladi)
    checkProximity(io, onlinePlayers, userId, lat, lng);
    // Admin komnataga ham yuboramiz — real-time monitoring uchun.
    // Faqat admin ulangan bo'lsa payload yasaymiz: aks holda har o'yinchining har
    // nuqtasi uchun bekorga obyekt yaratiladi (hot path — sekundiga ko'p marta).
    if (io.sockets.adapter.rooms.get('admin')?.size) {
      io.to('admin').emit('player:moved', {
        userId,
        lat,
        lng,
        username: player?.username,
        color: player?.color,
        level: player?.level,
      });
    }

    if (!userTrails.has(userId)) userTrails.set(userId, []);
    const trail = userTrails.get(userId);

    // relocate = mashina/transport tezligi (chit emas): trail uziladi (capture bo'lmasin),
    // lekin yuqorida LOG QILINMAYDI — faqat teleport (>50 m/s) va gps_spoof loglanadi.
    if (validation.teleport || validation.trailGap || validation.relocate) {
      trail.length = 0;
      lastValidPoint = null;
      // Server trail uzildi — jamoadagilarning kartasida ham bu a'zoning chizig'i tozalansin
      // (aks holda eski (uzilgan) jamoa chizig'i osilib qoladi).
      if (teamId) io.to(`team:${teamId}`).emit('team:trailReset', { userId });
    }

    // Masofa to'plash (teleport/relocate/sakrash bo'lmagan holatda)
    if (lastValidPoint && !validation.teleport && !validation.trailGap && !validation.relocate) {
      const d = haversineDistance(lastValidPoint[0], lastValidPoint[1], lat, lng);
      if (d > 0 && d < 50) { // 50m dan kichik bo'lsa haqiqiy qadam
        const prev = pendingDistance.get(userId) || 0;
        pendingDistance.set(userId, prev + d);
      }
    }
    lastValidPoint = [lat, lng];

    // Trail'ga nuqta qo'shamiz. (Avval har nuqtaga HMAC imzo qo'yilardi, lekin u hech qayerda
    // tekshirilmasdi — faqat hot path'da CPU sarflardi. Olib tashlandi.)
    trail.push([lat, lng]);

    if (trail.length > constants.MAX_TRAIL_POINTS) {
      // trail[0] (boshlanish nuqtasi) saqlanib qoladi — polygon yopilishi uchun kerak
      trail.splice(1, trail.length - constants.MAX_TRAIL_POINTS);
    }

    // Lokatsiya + to'plangan masofani DB'ga vaqt bo'yicha yozamiz (har N soniyada bir marta).
    // Avval har 3 nuqtada yozilardi (~6s) — endi LOCATION_PERSIST_INTERVAL_MS (15s).
    // Masofa pendingDistance'da to'planib turadi, shuning uchun kamroq yozsak ham yo'qolmaydi;
    // uzilish va SIGTERM'da qolgani baribir flush qilinadi.
    if (now - lastPersistTime >= constants.LOCATION_PERSIST_INTERVAL_MS) {
      lastPersistTime = now;
      const distToFlush = pendingDistance.get(userId) || 0;
      pendingDistance.set(userId, 0);

      const updateData = {
        lastLocation: { type: 'Point', coordinates: [lng, lat] },
        lastSeen: new Date(),
      };
      if (distToFlush > 0) {
        updateData.totalDistance = { increment: distToFlush };
      }

      prisma.user.update({
        where: { id: userId },
        data: updateData,
      }).catch((err) => logger.error('Failed to persist location', err));
    }
  });

  socket.on('trail:get', () => {
    socket.emit('trail:current', { trail: userTrails.get(userId) || [] });
  });

  socket.on('trail:reset', () => {
    userTrails.set(userId, []);
    socket.emit('trail:current', { trail: [] });
    // Jamoadagilarda ham bu a'zoning chizig'i tozalansin (web capture / qo'lda reset)
    const teamId = onlinePlayers.get(userId)?.teamId || null;
    if (teamId) io.to(`team:${teamId}`).emit('team:trailReset', { userId });
  });

  socket.on('disconnect', () => {
    // Reconnect race: yangi socket allaqachon faol bo'lsa, eski socketning kechikkan
    // disconnect'i faol trailni o'chirmasin (yarim aylanib yurgan user trailini yo'qotardi).
    const activeEntry = onlinePlayers.get(userId);
    const isStale = !!(activeEntry && activeEntry.socketId !== socket.id);

    if (!isStale) {
      userTrails.delete(userId);
      lastProximityAt.delete(userId);
    }
    flushCheat(userId);
    const distToFlush = pendingDistance.get(userId) || 0;
    pendingDistance.delete(userId);
    if (distToFlush > 0) {
      prisma.user.update({
        where: { id: userId },
        data: { totalDistance: { increment: distToFlush } }
      }).catch((err) => logger.error('Failed to flush distance on disconnect', err));
    }
  });
}

function getUserTrail(userId) {
  return userTrails.get(userId) || [];
}

// Capture muvaffaqiyatli bo'lgach server trailini tozalaydi — keyingi loop toza boshlanadi.
// REST capture (territoryController) ham, socket capture (territoryHandler) ham shu
// funksiyani chaqiradi — aks holda keyingi capture eski nuqtalarni qo'shib yuborardi.
function resetUserTrail(userId) {
  userTrails.set(userId, []);
}

// Graceful shutdown uchun: barcha yig'ilgan masofalarni DB ga yozadi
async function flushAllPendingDistances() {
  const entries = [...pendingDistance.entries()].filter(([, d]) => d > 0);
  if (entries.length === 0) return;
  await Promise.allSettled(
    entries.map(([userId, dist]) =>
      prisma.user.update({
        where: { id: userId },
        data: { totalDistance: { increment: dist } }
      }).catch((err) => logger.error('Failed to flush distance on shutdown', { userId, err })),
    ),
  );
  pendingDistance.clear();
}

module.exports = { handleLocation, getUserTrail, resetUserTrail, flushAllPendingDistances };
