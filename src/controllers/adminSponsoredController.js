// Admin: B2B Sponsored Zone (kafe/do'kon aksiyalari) — yaratish, ro'yxat + statistika,
// tahrirlash, o'chirish, claim'lar ro'yxati. Hammasi raw SQL — geom PostGIS ustun (Prisma
// uni Unsupported deb biladi).
//
// Zona geometriyasi ikki usulda beriladi:
//   1) nuqta + radius: { lat, lng, radiusM }   → ST_Buffer(geography) — doira
//   2) tayyor poligon: { polygon: GeoJSON Polygon } (admin xaritada chizgan)
const { randomUUID } = require('crypto');
const { prisma } = require('../config/database');
const { logAdminAction } = require('../services/auditLog');

const RADIUS_MIN_M = 20;
const RADIUS_MAX_M = 2000;
const POLYGON_MAX_POINTS = 200;
const ZONE_MAX_AREA_M2 = 5_000_000;     // 5 km² — o'yin hududi maksimumi bilan bir xil
const REWARD_COINS_MAX = 10000;
const REWARD_XP_MAX = 50000;
const BUFFER_SEGMENTS = 16;              // doira aniqligi (chorak doiraga segmentlar)
const DATE_COLUMNS = new Set(['activeFrom', 'activeUntil']);

// Vaqt ustunlari TIMESTAMP(3), UTC'da. JS Date to'g'ridan-to'g'ri berilsa Postgres sessiya
// timezone'i bo'yicha aylantiradi (+5 soat siljish) — shuning uchun ISO matn + aniq UTC.
const UTC_NOW = `(NOW() AT TIME ZONE 'UTC')`;
const utcParam = (n) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

class ZoneInputError extends Error {}

function intInRange(v, min, max, field) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ZoneInputError(`${field}: ${min}–${max} oralig'idagi butun son bo'lishi kerak`);
  return n;
}

function text(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (required) throw new ZoneInputError(`${field} majburiy`);
    return undefined;
  }
  const s = String(v).trim();
  if (s.length > max) throw new ZoneInputError(`${field}: ko'pi bilan ${max} belgi`);
  return s;
}

function date(v, field) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ZoneInputError(`${field}: noto'g'ri sana`);
  return d;
}

function logoUrl(v) {
  const s = text(v, 'logoUrl', 500);
  if (s === undefined) return undefined;
  if (!/^https:\/\//i.test(s)) throw new ZoneInputError('logoUrl https:// bilan boshlanishi kerak');
  return s;
}

function validPolygon(p) {
  if (!p || p.type !== 'Polygon' || !Array.isArray(p.coordinates) || !Array.isArray(p.coordinates[0])) return false;
  const ring = p.coordinates[0];
  if (ring.length < 4 || ring.length > POLYGON_MAX_POINTS) return false;
  const ok = ring.every((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])
    && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90);
  const [f, l] = [ring[0], ring[ring.length - 1]];
  return ok && f[0] === l[0] && f[1] === l[1];
}

// Body'dan zona maydonlarini yig'adi. partial=true — PATCH (faqat berilganlari).
function parseZoneFields(b, { partial }) {
  const fields = {
    businessName: text(b.businessName, 'businessName', 100, { required: !partial }),
    title:        text(b.title, 'title', 120, { required: !partial }),
    description:  text(b.description, 'description', 1000),
    logoUrl:      logoUrl(b.logoUrl),
    promoCode:    text(b.promoCode, 'promoCode', 40),
    rewardCoins:  intInRange(b.rewardCoins, 0, REWARD_COINS_MAX, 'rewardCoins'),
    rewardXp:     intInRange(b.rewardXp, 0, REWARD_XP_MAX, 'rewardXp'),
    maxClaims:    b.maxClaims === null ? null : intInRange(b.maxClaims, 1, 1_000_000, 'maxClaims'),
    activeFrom:   date(b.activeFrom, 'activeFrom'),
    activeUntil:  date(b.activeUntil, 'activeUntil'),
    isActive:     typeof b.isActive === 'boolean' ? b.isActive : undefined,
  };
  if (!partial && !fields.activeUntil) throw new ZoneInputError('activeUntil majburiy');
  const from = fields.activeFrom || (partial ? undefined : new Date());
  if (from && fields.activeUntil && fields.activeUntil <= from) throw new ZoneInputError('activeUntil activeFrom\'dan keyin bo\'lishi kerak');
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

// Geometriya uchun SQL bo'lagi (Prisma.sql emas — $queryRawUnsafe parametrlari bilan).
function parseGeometry(b, required) {
  if (b.polygon) {
    if (!validPolygon(b.polygon)) throw new ZoneInputError(`polygon: yopiq GeoJSON Polygon, 4–${POLYGON_MAX_POINTS} nuqta`);
    return { sql: 'ST_SetSRID(ST_GeomFromGeoJSON($GEO), 4326)', params: [JSON.stringify(b.polygon)] };
  }
  if (b.lat !== undefined || b.lng !== undefined || b.radiusM !== undefined) {
    const lat = Number(b.lat), lng = Number(b.lng), r = Number(b.radiusM);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new ZoneInputError('lat/lng noto\'g\'ri');
    }
    if (!Number.isFinite(r) || r < RADIUS_MIN_M || r > RADIUS_MAX_M) throw new ZoneInputError(`radiusM: ${RADIUS_MIN_M}–${RADIUS_MAX_M} m`);
    return {
      sql: `ST_Buffer(ST_SetSRID(ST_MakePoint($GEO, $GEO), 4326)::geography, $GEO, ${BUFFER_SEGMENTS})::geometry`,
      params: [lng, lat, r],
    };
  }
  if (required) throw new ZoneInputError('Zona joyi kerak: (lat, lng, radiusM) yoki polygon');
  return null;
}

