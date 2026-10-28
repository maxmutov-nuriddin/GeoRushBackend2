// B2B "Sponsored Zone" — kafe/do'kon aksiya zonalari.
// Yangi egallangan hudud aktiv zonaga tegsa, o'yinchi bir martalik mukofot (coin + XP)
// va brend promo-kodini oladi.
//
// FAQAT capture muvaffaqiyatli saqlangandan KEYIN chaqiriladi (captureEffects), har zona
// alohida tranzaksiyada. Hech bir xato capture natijasiga ta'sir qilmaydi — chaqiruvchi
// try/catch bilan o'raydi, bu yerda ham har zona o'z try/catch'ida.
const { randomUUID } = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const MAX_ZONES_PER_CAPTURE = 5; // bitta capture'da eng ko'pi shuncha aksiya (spam/abuse himoyasi)

// Vaqt ustunlari TIMESTAMP(3) va UTC'da (Prisma kabi). JS Date'ni raw SQL'ga to'g'ridan-to'g'ri
// berilsa Postgres uni SESSIYA timezone'i bo'yicha aylantiradi (masalan Asia/Tashkent → +5 soat).
// Shuning uchun har vaqt ISO matn sifatida beriladi va aniq UTC'ga o'tkaziladi.
const utc = (d) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

// Aktiv, limiti to'lmagan, o'yinchi hali olmagan va yangi hududga tegadigan zonalar.
async function findEligibleZones(userId, polygonGeoJSONStr, now) {
  return prisma.$queryRaw`
    SELECT z.id, z."businessName", z.title, z.description, z."logoUrl", z."promoCode",
           z."rewardCoins", z."rewardXp"
    FROM "SponsoredZone" z
    WHERE z."isActive" = true
      AND z."activeFrom" <= ${utc(now)}
      AND z."activeUntil" > ${utc(now)}
      AND (z."maxClaims" IS NULL OR z."claimedCount" < z."maxClaims")
      AND ST_Intersects(z.geom, ST_SetSRID(ST_GeomFromGeoJSON(${polygonGeoJSONStr}), 4326))
      AND NOT EXISTS (
        SELECT 1 FROM "SponsoredClaim" c WHERE c."zoneId" = z.id AND c."userId" = ${userId}
      )
    ORDER BY z."activeUntil" ASC
    LIMIT ${MAX_ZONES_PER_CAPTURE}
  `;
}

// Bitta zona uchun atomik claim. Limit (maxClaims) shu UPDATE'da tekshiriladi — parallel
// o'yinchilar limitdan oshirib yubora olmaydi; UNIQUE(userId, zoneId) qayta olishni to'sadi.
// null qaytaradi — zona shu orada to'lib qolgan yoki o'yinchi allaqachon olgan.
async function claimZone(userId, zone, calculateLevel) {
  return prisma.$transaction(async (tx) => {
    const bumped = await tx.$executeRaw`
      UPDATE "SponsoredZone"
      SET "claimedCount" = "claimedCount" + 1, "updatedAt" = ${utc(new Date())}
      WHERE id = ${zone.id}
        AND "isActive" = true
        AND ("maxClaims" IS NULL OR "claimedCount" < "maxClaims")
    `;
    if (bumped === 0) return null;

    const inserted = await tx.$executeRaw`
      INSERT INTO "SponsoredClaim" (id, "userId", "zoneId", "promoCodeGiven", "claimedAt")
      VALUES (${randomUUID()}, ${userId}, ${zone.id}, ${zone.promoCode || null}, ${utc(new Date())})
      ON CONFLICT ("userId", "zoneId") DO NOTHING
    `;
    if (inserted === 0) throw new Error('ALREADY_CLAIMED'); // rollback → claimedCount qaytadi

    const before = await tx.user.findUnique({ where: { id: userId }, select: { level: true } });
    const updated = await tx.user.update({
      where: { id: userId },
      data: { coins: { increment: zone.rewardCoins || 0 }, xp: { increment: zone.rewardXp || 0 } },
      select: { xp: true, coins: true },
    });
    const newLevel = calculateLevel(updated.xp);
    if (newLevel !== before.level) {
      await tx.user.update({ where: { id: userId }, data: { level: newLevel } });
    }
    return { oldLevel: before.level, newLevel, xp: updated.xp, coins: updated.coins };
  });
}

