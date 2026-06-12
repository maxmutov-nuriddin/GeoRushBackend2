const { prisma } = require('../config/database');
const polygonClipping = require('polygon-clipping');
const { polygonAreaM2 } = require('./geoService');
const logger = require('../utils/logger');

// Bir martalik backfill: HAR BIR foydalanuvchining bir-biriga tegib/ustma-ust tushgan
// O'Z hududlarini bitta umumiy poligonga birlashtiradi (faqat ownerId bo'yicha — boshqa
// odam zonalariga tegmaydi). Capture-time birlashtirish kelajakdagi egallashlar uchun,
// bu esa MAVJUD (eski) ma'lumotni tozalaydi. Idempotent: birlashtirilgach qayta o'zgartirmaydi.

const FLAG_KEY = 'territory_merge_backfill_v1';

function coordsOf(t) {
  try {
    const g = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
    return g && g.coordinates && g.coordinates[0] ? g.coordinates : null;
  } catch { return null; }
}

function connected(a, b) {
  try {
    const r = polygonClipping.intersection(a, b);
    return Array.isArray(r) && r.length > 0;
  } catch { return false; }
}

// Asosiy mantiq. apply=false → faqat hisoblaydi (dry-run), bazani o'zgartirmaydi.
async function mergeAllOwnTerritories({ apply = false } = {}) {
  const grouped = await prisma.territory.groupBy({
    by: ['ownerId'],
    _count: { _all: true },
    having: { ownerId: { _count: { gt: 1 } } },
  });

  let usersAffected = 0, groupsMerged = 0, territoriesRemoved = 0, skipped = 0;

  for (const g of grouped) {
    const ownerId = g.ownerId;
    if (!ownerId) continue;
    const terrs = await prisma.territory.findMany({ where: { ownerId } });
    if (terrs.length < 2) continue;

    const coords = terrs.map(coordsOf);

    // Union-Find — kesishuvchi hududlarni komponentlarga ajratamiz
    const n = terrs.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const unite = (a, b) => { parent[find(a)] = find(b); };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (coords[i] && coords[j] && connected(coords[i], coords[j])) unite(i, j);
      }
    }
    const comps = {};
    for (let i = 0; i < n; i++) { const r = find(i); (comps[r] = comps[r] || []).push(i); }

    let userTouched = false;
    for (const key of Object.keys(comps)) {
      const idxs = comps[key];
      if (idxs.length < 2) continue;

      const polys = idxs.map(i => coords[i]).filter(Boolean);
      let res;
      try { res = polygonClipping.union(...polys); } catch { skipped++; continue; }
      if (!Array.isArray(res) || res.length !== 1) { skipped++; continue; }

      const mergedCoords = res[0];
      const ringLatLng = mergedCoords[0].map(([lng, lat]) => [lat, lng]);
      const mergedArea = polygonAreaM2(ringLatLng);

      const groupTerrs = idxs.map(i => terrs[i]);
      const keep = groupTerrs[0];
      const removeIds = groupTerrs.slice(1).map(t => t.id);
      const oldAreaSum = groupTerrs.reduce((s, t) => s + (t.area || 0), 0);
      const teamId = keep.teamId || null;

      groupsMerged++;
      territoriesRemoved += removeIds.length;
      userTouched = true;

      if (apply) {
        await prisma.$transaction(async (tx) => {
          await tx.territory.update({
            where: { id: keep.id },
            data: { polygon: { type: 'Polygon', coordinates: mergedCoords }, area: mergedArea },
          });
          await tx.territory.deleteMany({ where: { id: { in: removeIds } } });
          await tx.user.update({
            where: { id: ownerId },
            data: { totalArea: { increment: mergedArea - oldAreaSum } },
          }).catch(() => {});
          if (teamId) {
            await tx.team.update({
              where: { id: teamId },
              data: { totalArea: { increment: mergedArea - oldAreaSum } },
            }).catch(() => {});
          }
        });
      }
    }
    if (userTouched) usersAffected++;
  }

  return { usersAffected, groupsMerged, territoriesRemoved, skipped };
}

async function flagDone() {
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT 1 FROM "SystemFlag" WHERE "key" = $1 LIMIT 1`, FLAG_KEY);
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

async function markFlagDone() {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SystemFlag" ("key","createdAt") VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT ("key") DO NOTHING`,
      FLAG_KEY,
    );
  } catch (e) { logger.warn('SystemFlag belgilash xatosi:', e.message); }
}

// Server bootда avtomatik — FAQAT BIR MARTA (SystemFlag bilan). Boot'ni bloklamaslik
// uchun fonda chaqiriladi. Muvaffaqiyatli tugagachgina flag qo'yiladi (xato bo'lsa keyingi
// deployда qayta urinadi). TERRITORY_AUTO_MERGE=false bilan o'chirib qo'yish mumkin.
async function runMergeBackfillOnce() {
  if (process.env.TERRITORY_AUTO_MERGE === 'false') return;
  try {
    if (await flagDone()) return;
    const stats = await mergeAllOwnTerritories({ apply: true });
    await markFlagDone();
    logger.info(`Hudud birlashtirish (backfill) bajarildi: foydalanuvchi=${stats.usersAffected}, guruh=${stats.groupsMerged}, o'chirildi=${stats.territoriesRemoved}, tashlandi=${stats.skipped}`);
  } catch (err) {
    logger.warn('Hudud birlashtirish (backfill) xatosi — keyingi deployда qayta urinadi:', err.message);
  }
}

module.exports = { mergeAllOwnTerritories, runMergeBackfillOnce };
