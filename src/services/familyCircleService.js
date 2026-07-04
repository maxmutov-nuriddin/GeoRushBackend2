// "Oila Doirasi" (Family Circle) — doimiy oilaviy xavfsizlik.
// MAXFIYLIK QOIDASI (Hamroh bilan bir xil falsafa): xom GPS trace SAQLANMAYDI —
// faqat nomlangan zonalarga KIRISH/CHIQISH voqealari (vaqt + zona) yoziladi.
// Faqat shu doira a'zolari bir-birining zona-voqealarini ko'radi.
//
// Hot-path (locationHandler): har GPS-fix uchun sinxron Map lookup, DB YO'Q.
// Zona holati o'zgargandagina (kamdan-kam) DB yozuvi + push/socket ketadi.
const { randomUUID } = require('crypto');
const { prisma } = require('../config/database');
const { haversineDistance } = require('./geoService');
const onlineStore = require('./onlineStore');
const logger = require('../utils/logger');

// circleId -> [{ id, label, lat, lng, radiusM }]
const circleZones = new Map();
// circleId -> Set<userId>
const circleMembers = new Map();
// userId -> [{ circleId, zoneId, label, lat, lng, radiusM }]  (yuqoridagilardan hosila)
const userZones = new Map();
// `${userId}:${zoneId}` -> boolean (ichkaridami). undefined = hali kuzatilmagan (jim seed).
const zoneState = new Map();

// Gisterezis: chegarada GPS "titrashi" (flapping) yangi voqea yasab yubormasin.
// Kirish: masofa <= radius. Chiqish: masofa > radius + EXIT_BUFFER_M.
const EXIT_BUFFER_M = 40;

// userId -> ts: bir user uchun tekshiruvni siyraklashtirish (hot-path yukini kamaytiradi).
const lastCheckAt = new Map();
const CHECK_THROTTLE_MS = 8 * 1000;

// userZones ni bitta doira uchun qayta yig'amiz (a'zolar × zonalar).
function rebuildUserZones() {
  userZones.clear();
  for (const [circleId, members] of circleMembers) {
    const zones = circleZones.get(circleId);
    if (!zones || !zones.length || !members.size) continue;
    for (const userId of members) {
      let arr = userZones.get(userId);
      if (!arr) { arr = []; userZones.set(userId, arr); }
      for (const z of zones) {
        arr.push({ circleId, zoneId: z.id, label: z.label, lat: z.lat, lng: z.lng, radiusM: z.radiusM });
      }
    }
  }
}

