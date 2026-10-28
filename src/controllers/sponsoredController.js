// O'yinchilar uchun B2B aksiya zonalari: xaritada ko'rsatish va olingan promo-kodlar.
const { prisma } = require('../config/database');
const { getActiveZonesInBounds } = require('../services/sponsoredZone');

function parseBox(q) {
  const box = [q.swLat, q.swLng, q.neLat, q.neLng].map(parseFloat);
  if (box.some((v) => !Number.isFinite(v))) return null;
  const [swLat, swLng, neLat, neLng] = box;
  if (swLat < -90 || neLat > 90 || swLng < -180 || neLng > 180 || swLat >= neLat || swLng >= neLng) return null;
  return { swLat, swLng, neLat, neLng };
}

// GET /api/sponsored/zones?swLat=&swLng=&neLat=&neLng=
async function getZones(req, res, next) {
  try {
    const box = parseBox(req.query);
    if (!box) return res.status(400).json({ error: 'Bounding box required: swLat, swLng, neLat, neLng' });
    const zones = await getActiveZonesInBounds(box.swLat, box.swLng, box.neLat, box.neLng);
    const claimed = zones.length
      ? await prisma.sponsoredClaim.findMany({
          where: { userId: req.user.id, zoneId: { in: zones.map((z) => z.id) } },
          select: { zoneId: true },
        })
      : [];
    const claimedSet = new Set(claimed.map((c) => c.zoneId));
    res.json({ zones: zones.map((z) => ({ ...z, claimed: claimedSet.has(z.id) })) });
  } catch (err) { next(err); }
}

// GET /api/sponsored/my-claims — o'yinchi olgan aksiyalar va promo-kodlar
async function getMyClaims(req, res, next) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT c.id, c."zoneId", c."promoCodeGiven" AS "promoCode", c."claimedAt",
             z."businessName", z.title, z."logoUrl"
      FROM "SponsoredClaim" c
      JOIN "SponsoredZone" z ON z.id = c."zoneId"
      WHERE c."userId" = ${req.user.id}
      ORDER BY c."claimedAt" DESC
      LIMIT 100
    `;
    res.json({ claims: rows });
  } catch (err) { next(err); }
}

module.exports = { getZones, getMyClaims };
