// "Hamroh" (Walk Guardian) — yolg'iz yuruvchini ishonchli odam jonli kuzatadi.
// MAXFIYLIK QOIDASI: joylashuv FAQAT faol (accepted) sessiya davomida, FAQAT
// yuruvchi o'zi tanlagan do'stga uzatiladi. Sessiya tugashi bilan uzatish to'xtaydi.
//
// Hot-path (locationHandler) uchun in-memory registry: walkerId -> { sessionId, guardianId }.
// Server qayta ishga tushsa loadActive() bazadan tiklaydi (server.js'da chaqiriladi).
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const active = new Map(); // walkerId -> { sessionId, guardianId }

// Eskirgan sessiyalarni yopish chegaralari
const PENDING_TTL_MS = 30 * 60 * 1000;      // 30 daqiqada qabul qilinmasa — bekor
const ACTIVE_TTL_MS = 8 * 60 * 60 * 1000;   // 8 soatdan oshgan faol sessiya — avto-yakun

function register(walkerId, sessionId, guardianId) {
  active.set(String(walkerId), { sessionId, guardianId: String(guardianId) });
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
  io.to(`user:${s.guardianId}`).emit('guardian:walkerMoved', {
    sessionId: s.sessionId, lat, lng, at: Date.now(),
  });
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

module.exports = { register, unregister, getActiveFor, forwardLocation, loadActive, startSweeper };
