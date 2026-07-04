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
    // chargeId — to'lov provayderining yagona tranzaksiya ID'si (Telegram: telegram_payment_charge_id).
    // Takroriy webhook/payment kelsa ikki marta premium berilmasligi uchun idempotency kaliti.
    // NULL ruxsat etiladi (eski yozuvlar, admin sovg'a, RevenueCat) — UNIQUE index NULL'larni distinct hisoblaydi.
    `ALTER TABLE "PremiumPurchase" ADD COLUMN IF NOT EXISTS "chargeId" TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PremiumPurchase_chargeId_key" ON "PremiumPurchase" ("chargeId")`,

    // SystemFlag — bir martalik vazifalar (masalan hudud birlashtirish backfill) belgisi.
    `CREATE TABLE IF NOT EXISTS "SystemFlag" (
       "key"       TEXT NOT NULL,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "SystemFlag_pkey" PRIMARY KEY ("key")
     )`,

    // PromoCode — tarif/davr cheklovi (mavjud jadvalga ustun qo'shamiz, idempotent).
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "appliesTier" TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "appliesPeriod" TEXT NOT NULL DEFAULT 'all'`,

    // User — sessiya vaqti hisobi (connect→disconnect davomiyligi yig'iladi, idempotent).
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalPlaytimeSec" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionCount" INTEGER NOT NULL DEFAULT 0`,
    // User — access-token versiyasi (parol tiklash/logout-all'da eski tokenlarni bekor qilish).
    // Mavjud yozuvlar 0 oladi; JWT'dagi `tv` claim shu bilan solishtiriladi.
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0`,
    // User — hudud kengaytirish hisobi + coin bilan olingan qo'shimchalar (idempotent, mavjudlar 0 oladi).
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "expansionsUsed" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "purchasedSlots" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "purchasedExpansions" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "purchasedTeamCreate" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingResetAt" TIMESTAMP(3)`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingCoins" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingTier" TEXT`,
    // Nik bezagi (shop type:'nick') — reyting/profildagi ism uslubi
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activeSkinNick" TEXT`,

    // ── Support chat (Telegram support-bot + admin panel) ──────────────────────
    // prisma db push ISHLATILMAYDI — jadvallar shu yerda raw SQL bilan yaratiladi.
    `CREATE TABLE IF NOT EXISTS "SupportChat" (
       "id"            TEXT NOT NULL,
       "tgChatId"      TEXT NOT NULL,
       "tgName"        TEXT,
       "tgUsername"    TEXT,
       "status"        TEXT NOT NULL DEFAULT 'open',
       "unreadCount"   INTEGER NOT NULL DEFAULT 0,
       "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "SupportChat_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "SupportChat_tgChatId_key" ON "SupportChat" ("tgChatId")`,
    `CREATE INDEX IF NOT EXISTS "SupportChat_lastMessageAt_idx" ON "SupportChat" ("lastMessageAt")`,
    `CREATE TABLE IF NOT EXISTS "SupportMessage" (
       "id"        TEXT NOT NULL,
       "chatId"    TEXT NOT NULL,
       "sender"    TEXT NOT NULL,
       "text"      TEXT NOT NULL,
       "messageId" TEXT,
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "SupportMessage_chatId_createdAt_idx" ON "SupportMessage" ("chatId", "createdAt")`,
    // FK + cascade (chat o'chsa xabarlar ham o'chadi) — idempotent (DO bloki).
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupportMessage_chatId_fkey') THEN
         ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_chatId_fkey"
           FOREIGN KEY ("chatId") REFERENCES "SupportChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // ── DailyStat — kunlik sessiya agregati (dashboard "Bugungi faollik" kartalari) ──
    // Har socket disconnect (oqilona sessiya)da bugungi qator increment qilinadi:
    //   playtimeSec  — bugun ilovada o'tkazilgan jami soniya
    //   sessionCount — bugungi UMUMIY kirib-chiqishlar (UNIK EMAS — har sessiya sanaladi)
    // Kunlik UNIK kirganlar (DAU) alohida — User.lastSeen >= bugun bo'yicha hisoblanadi.
    // ── GuardianSession — "Hamroh" (yolg'iz yuruvchini ishonchli do'st jonli kuzatishi) ──
    // Joylashuv bu jadvalda SAQLANMAYDI — faqat sessiya holati. Uzatish socket orqali jonli.
    `CREATE TABLE IF NOT EXISTS "GuardianSession" (
       "id"         TEXT NOT NULL,
       "walkerId"   TEXT NOT NULL,
       "guardianId" TEXT NOT NULL,
       "status"     TEXT NOT NULL DEFAULT 'pending',
       "endReason"  TEXT,
       "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "endedAt"    TIMESTAMP(3),
       CONSTRAINT "GuardianSession_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "GuardianSession_walker_idx"   ON "GuardianSession" ("walkerId", "status")`,
    `CREATE INDEX IF NOT EXISTS "GuardianSession_guardian_idx" ON "GuardianSession" ("guardianId", "status")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GuardianSession_walkerId_fkey') THEN
         ALTER TABLE "GuardianSession" ADD CONSTRAINT "GuardianSession_walkerId_fkey"
           FOREIGN KEY ("walkerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GuardianSession_guardianId_fkey') THEN
         ALTER TABLE "GuardianSession" ADD CONSTRAINT "GuardianSession_guardianId_fkey"
           FOREIGN KEY ("guardianId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    `CREATE TABLE IF NOT EXISTS "DailyStat" (
       "date"         TEXT NOT NULL,
       "playtimeSec"  BIGINT  NOT NULL DEFAULT 0,
       "sessionCount" INTEGER NOT NULL DEFAULT 0,
       "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("date")
     )`,

    // ── TrafficCell — piyoda trafik anonim agregati (trafficService.js) ────────
    // Katak ~110m (lat/lng 3 kasr) × hafta kuni × soat. userId YO'Q — to'liq anonim,
    // faqat "shu nuqtadan shu vaqtda N kishi o'tdi" hisobi. B2B/B2G hisobot manbasi.
    `CREATE TABLE IF NOT EXISTS "TrafficCell" (
       "cellLat"   DOUBLE PRECISION NOT NULL,
       "cellLng"   DOUBLE PRECISION NOT NULL,
       "dow"       SMALLINT NOT NULL,
       "hour"      SMALLINT NOT NULL,
       "count"     INTEGER NOT NULL DEFAULT 0,
       "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "TrafficCell_pkey" PRIMARY KEY ("cellLat", "cellLng", "dow", "hour")
     )`,
    `CREATE INDEX IF NOT EXISTS "TrafficCell_count_idx" ON "TrafficCell" ("count" DESC)`,
    // Katak markazini eng yaqin PIYODA YO'LIGA yopishtirish (OSRM nearest, flush'da lazy).
    // Xaritada kataklar uylar ustida emas, yo'l bo'ylab ko'rinishi uchun.
    `ALTER TABLE "TrafficCell" ADD COLUMN IF NOT EXISTS "snapLat" DOUBLE PRECISION`,
    `ALTER TABLE "TrafficCell" ADD COLUMN IF NOT EXISTS "snapLng" DOUBLE PRECISION`,

    // ── TrafficDaily — kunlik REAL yuruvchilar SONI (userId YO'Q, faqat raqam) ──
    `CREATE TABLE IF NOT EXISTS "TrafficDaily" (
       "date"      TEXT NOT NULL,
       "walkers"   INTEGER NOT NULL DEFAULT 0,
       "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "TrafficDaily_pkey" PRIMARY KEY ("date")
     )`,

    // ── "Oila Doirasi" (Family Circle) — doimiy oilaviy xavfsizlik ─────────────
    // Xom GPS SAQLANMAYDI: faqat nomlangan zonalarga kirish/chiqish voqealari.
    // FamilyCircle — doimiy guruh (Team'ga o'xshash, oila uchun; inviteCode bilan qo'shiladi).
    `CREATE TABLE IF NOT EXISTS "FamilyCircle" (
       "id"         TEXT NOT NULL,
       "name"       TEXT NOT NULL,
       "ownerId"    TEXT NOT NULL,
       "inviteCode" TEXT NOT NULL,
       "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FamilyCircle_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "FamilyCircle_inviteCode_key" ON "FamilyCircle" ("inviteCode")`,
    `CREATE INDEX IF NOT EXISTS "FamilyCircle_owner_idx" ON "FamilyCircle" ("ownerId")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyCircle_ownerId_fkey') THEN
         ALTER TABLE "FamilyCircle" ADD CONSTRAINT "FamilyCircle_ownerId_fkey"
           FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // FamilyCircleMember — a'zolik + rol ("parent" zona boshqaradi, "child" faqat ko'radi).
    `CREATE TABLE IF NOT EXISTS "FamilyCircleMember" (
       "id"        TEXT NOT NULL,
       "circleId"  TEXT NOT NULL,
       "userId"    TEXT NOT NULL,
       "role"      TEXT NOT NULL DEFAULT 'child',
       "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FamilyCircleMember_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "FamilyCircleMember_circle_user_key" ON "FamilyCircleMember" ("circleId", "userId")`,
    `CREATE INDEX IF NOT EXISTS "FamilyCircleMember_user_idx" ON "FamilyCircleMember" ("userId")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyCircleMember_circleId_fkey') THEN
         ALTER TABLE "FamilyCircleMember" ADD CONSTRAINT "FamilyCircleMember_circleId_fkey"
           FOREIGN KEY ("circleId") REFERENCES "FamilyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyCircleMember_userId_fkey') THEN
         ALTER TABLE "FamilyCircleMember" ADD CONSTRAINT "FamilyCircleMember_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // FamilyZone — xaritada nuqta + radius + nom ("Uy", "Maktab"...).
    `CREATE TABLE IF NOT EXISTS "FamilyZone" (
       "id"          TEXT NOT NULL,
       "circleId"    TEXT NOT NULL,
       "label"       TEXT NOT NULL,
       "lat"         DOUBLE PRECISION NOT NULL,
       "lng"         DOUBLE PRECISION NOT NULL,
       "radiusM"     INTEGER NOT NULL DEFAULT 120,
       "createdById" TEXT NOT NULL,
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FamilyZone_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "FamilyZone_circle_idx" ON "FamilyZone" ("circleId")`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyZone_circleId_fkey') THEN
         ALTER TABLE "FamilyZone" ADD CONSTRAINT "FamilyZone_circleId_fkey"
           FOREIGN KEY ("circleId") REFERENCES "FamilyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // FamilyZoneEvent — kirish/chiqish tarixi. zoneLabel snapshot (zona o'chsa tarix qoladi).
    `CREATE TABLE IF NOT EXISTS "FamilyZoneEvent" (
       "id"        TEXT NOT NULL,
       "circleId"  TEXT NOT NULL,
       "zoneId"    TEXT NOT NULL,
       "userId"    TEXT NOT NULL,
       "zoneLabel" TEXT NOT NULL,
       "kind"      TEXT NOT NULL,
       "at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "FamilyZoneEvent_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "FamilyZoneEvent_circle_at_idx" ON "FamilyZoneEvent" ("circleId", "at" DESC)`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FamilyZoneEvent_circleId_fkey') THEN
         ALTER TABLE "FamilyZoneEvent" ADD CONSTRAINT "FamilyZoneEvent_circleId_fkey"
           FOREIGN KEY ("circleId") REFERENCES "FamilyCircle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,

    // ── SafeArrival — "Xavfsiz yo'l" navigatsiyasi tugaganda: manzilga yetib keldimi.
    // Xavfsizlik analitikasi (nechta xavfsiz yetib borish). Xom GPS SAQLANMAYDI.
    `CREATE TABLE IF NOT EXISTS "SafeArrival" (
       "id"          TEXT NOT NULL,
       "userId"      TEXT NOT NULL,
       "arrived"     BOOLEAN NOT NULL DEFAULT true,
       "distanceM"   INTEGER NOT NULL DEFAULT 0,
       "durationMin" INTEGER NOT NULL DEFAULT 0,
       "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "SafeArrival_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE INDEX IF NOT EXISTS "SafeArrival_user_idx" ON "SafeArrival" ("userId", "createdAt" DESC)`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SafeArrival_userId_fkey') THEN
         ALTER TABLE "SafeArrival" ADD CONSTRAINT "SafeArrival_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
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
