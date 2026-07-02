// "Hamroh" (Walk Guardian) — yolg'iz yuruvchini ishonchli odam jonli kuzatadi.
// MAXFIYLIK QOIDASI: joylashuv FAQAT faol (accepted) sessiya davomida, FAQAT
// yuruvchi o'zi tanlagan do'stga uzatiladi. Sessiya tugashi bilan uzatish to'xtaydi.
//
// Hot-path (locationHandler) uchun in-memory registry: walkerId -> { sessionId, guardianId }.
// Server qayta ishga tushsa loadActive() bazadan tiklaydi (server.js'da chaqiriladi).
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const active = new Map(); // walkerId -> { sessionId, guardianId, lastSeenAt, lastLat, lastLng, lostNotified }

// Signal nazorati: shu muddat davomida yuruvchidan joylashuv kelmasa hamrohga
// ogohlantirish (push + socket) ketadi; signal qaytsa "qaytdi" xabari.
const SIGNAL_STALE_MS = 3 * 60 * 1000;

// Eskirgan sessiyalarni yopish chegaralari
const PENDING_TTL_MS = 30 * 60 * 1000;      // 30 daqiqada qabul qilinmasa — bekor
const ACTIVE_TTL_MS = 8 * 60 * 60 * 1000;   // 8 soatdan oshgan faol sessiya — avto-yakun

function register(walkerId, sessionId, guardianId) {
  active.set(String(walkerId), {
    sessionId, guardianId: String(guardianId),
    lastSeenAt: Date.now(), lastLat: null, lastLng: null, lostNotified: false,
  });
}

function unregister(walkerId) {
  active.delete(String(walkerId));
}

function getActiveFor(walkerId) {
  return active.get(String(walkerId)) || null;
}

// locationHandler hot-path'idan chaqiriladi — sinxron Map lookup, DB YO'Q.
// Hamroh o'z `user:{id}` room'ida (socket auth'da qo'shiladi) — alohida room kerak emas.
function forwardLocation(io, walkerId, lat, lng) {
  const s = active.get(String(walkerId));
  if (!s) return;
  s.lastSeenAt = Date.now();
  s.lastLat = lat; s.lastLng = lng;
  io.to(`user:${s.guardianId}`).emit('guardian:walkerMoved', {
    sessionId: s.sessionId, lat, lng, at: Date.now(),
  });
  // Signal ilgari "yo'qolgan" deb belgilangan bo'lsa — qaytganini xabar qilamiz
  if (s.lostNotified) {
    s.lostNotified = false;
    notifySignal(io, s, walkerId, 'back').catch(() => {});
  }
}

// Signal yo'qoldi/qaytdi xabari — socket (ilova ochiq bo'lsa) + push (yopiq bo'lsa ham yetadi).
// Kamdan-kam hodisa — DB so'rovi hot-path'ga tushmaydi.
async function notifySignal(io, s, walkerId, kind) {
  const { sendExpoPush } = require('./captureEffects');
  const [walker, guardian] = await Promise.all([
    prisma.user.findUnique({ where: { id: walkerId }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: s.guardianId }, select: { expoPushToken: true } }),
  ]);
  const name = walker?.username || 'Yuruvchi';
  if (kind === 'lost') {
    io.to(`user:${s.guardianId}`).emit('guardian:signalLost', {
      sessionId: s.sessionId, walkerUsername: name,
      lat: s.lastLat, lng: s.lastLng, lastSeenAt: s.lastSeenAt,
    });
    if (guardian?.expoPushToken) {
      const where = s.lastLat != null ? ` Oxirgi joyi: ${s.lastLat.toFixed(5)}, ${s.lastLng.toFixed(5)}` : '';
      await sendExpoPush(guardian.expoPushToken, '⚠️ GeoRush Hamroh',
        `${name}dan 3 daqiqadan beri signal yo'q (telefon o'chgan yoki aloqa uzilgan bo'lishi mumkin).${where}`);
    }
  } else {
    io.to(`user:${s.guardianId}`).emit('guardian:signalBack', {
      sessionId: s.sessionId, walkerUsername: name,
    });
    if (guardian?.expoPushToken) {
      await sendExpoPush(guardian.expoPushToken, '🛡 GeoRush Hamroh', `${name} bilan aloqa tiklandi — kuzatuv davom etmoqda`);
    }
  }
}

// Har 60 soniyada faol sessiyalarda signal uzilishini tekshiradi.
// server.js'da bir marta ishga tushiriladi.
function startSignalWatch(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [walkerId, s] of active) {
      if (!s.lostNotified && now - s.lastSeenAt > SIGNAL_STALE_MS) {
        s.lostNotified = true;
        notifySignal(io, s, walkerId, 'lost').catch(() => {});
      }
    }
  }, 60 * 1000).unref();
}

// Server ishga tushganda faol sessiyalarni tiklash (restart'da yo'qolmasin)
async function loadActive() {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id", "walkerId", "guardianId" FROM "GuardianSession" WHERE "status" = 'active'`
    );
    for (const r of rows) register(r.walkerId, r.id, r.guardianId);
    if (rows.length) logger.info(`Guardian: ${rows.length} faol sessiya tiklandi`);
  } catch (err) {
    logger.warn('Guardian loadActive skip:', err.message.split('\n')[0]);
  }
}

// Eskirganlarni davriy yopish — soatiga bir (best-effort, xato serverni yiqitmaydi)
function startSweeper() {
  setInterval(async () => {
    try {
      const now = Date.now();
      const pendingCut = new Date(now - PENDING_TTL_MS);
      const activeCut = new Date(now - ACTIVE_TTL_MS);
      await prisma.$executeRawUnsafe(
        `UPDATE "GuardianSession" SET "status"='ended', "endReason"='expired', "endedAt"=NOW()
         WHERE ("status"='pending' AND "createdAt" < $1) OR ("status"='active' AND "createdAt" < $2)`,
        pendingCut, activeCut
      );
      // In-memory'dan ham tozalash — DB'da yopilganlarni sinxronlash
      for (const [walkerId, s] of active) {
        const row = await prisma.$queryRawUnsafe(
          `SELECT "status" FROM "GuardianSession" WHERE "id" = $1`, s.sessionId
        );
        if (!row.length || row[0].status !== 'active') active.delete(walkerId);
      }
    } catch { /* sweeper — best-effort */ }
  }, 60 * 60 * 1000).unref();
}

module.exports = { register, unregister, getActiveFor, forwardLocation, loadActive, startSweeper, startSignalWatch };