// "$GEO" belgilarini haqiqiy $n raqamlariga almashtiradi.
function bindGeometry(geo, startIndex) {
  let i = startIndex;
  return geo.sql.replace(/\$GEO/g, () => `$${i++}`);
}

async function assertGeometryOk(geo) {
  const sql = `SELECT ST_IsValid(g) AS valid, ST_Area(g::geography) AS area FROM (SELECT ${bindGeometry(geo, 1)} AS g) s`;
  const [row] = await prisma.$queryRawUnsafe(sql, ...geo.params);
  if (!row?.valid) throw new ZoneInputError('Poligon o\'zini kesib o\'tadi yoki noto\'g\'ri');
  if (Number(row.area) > ZONE_MAX_AREA_M2) throw new ZoneInputError('Zona juda katta (max 5 km²)');
}

const ZONE_COLUMNS = `
  z.id, z."businessName", z.title, z.description, z."logoUrl", z."promoCode",
  z."rewardCoins", z."rewardXp", z."maxClaims", z."claimedCount",
  z."activeFrom", z."activeUntil", z."isActive", z."createdAt", z."updatedAt",
  ST_AsGeoJSON(z.geom, 6)::json AS geometry,
  ST_Area(z.geom::geography) AS "areaM2"`;

async function getZoneById(id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT ${ZONE_COLUMNS} FROM "SponsoredZone" z WHERE z.id = $1`, id);
  return rows[0] || null;
}

function handleInputError(err, res, next) {
  if (err instanceof ZoneInputError) return res.status(400).json({ error: err.message });
  return next(err);
}

// POST /api/admin/sponsored-zones
async function createZone(req, res, next) {
  try {
    const f = parseZoneFields(req.body || {}, { partial: false });
    const geo = parseGeometry(req.body || {}, true);
    await assertGeometryOk(geo);

    const id = randomUUID();
    const now = new Date();
    const base = [
      id, f.businessName, f.title, f.description ?? null, f.logoUrl ?? null, f.promoCode ?? null,
      f.rewardCoins ?? 100, f.rewardXp ?? 200, f.maxClaims ?? null,
      (f.activeFrom ?? now).toISOString(), f.activeUntil.toISOString(), f.isActive ?? true, now.toISOString(),
    ];
    const sql = `
      INSERT INTO "SponsoredZone"
        (id, "businessName", title, description, "logoUrl", "promoCode", "rewardCoins", "rewardXp",
         "maxClaims", "activeFrom", "activeUntil", "isActive", "createdAt", "updatedAt", geom)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${utcParam(10)}, ${utcParam(11)}, $12, ${utcParam(13)}, ${utcParam(13)},
              ${bindGeometry(geo, base.length + 1)})`;
    await prisma.$executeRawUnsafe(sql, ...base, ...geo.params);

    logAdminAction(req.user?.id, 'admin_sponsored_zone_create', null, { zoneId: id, businessName: f.businessName });
    res.status(201).json({ zone: await getZoneById(id) });
  } catch (err) { handleInputError(err, res, next); }
}

// GET /api/admin/sponsored-zones?status=active|scheduled|ended|all
async function listZones(req, res, next) {
  try {
    const status = ['active', 'scheduled', 'ended'].includes(req.query.status) ? req.query.status : 'all';
    const filter = {
      all: '',
      active: `WHERE z."isActive" = true AND z."activeFrom" <= ${UTC_NOW} AND z."activeUntil" > ${UTC_NOW}`,
      scheduled: `WHERE z."activeFrom" > ${UTC_NOW}`,
      ended: `WHERE z."activeUntil" <= ${UTC_NOW} OR z."isActive" = false`,
    }[status];
    const zones = await prisma.$queryRawUnsafe(`
      SELECT ${ZONE_COLUMNS},
             COALESCE(s.claims24h, 0)::int AS "claims24h",
             COALESCE(s.claims7d, 0)::int  AS "claims7d",
             s."lastClaimAt"
      FROM "SponsoredZone" z
      LEFT JOIN (
        SELECT "zoneId",
               COUNT(*) FILTER (WHERE "claimedAt" > ${UTC_NOW} - INTERVAL '24 hours') AS claims24h,
               COUNT(*) FILTER (WHERE "claimedAt" > ${UTC_NOW} - INTERVAL '7 days')   AS claims7d,
               MAX("claimedAt") AS "lastClaimAt"
        FROM "SponsoredClaim" GROUP BY "zoneId"
      ) s ON s."zoneId" = z.id
      ${filter}
      ORDER BY z."createdAt" DESC
      LIMIT 500`);

    const [totals] = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS "totalClaims",
             COUNT(DISTINCT "userId")::int AS "uniquePlayers",
             COUNT(*) FILTER (WHERE "claimedAt" > ${UTC_NOW} - INTERVAL '24 hours')::int AS "claims24h"
      FROM "SponsoredClaim"`);

    res.json({ zones, totals });
  } catch (err) { next(err); }
}

