const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

async function initializeDatabase() {
  try {
    await prisma.$connect();
    logger.info('PostgreSQL (Prisma) connected');
  } catch (err) {
    logger.error('PostgreSQL connection error:', err);
    process.exit(1);
  }
  // PostGIS kengaytmasini faollashtirish (geografik so'rovlar uchun).
  // Agar PostGIS hali o'rnatilmagan bo'lsa — serverni yiqitmaymiz, faqat ogohlantiramiz.
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis;');
    logger.info('PostGIS enabled');
  } catch (err) {
    logger.warn('PostGIS not available yet — geo features disabled until installed:', err.message);
  }

  // Indekslarni kafolatlash. Bularsiz har capture/xarita/proximity so'rovi butun
  // jadvalni skanerlaydi (full scan) — ko'p foydalanuvchida baza tiqilib qoladi.
  // Hammasi IF NOT EXISTS — birinchi safar yaratiladi, keyin instant no-op.
  // So'rov MATNI o'zgarmaydi — Postgres planneri shu indekslardan avtomatik foydalanadi.
  await ensureIndexes();
}

// Idempotent indeks yaratish. Har bittasi alohida try/catch — biri ishlamasa
// (masalan PostGIS hali yo'q), qolganlari baribir yaratiladi, server yiqilmaydi.
async function ensureIndexes() {
  // Spatial GiST — eng muhimi. So'rovlardagi AYNAN shu ifoda: ST_GeomFromGeoJSON(polygon::text).
  // Funktsional indeks query ifodasiga mos kelgani uchun ST_Intersects(...) tezlashadi.
  const statements = [
    `CREATE INDEX IF NOT EXISTS idx_territory_geom
       ON "Territory" USING GIST (ST_GeomFromGeoJSON(polygon::text))`,
    // B-tree indekslar — eng ko'p ishlatiladigan WHERE/ORDER BY ustunlari
    `CREATE INDEX IF NOT EXISTS idx_territory_owner    ON "Territory" ("ownerId")`,
    `CREATE INDEX IF NOT EXISTS idx_territory_team     ON "Territory" ("teamId")`,
    `CREATE INDEX IF NOT EXISTS idx_territory_captured ON "Territory" ("capturedAt")`,
    `CREATE INDEX IF NOT EXISTS idx_user_xp            ON "User" ("xp" DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_user_online        ON "User" ("isOnline")`,
    `CREATE INDEX IF NOT EXISTS idx_user_lastseen      ON "User" ("lastSeen")`,
    `CREATE INDEX IF NOT EXISTS idx_user_created       ON "User" ("createdAt")`,
    `CREATE INDEX IF NOT EXISTS idx_user_team          ON "User" ("teamId")`,
    `CREATE INDEX IF NOT EXISTS idx_event_actor        ON "GameEvent" ("actorId")`,
    `CREATE INDEX IF NOT EXISTS idx_event_type_created ON "GameEvent" ("type", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS idx_event_territory    ON "GameEvent" ("territoryId")`,
    `CREATE INDEX IF NOT EXISTS idx_anticheat_user     ON "AntiCheatLog" ("userId", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS idx_anticheat_created  ON "AntiCheatLog" ("createdAt")`,
    `CREATE INDEX IF NOT EXISTS idx_teamreq_user       ON "TeamRequest" ("userId")`,
    `CREATE INDEX IF NOT EXISTS idx_otp_phone          ON "OTPSession" ("phone")`,
    `CREATE INDEX IF NOT EXISTS idx_otp_expires        ON "OTPSession" ("expiresAt")`,
  ];

  let ok = 0;
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
      ok++;
    } catch (err) {
      logger.warn('Index skip:', err.message.split('\n')[0]);
    }
  }
  logger.info(`DB indexes ensured (${ok}/${statements.length})`);
}

module.exports = { initializeDatabase, prisma };
