// Bir martalik backfill: HAR BIR foydalanuvchining bir-biriga tegib/ustma-ust tushgan
// O'Z hududlarini bitta umumiy poligonga birlashtiradi (ichki chegaralar eriydi → bitta kontur).
// Faqat O'Z hududlari birlashadi (ownerId bo'yicha); boshqa odam/jamoadosh zonalariga tegmaydi.
//
// Ishlatish:
//   node scripts/mergeOwnTerritories.js          → DRY-RUN (hech narsa o'zgartirmaydi, faqat hisobot)
//   node scripts/mergeOwnTerritories.js --apply   → HAQIQIY birlashtirish (bazani o'zgartiradi)
//
// DIQQAT: bu PRODUCTION bazasiga ta'sir qiladi — avval DRY-RUN bilan natijani ko'ring.

require('dotenv').config();
const { prisma } = require('../src/config/database');
const polygonClipping = require('polygon-clipping');
const { polygonAreaM2 } = require('../src/services/geoService');

const APPLY = process.argv.includes('--apply');

function coordsOf(t) {
  try {
    const g = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
    return g && g.coordinates && g.coordinates[0] ? g.coordinates : null;
  } catch { return null; }
}

// Ikki poligon (GeoJSON coordinates) haqiqatan kesishadimi/tegadimi
function connected(a, b) {
  try {
    const r = polygonClipping.intersection(a, b);
    return Array.isArray(r) && r.length > 0;
  } catch { return false; }
}

(async () => {
  console.log(APPLY ? '=== HAQIQIY BIRLASHTIRISH (--apply) ===' : '=== DRY-RUN (o\'zgartirmaydi) ===');

  // Kamida 2 ta hududi bor egalarni topamiz
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

    // Union-Find: kesishuvchi hududlarni komponentlarga ajratamiz
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
      if (idxs.length < 2) continue; // yagona hudud — birlashtirishga hojat yo'q

      const polys = idxs.map(i => coords[i]).filter(Boolean);
      let res;
      try { res = polygonClipping.union(...polys); } catch { skipped++; continue; }
      if (!Array.isArray(res) || res.length !== 1) { skipped++; continue; } // bitta poligon bo'lmasa — tashlab ketamiz

      const mergedCoords = res[0]; // [outerRing, ...holes]
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

      if (APPLY) {
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

  console.log(`Foydalanuvchilar (ta'sir): ${usersAffected}`);
  console.log(`Birlashtirilgan guruhlar:  ${groupsMerged}`);
  console.log(`O'chiriladigan hududlar:    ${territoriesRemoved}`);
  console.log(`Tashlab ketilgan guruhlar:  ${skipped} (bitta poligonga birlashmagan)`);
  if (!APPLY) console.log('\n>>> Bu DRY-RUN edi. Haqiqiy birlashtirish uchun: node scripts/mergeOwnTerritories.js --apply');
  process.exit(0);
})().catch((e) => { console.error('XATO:', e.message); process.exit(1); });
