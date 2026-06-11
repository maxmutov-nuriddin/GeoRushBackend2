-- 001_create_refresh_token.sql
--
-- Muammo: schema.prisma'ga RefreshToken modeli qo'shilgan (commit 30142a7),
-- lekin prod bazaga migratsiya tushmagan (deploy `prisma db push` ishlatmaydi,
-- chunki u 16 ta qo'lda yaratilgan indeksni o'chiradi). Natijada login/register
-- createRefreshToken() bosqichida 500 "Internal server error" beradi.
--
-- Bu skript jadvalni qo'lda, idempotent (IF NOT EXISTS) yaratadi.
-- Render/Supabase DB konsolida yoki psql orqali bir marta ishga tushiring:
--   psql "$DATABASE_URL" -f migrations_manual/001_create_refresh_token.sql
--
-- Eslatma: src/config/database.js > ensureCoreTables() ham aynan shuni
-- har startda idempotent bajaradi, ya'ni keyingi deploy'da avtomatik tushadi.

CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"        TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_token_key"  ON "RefreshToken" ("token");
CREATE INDEX        IF NOT EXISTS "RefreshToken_userId_idx" ON "RefreshToken" ("userId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RefreshToken_userId_fkey') THEN
    ALTER TABLE "RefreshToken"
      ADD CONSTRAINT "RefreshToken_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