function questMessage(zone) {
  const reward = `+${zone.rewardCoins || 0} GeoCoin, +${zone.rewardXp || 0} XP`;
  const promo = zone.promoCode ? ` Promo-kod: ${zone.promoCode}` : '';
  return `🎉 ${zone.businessName} aksiyasi bajarildi! ${reward}.${promo}`;
}

// Bildirishnoma jadvaliga ham yozamiz — o'yinchi socket xabarini o'tkazib yuborsa ham
// promo-kod yo'qolmaydi (Notifications ro'yxatida qoladi).
async function saveNotification(userId, zone) {
  try {
    await prisma.notification.create({
      data: { userId, title: `${zone.businessName}: ${zone.title}`, body: questMessage(zone) },
    });
  } catch (err) { logger.warn('Sponsored notification save failed', { userId, err: err.message }); }
}

// Asosiy kirish nuqtasi. polygonGeoJSONStr — yangi hudud GeoJSON Polygon string'i
// (Territory.polygon formatida; loyiha WKT emas, GeoJSON ishlatadi).
// onLevelUp(result) — ixtiyoriy: level oshsa chaqiriladi (captureEffects level-up mukofoti).
async function checkAndRewardSponsoredZones(userId, polygonGeoJSONStr, io, { onLevelUp = null } = {}) {
  if (!userId || !polygonGeoJSONStr) return [];
  // Lazy require — territoryService captureEffects orqali bu faylni yuklaydi (circular himoya)
  const { calculateLevel } = require('./territoryService');

  const zones = await findEligibleZones(userId, polygonGeoJSONStr, new Date());
  const rewarded = [];
  for (const zone of zones) {
    try {
      const claim = await claimZone(userId, zone, calculateLevel);
      if (!claim) continue;
      rewarded.push(zone.id);
      if (io) {
        io.to(`user:${userId}`).emit('quest:completed', {
          zoneId: zone.id,
          businessName: zone.businessName,
          title: zone.title,
          description: zone.description || null,
          logoUrl: zone.logoUrl || null,
          promoCode: zone.promoCode || null,
          rewardCoins: zone.rewardCoins || 0,
          rewardXp: zone.rewardXp || 0,
          coins: claim.coins,
          xp: claim.xp,
          newLevel: claim.newLevel,
          message: questMessage(zone),
        });
      }
      await saveNotification(userId, zone);
      if (onLevelUp && claim.newLevel > claim.oldLevel) {
        await onLevelUp({ oldLevel: claim.oldLevel, newLevel: claim.newLevel });
      }
      logger.info(`Sponsored zone claimed: user=${userId} zone=${zone.id} (${zone.businessName})`);
    } catch (err) {
      if (err.message !== 'ALREADY_CLAIMED') {
        logger.error('Sponsored zone claim failed', { userId, zoneId: zone.id, err: err.message });
      }
    }
  }
  return rewarded;
}

// Xarita uchun: ko'rinish oynasidagi aktiv zonalar (GeoJSON). Promo-kod YUBORILMAYDI —
// u faqat zonani zabt etgan o'yinchiga beriladi.
async function getActiveZonesInBounds(swLat, swLng, neLat, neLng) {
  const now = new Date();
  const rows = await prisma.$queryRaw`
    SELECT z.id, z."businessName", z.title, z.description, z."logoUrl",
           z."rewardCoins", z."rewardXp", z."maxClaims", z."claimedCount", z."activeUntil",
           ST_AsGeoJSON(z.geom, 6)::json AS geometry
    FROM "SponsoredZone" z
    WHERE z."isActive" = true
      AND z."activeFrom" <= ${utc(now)}
      AND z."activeUntil" > ${utc(now)}
      AND (z."maxClaims" IS NULL OR z."claimedCount" < z."maxClaims")
      AND ST_Intersects(z.geom, ST_MakeEnvelope(${swLng}, ${swLat}, ${neLng}, ${neLat}, 4326))
    LIMIT 100
  `;
  return rows.map((r) => ({
    ...r,
    remaining: r.maxClaims == null ? null : Math.max(0, r.maxClaims - r.claimedCount),
  }));
}

module.exports = { checkAndRewardSponsoredZones, getActiveZonesInBounds };
