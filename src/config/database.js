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

  // Asosiy jadvallarni kafolatlash. Deploy `prisma db push` ni ishlatmaydi
  // (u 16 ta qo'lda yaratilgan indeksni o'chirib yuboradi), shuning uchun
  // schema'ga qo'shilgan yangi jadvallar bazaga avtomatik tushmaydi.
  // Bu yerda IF NOT EXISTS bilan idempotent yaratamiz — login/register
  // RefreshToken jadvaliga bog'liq, jadval yo'qligida 500 beradi.
  await ensureCoreTables();

  // Indekslarni kafolatlash. Bularsiz har capture/xarita/proximity so'rovi butun
  // jadvalni skanerlaydi (full scan) — ko'p foydalanuvchida baza tiqilib qoladi.
  // Hammasi IF NOT EXISTS — birinchi safar yaratiladi, keyin instant no-op.
  // So'rov MATNI o'zgarmaydi — Postgres planneri shu indekslardan avtomatik foydalanadi.
  await ensureIndexes();
}

// Idempotent jadval yaratish. Prisma schema'dagi modellar default mapping bilan
// (model nomi = jadval nomi, field nomi = ustun nomi) yaratiladi. Faqat deploy
// vaqtida migratsiya bo'lmagani uchun yetishmay qolgan jadvallar shu yerda.
async function ensureCoreTables() {
  const statements = [
    // RefreshToken — schema'da bor, lekin prod bazada yo'q edi (login/register 500).
    `CREATE TABLE IF NOT EXISTS "RefreshToken" (
       "id"        TEXT NOT NULL,
       "token"     TEXT NOT NULL,
       "userId"    TEXT NOT NULL,
       "expiresAt" TIMESTAMP(3) NOT NULL,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_token_key" ON "RefreshToken" ("token")`,
    `CREATE INDEX IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken" ("userId")`,
    // FK + ON DELETE CASCADE — Prisma onDelete: Cascade'ga mos. Postgres'da
    // constraint uchun IF NOT EXISTS yo'q, shuning uchun pg_constraint orqali tekshiramiz.
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RefreshToken_userId_fkey') THEN
         ALTER TABLE "RefreshToken"
           ADD CONSTRAINT "RefreshToken_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // Friendship — do'stlik so'rovlari/aloqalari (schema.prisma'dagi Friendship modeli).
    // "updatedAt"ga DEFAULT beramiz: Prisma client o'zi to'ldiradi, lekin qo'lda
    // INSERT (masalan SQL konsolda) ham yiqilmasin.
    `CREATE TABLE IF NOT EXISTS "Friendship" (
       "id"          TEXT NOT NULL,
       "requesterId" TEXT NOT NULL,
       "addresseeId" TEXT NOT NULL,
       "status"      TEXT NOT NULL DEFAULT 'pending',
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Friendship_requesterId_addresseeId_key" ON "Friendship" ("requesterId", "addresseeId")`,
    `CREATE INDEX IF NOT EXISTS "Friendship_addresseeId_status_idx" ON "Friendship" ("addresseeId", "status")`,
    `CREATE INDEX IF NOT EXISTS "Friendship_requesterId_status_idx" ON "Friendship" ("requesterId", "status")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Friendship_requesterId_fkey') THEN
         ALTER TABLE "Friendship"
           ADD CONSTRAINT "Friendship_requesterId_fkey"
           FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Friendship_addresseeId_fkey') THEN
         ALTER TABLE "Friendship"
           ADD CONSTRAINT "Friendship_addresseeId_fkey"
           FOREIGN KEY ("addresseeId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // Referral — taklif (schema.prisma'dagi Referral modeli). refereeId UNIQUE:
    // bir foydalanuvchi faqat bir marta taklif qilinadi.
    `CREATE TABLE IF NOT EXISTS "Referral" (
       "id"         TEXT NOT NULL,
       "referrerId" TEXT NOT NULL,
       "refereeId"  TEXT NOT NULL,
       "status"     TEXT NOT NULL DEFAULT 'pending',
       "rewardedAt" TIMESTAMP(3),
       "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Referral_refereeId_key" ON "Referral" ("refereeId")`,
    `CREATE INDEX IF NOT EXISTS "Referral_referrerId_status_idx" ON "Referral" ("referrerId", "status")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referrerId_fkey') THEN
         ALTER TABLE "Referral"
           ADD CONSTRAINT "Referral_referrerId_fkey"
           FOREIGN KEY ("referrerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_refereeId_fkey') THEN
         ALTER TABLE "Referral"
           ADD CONSTRAINT "Referral_refereeId_fkey"
           FOREIGN KEY ("refereeId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // PremiumPurchase — har bir HAQIQIY premium xaridi (chegirmadan keyingi summa).
    // Admin daromad statistikasi taxminiy emas, shu jadvaldan hisoblanadi.
    `CREATE TABLE IF NOT EXISTS "PremiumPurchase" (
       "id"          TEXT NOT NULL,
       "userId"      TEXT NOT NULL,
       "tier"        TEXT NOT NULL,
       "period"      TEXT NOT NULL,
       "method"      TEXT NOT NULL,
       "amountSom"   INTEGER NOT NULL DEFAULT 0,
       "amountStars" INTEGER NOT NULL DEFAULT 0,
       "baseSom"     INTEGER NOT NULL DEFAULT 0,
       "discountPct" INTEGER NOT NULL DEFAULT 0,
       "promoCode"   TEXT,
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "PremiumPurchase_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "PremiumPurchase_createdAt_idx" ON "PremiumPurchase" ("createdAt")`,
    `CREATE INDEX IF NOT EXISTS "PremiumPurchase_userId_idx" ON "PremiumPurchase" ("userId")`,
  ];

  let ok = 0;
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
      ok++;
    } catch (err) {
      logger.warn('Table ensure skip:', err.message.split('\n')[0]);
    }
  }
  logger.info(`DB core tables ensured (${ok}/${statements.length})`);
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
