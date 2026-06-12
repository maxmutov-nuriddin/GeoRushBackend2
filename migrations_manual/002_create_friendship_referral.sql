-- 002_create_friendship_referral.sql
--
-- Friends + Referral feature jadvallari (schema.prisma: Friendship, Referral).
-- Deploy `prisma db push`/`migrate` ishlatmaydi (16 ta qo'lda yaratilgan indeksni
-- o'chirib yuborardi), shuning uchun jadvallar idempotent SQL bilan yaratiladi.
--
-- ESLATMA: src/config/database.js > ensureCoreTables() AYNAN shu skriptni har
-- server startida idempotent bajaradi — ya'ni deploy'da avtomatik tushadi.
-- Bu fayl hujjat + kerak bo'lsa qo'lda ishga tushirish uchun:
--   psql "$DATABASE_URL" -f migrations_manual/002_create_friendship_referral.sql
--
-- MUHIM: User jadvaliga USTUN QO'SHILMAYDI (login/register buzilmasligi uchun) —
-- faqat yangi jadvallar.

-- ── Friendship: do'stlik so'rovlari/aloqalari ────────────────────────────────
-- Bitta juftlik = bitta qator; status 'pending' → 'accepted'.
CREATE TABLE IF NOT EXISTS "Friendship" (
  "id"          TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'pending',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Friendship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Friendship_requesterId_addresseeId_key" ON "Friendship" ("requesterId", "addresseeId");
CREATE INDEX        IF NOT EXISTS "Friendship_addresseeId_status_idx"      ON "Friendship" ("addresseeId", "status");
CREATE INDEX        IF NOT EXISTS "Friendship_requesterId_status_idx"      ON "Friendship" ("requesterId", "status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Friendship_requesterId_fkey') THEN
    ALTER TABLE "Friendship"
      ADD CONSTRAINT "Friendship_requesterId_fkey"
      FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Friendship_addresseeId_fkey') THEN
    ALTER TABLE "Friendship"
      ADD CONSTRAINT "Friendship_addresseeId_fkey"
      FOREIGN KEY ("addresseeId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── Referral: taklif kuzatuvi ────────────────────────────────────────────────
-- refereeId UNIQUE — bir foydalanuvchi faqat bir marta taklif qilinadi.
-- status 'pending' → referee birinchi hudud egallaganda 'completed'.
CREATE TABLE IF NOT EXISTS "Referral" (
  "id"         TEXT NOT NULL,
  "referrerId" TEXT NOT NULL,
  "refereeId"  TEXT NOT NULL,
  "status"     TEXT NOT NULL DEFAULT 'pending',
  "rewardedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Referral_refereeId_key"           ON "Referral" ("refereeId");
CREATE INDEX        IF NOT EXISTS "Referral_referrerId_status_idx"   ON "Referral" ("referrerId", "status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referrerId_fkey') THEN
    ALTER TABLE "Referral"
      ADD CONSTRAINT "Referral_referrerId_fkey"
      FOREIGN KEY ("referrerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_refereeId_fkey') THEN
    ALTER TABLE "Referral"
      ADD CONSTRAINT "Referral_refereeId_fkey"
      FOREIGN KEY ("refereeId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