// Controller yangilanish (zona/a'zo qo'shildi-o'chdi) qilganda shu doirani DB'dan qayta o'qiydi.
async function reloadCircle(circleId) {
  try {
    const [zones, members] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT "id","label","lat","lng","radiusM" FROM "FamilyZone" WHERE "circleId" = $1`, circleId
      ),
      prisma.$queryRawUnsafe(
        `SELECT "userId" FROM "FamilyCircleMember" WHERE "circleId" = $1`, circleId
      ),
    ]);
    circleZones.set(circleId, zones.map((z) => ({
      id: z.id, label: z.label, lat: z.lat, lng: z.lng, radiusM: z.radiusM,
    })));
    circleMembers.set(circleId, new Set(members.map((m) => String(m.userId))));
    rebuildUserZones();
  } catch (err) {
    logger.warn('FamilyCircle reloadCircle skip:', err.message.split('\n')[0]);
  }
}

// Doira butunlay o'chirilganda xotiradan olib tashlaymiz.
function removeCircle(circleId) {
  // Avval shu doiraga tegishli zoneState kalitlarini tozalaymiz (delete'dan OLDIN o'qiymiz).
  const zones = circleZones.get(circleId) || [];
  const zoneIds = new Set(zones.map((z) => z.id));
  for (const key of zoneState.keys()) {
    const zid = key.slice(key.indexOf(':') + 1);
    if (zoneIds.has(zid)) zoneState.delete(key);
  }
  circleZones.delete(circleId);
  circleMembers.delete(circleId);
  rebuildUserZones();
}

// locationHandler hot-path'idan chaqiriladi. Sinxron: Map lookup + masofa hisobi.
// Zona holati o'zgarsa fire-and-forget voqea yozadi (await YO'Q — hot-path tez qoladi).
function checkLocation(io, userId, lat, lng) {
  const zones = userZones.get(String(userId));
  if (!zones || !zones.length) return;

  const now = Date.now();
  if (now - (lastCheckAt.get(userId) || 0) < CHECK_THROTTLE_MS) return;
  lastCheckAt.set(userId, now);

  for (const z of zones) {
    const dist = haversineDistance(lat, lng, z.lat, z.lng);
    const key = `${userId}:${z.zoneId}`;
    const prev = zoneState.get(key);
    const inside = dist <= z.radiusM;
    const outside = dist > z.radiusM + EXIT_BUFFER_M;

    if (prev === undefined) {
      // Birinchi kuzatuv — holatni JIM belgilaymiz (soxta "kirdi/chiqdi" yubormaymiz).
      if (inside) zoneState.set(key, true);
      else if (outside) zoneState.set(key, false);
      continue;
    }
    if (!prev && inside) {
      zoneState.set(key, true);
      recordAndNotify(io, userId, z, 'enter').catch(() => {});
    } else if (prev && outside) {
      zoneState.set(key, false);
      recordAndNotify(io, userId, z, 'exit').catch(() => {});
    }
  }
}

// Zona holati o'zgargandagina — DB voqea + boshqa a'zolarga push/socket. Kamdan-kam.
async function recordAndNotify(io, userId, z, kind) {
  const { sendExpoPush } = require('./captureEffects');
  const members = circleMembers.get(z.circleId);
  if (!members) return;

  // Voqeani yozamiz (tarix). zoneLabel snapshot — zona keyin o'chsa ham tarix qoladi.
  const eventId = randomUUID();
  prisma.$executeRawUnsafe(
    `INSERT INTO "FamilyZoneEvent" ("id","circleId","zoneId","userId","zoneLabel","kind")
     VALUES ($1,$2,$3,$4,$5,$6)`,
    eventId, z.circleId, z.zoneId, String(userId), z.label, kind
  ).catch(() => {});

  // Kirgan/chiqqan a'zoning nomi (onlayn keshdan, bo'lmasa DB'dan).
  let name = onlineStore.getLocal(String(userId))?.username;
  if (!name) {
    const u = await prisma.user.findUnique({ where: { id: String(userId) }, select: { username: true } }).catch(() => null);
    name = u?.username || 'A\'zo';
  }

  const at = Date.now();
  const emoji = kind === 'enter' ? '✅' : '🏠';
  const verb = kind === 'enter' ? `${z.label}ga yetdi` : `${z.label}dan chiqdi`;

  // Boshqa a'zolarga (o'zidan tashqari) socket + push.
  const others = [...members].filter((m) => m !== String(userId));
  if (!others.length) return;

  for (const m of others) {
    io?.to(`user:${m}`).emit('family:zoneEvent', {
      circleId: z.circleId, zoneId: z.zoneId, zoneLabel: z.label,
      userId: String(userId), username: name, kind, at,
    });
  }

  // Push — ilova yopiq bo'lsa ham yetadi (kamdan-kam voqea, DB so'rovi maqbul).
  const tokens = await prisma.user.findMany({
    where: { id: { in: others }, expoPushToken: { not: null } },
    select: { expoPushToken: true },
  }).catch(() => []);
  const hhmm = new Date(at).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
  for (const t of tokens) {
    if (t.expoPushToken) {
      sendExpoPush(t.expoPushToken, `${emoji} Oila Doirasi`, `${name} ${verb} (${hhmm})`).catch(() => {});
    }
  }
}

// Server ishga tushganda barcha doiralarni xotiraga tiklaymiz (restart'da yo'qolmasin).
async function loadAll() {
  try {
    const [zones, members] = await Promise.all([
      prisma.$queryRawUnsafe(`SELECT "id","circleId","label","lat","lng","radiusM" FROM "FamilyZone"`),
      prisma.$queryRawUnsafe(`SELECT "circleId","userId" FROM "FamilyCircleMember"`),
    ]);
    for (const z of zones) {
      let arr = circleZones.get(z.circleId);
      if (!arr) { arr = []; circleZones.set(z.circleId, arr); }
      arr.push({ id: z.id, label: z.label, lat: z.lat, lng: z.lng, radiusM: z.radiusM });
    }
    for (const m of members) {
      let set = circleMembers.get(m.circleId);
      if (!set) { set = new Set(); circleMembers.set(m.circleId, set); }
      set.add(String(m.userId));
    }
    rebuildUserZones();
    if (zones.length || members.length) {
      logger.info(`FamilyCircle: ${circleMembers.size} doira, ${zones.length} zona tiklandi`);
    }
  } catch (err) {
    logger.warn('FamilyCircle loadAll skip:', err.message.split('\n')[0]);
  }
}

module.exports = { loadAll, reloadCircle, removeCircle, checkLocation };