// PATCH /api/admin/sponsored-zones/:id
async function updateZone(req, res, next) {
  try {
    const existing = await getZoneById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Zona topilmadi' });

    const f = parseZoneFields(req.body || {}, { partial: true });
    const from = f.activeFrom || new Date(existing.activeFrom);
    const until = f.activeUntil || new Date(existing.activeUntil);
    if (until <= from) return res.status(400).json({ error: 'activeUntil activeFrom\'dan keyin bo\'lishi kerak' });

    const geo = parseGeometry(req.body || {}, false);
    if (geo) await assertGeometryOk(geo);

    const sets = [];
    const params = [];
    for (const [col, val] of Object.entries(f)) {
      const isDate = DATE_COLUMNS.has(col);
      params.push(isDate ? val.toISOString() : val);
      sets.push(`"${col}" = ${isDate ? utcParam(params.length) : `$${params.length}`}`);
    }
    params.push(new Date().toISOString());
    sets.push(`"updatedAt" = ${utcParam(params.length)}`);
    if (geo) sets.push(`geom = ${bindGeometry(geo, params.length + 1)}`);
    const allParams = geo ? [...params, ...geo.params] : params;
    allParams.push(req.params.id);
    await prisma.$executeRawUnsafe(
      `UPDATE "SponsoredZone" SET ${sets.join(', ')} WHERE id = $${allParams.length}`,
      ...allParams,
    );

    logAdminAction(req.user?.id, 'admin_sponsored_zone_update', null, { zoneId: req.params.id, fields: Object.keys(f), geometry: !!geo });
    res.json({ zone: await getZoneById(req.params.id) });
  } catch (err) { handleInputError(err, res, next); }
}

// DELETE /api/admin/sponsored-zones/:id — claim'lar ham o'chadi (FK CASCADE)
async function deleteZone(req, res, next) {
  try {
    const count = await prisma.$executeRawUnsafe(`DELETE FROM "SponsoredZone" WHERE id = $1`, req.params.id);
    if (!count) return res.status(404).json({ error: 'Zona topilmadi' });
    logAdminAction(req.user?.id, 'admin_sponsored_zone_delete', null, { zoneId: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// GET /api/admin/sponsored-zones/:id/claims
async function getZoneClaims(req, res, next) {
  try {
    const claims = await prisma.$queryRawUnsafe(`
      SELECT c.id, c."userId", c."promoCodeGiven", c."claimedAt", u.username, u.color, u.level
      FROM "SponsoredClaim" c
      LEFT JOIN "User" u ON u.id = c."userId"
      WHERE c."zoneId" = $1
      ORDER BY c."claimedAt" DESC
      LIMIT 500`, req.params.id);
    res.json({ claims });
  } catch (err) { next(err); }
}

module.exports = { createZone, listZones, updateZone, deleteZone, getZoneClaims };
