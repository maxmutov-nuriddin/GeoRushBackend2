-- 099_monetization_expansion.sql
--
-- Monetizatsiya kengaytmasi: consumable buyumlar (shield / revive / XP boost / stealth),
-- Starter Pack belgisi va B2B "Sponsored Zone" (kafe/do'kon aksiyalari).
-- Deploy `prisma db push`/`migrate` ishlatmaydi (qo'lda yaratilgan indekslarni
-- o'chirib yuborardi), shuning uchun hammasi idempotent SQL.
--
-- ESLATMA: src/config/database.js > ensureCoreTables() AYNAN shu buyruqlarni har
-- server startida idempotent bajaradi — ya'ni deploy'da avtomatik tushadi.
-- Bu fayl hujjat + kerak bo'lsa qo'lda ishga tushirish uchun:
--   psql "$DATABASE_URL" -f migrations_manual/099_monetization_expansion.sql
--
-- Vaqt ustunlari TIMESTAMP(3) — loyihadagi qolgan DateTime ustunlar bilan bir xil
-- (Prisma DateTime default mapping'i, UTC yoziladi). TIMESTAMPTZ aralashtirilmaydi:
-- loyihaning qolgan raw SQL'i (NOW(), Date parametrlari) DB sessiyasi UTC deb ishlaydi.
--
-- MUHIM: User/Territory'ga qo'shilgan har ustun schema.prisma'da ham bor. Prisma
-- client SELECT'da hamma scalar ustunni so'raydi — shu sabab bu ALTER'lar server
-- query qabul qilishidan OLDIN (initializeDatabase → ensureCoreTables) bajariladi.

-- ── User: consumable holatlari ───────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "xpBoostUntil"      TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "stealthUntil"      TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "starterPackBought" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "reviveTokens"      INTEGER NOT NULL DEFAULT 0;
-- Starter Pack beradigan shield — o'yinchi keyin o'zi tanlagan hududga qo'yadi.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "shieldTokens"      INTEGER NOT NULL DEFAULT 0;

-- ── Territory: 24 soatlik coin-shield ────────────────────────────────────────
-- Tier shieldMargin (level farqi) dan ALOHIDA — vaqt bo'yicha to'liq himoya.
ALTER TABLE "Territory" ADD COLUMN IF NOT EXISTS "shieldUntil" TIMESTAMP(3);

-- ── SponsoredZone: B2B aksiya zonasi ─────────────────────────────────────────
-- geom — haqiqiy PostGIS ustun (Territory'dagi Json polygon'dan farqli): zonani admin
-- yaratadi (nuqta + radius → ST_Buffer), mijoz uni o'zgartirmaydi.
-- maxClaims NULL = cheksiz.
CREATE TABLE IF NOT EXISTS "SponsoredZone" (
  "id"           TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "title"        TEXT NOT NULL,
  "description"  TEXT,
  "logoUrl"      TEXT,
  "promoCode"    TEXT,
  "rewardCoins"  INTEGER NOT NULL DEFAULT 100,
  "rewardXp"     INTEGER NOT NULL DEFAULT 200,
  "maxClaims"    INTEGER,
  "claimedCount" INTEGER NOT NULL DEFAULT 0,
  "activeFrom"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activeUntil"  TIMESTAMP(3) NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "geom"         geometry(Polygon, 4326) NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SponsoredZone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS idx_sponsored_zone_geom   ON "SponsoredZone" USING GIST ("geom");
CREATE INDEX IF NOT EXISTS "SponsoredZone_active_idx" ON "SponsoredZone" ("isActive", "activeUntil");

-- ── SponsoredClaim: kim qaysi aksiyani olgan ─────────────────────────────────
-- UNIQUE(userId, zoneId) — bitta o'yinchi bitta aksiyani faqat 1 marta oladi
-- (parallel capture race'da ham: ikkinchi INSERT unique violation bilan yiqiladi).
CREATE TABLE IF NOT EXISTS "SponsoredClaim" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "zoneId"         TEXT NOT NULL,
  "promoCodeGiven" TEXT,
  "claimedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SponsoredClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SponsoredClaim_userId_zoneId_key" ON "SponsoredClaim" ("userId", "zoneId");
CREATE INDEX        IF NOT EXISTS "SponsoredClaim_zoneId_idx"        ON "SponsoredClaim" ("zoneId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SponsoredClaim_userId_fkey') THEN
    ALTER TABLE "SponsoredClaim"
      ADD CONSTRAINT "SponsoredClaim_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SponsoredClaim_zoneId_fkey') THEN
    ALTER TABLE "SponsoredClaim"
      ADD CONSTRAINT "SponsoredClaim_zoneId_fkey"
      FOREIGN KEY ("zoneId") REFERENCES "SponsoredZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── PaymentOrder: Click / Payme orqali so'mda to'lanadigan tanga paketlari ──────
-- Bir buyurtma = bir to'lov urinishi. status: 'pending' → 'paid' | 'cancelled'.
-- "num" — Click merchant_prepare_id/merchant_confirm_id uchun butun son (UUID emas).
-- providerTxId UNIQUE — Payme transaction id / Click click_trans_id (takroriy callback guard'i).
-- payme* ustunlar — Payme Merchant API holat mashinasi (state 1/2/-1/-2, vaqtlar ms).
CREATE TABLE IF NOT EXISTS "PaymentOrder" (
  "id"               TEXT NOT NULL,
  "num"              SERIAL,
  "userId"           TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "productId"        TEXT NOT NULL,
  "amountSom"        INTEGER NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  "providerTxId"     TEXT,
  "paymeState"       INTEGER,
  "paymeTime"        BIGINT,
  "paymeCreateTime"  BIGINT,
  "paymePerformTime" BIGINT,
  "paymeCancelTime"  BIGINT,
  "cancelReason"     INTEGER,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt"           TIMESTAMP(3),
  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentOrder_num_key"          ON "PaymentOrder" ("num");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentOrder_providerTxId_key" ON "PaymentOrder" ("providerTxId");
CREATE INDEX        IF NOT EXISTS "PaymentOrder_user_idx"         ON "PaymentOrder" ("userId", "createdAt");
CREATE INDEX        IF NOT EXISTS "PaymentOrder_paymeCreate_idx"  ON "PaymentOrder" ("paymeCreateTime");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentOrder_userId_fkey') THEN
    ALTER TABLE "PaymentOrder"
      ADD CONSTRAINT "PaymentOrder_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- PayGate (karta → karta, Telegram karta-bot tasdig'i): mijoz aynan shu summani shu kartaga o'tkazadi.
ALTER TABLE "PaymentOrder" ADD COLUMN IF NOT EXISTS "payAmount"    INTEGER;
ALTER TABLE "PaymentOrder" ADD COLUMN IF NOT EXISTS "payCard"      TEXT;
ALTER TABLE "PaymentOrder" ADD COLUMN IF NOT EXISTS "payExpiresAt" TIMESTAMP(3);
