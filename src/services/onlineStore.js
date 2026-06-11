// Onlayn o'yinchilar reestri — IKKI qatlam:
//   • Lokal Map (har doim): shu instance'dagi socketlar uchun issiq yo'l (hot path).
//     REDIS_URL yo'q bo'lsa FAQAT shu ishlaydi — avvalgi xulq bilan aynan bir xil.
//   • Redis mirror (REDIS_URL berilganda): boshqa instance'lar ham o'qiy olishi uchun
//     (players:init jamoadoshlari, capture effektlari, admin live-map, stale-disconnect guard).
//
// Yozuvchi — har doim userning socketi turgan instance (owning instance). REST orqali
// jamoa o'zgarishi istisno: u Redis'ni yangilab, owning instance'ga serverSideEmit
// orqali xabar beradi (socket/index.js).
const { isRedisEnabled, getRedis, KEY } = require('../config/redis');
const logger = require('../utils/logger');

const local = new Map(); // userId -> entry

// Mirror'dagi yozuv shunchalik eski bo'lsa — o'lik instance qoldig'i deb hisoblanadi
const STALE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const SWEEP_DEAD_MS = 10 * 60 * 1000;

let warnedAt = 0;
function warnOnce(msg, err) {
  const now = Date.now();
  if (now - warnedAt > 30000) {
    warnedAt = now;
    logger.warn(`onlineStore: ${msg}: ${err.message}`);
  }
}

function serialize(entry) {
  return JSON.stringify({ ...entry, at: Date.now() });
}

function parseEntry(raw) {
  try {
    const e = JSON.parse(raw);
    if (!e || typeof e !== 'object') return null;
    if (Date.now() - (e.at || 0) > STALE_MS) return null; // o'lik instance qoldig'i
    return e;
  } catch { return null; }
}

// ── Yozish (owning instance) ──────────────────────────────────────────────────

function addLocal(userId, entry) {
  local.set(userId, entry);
  if (!isRedisEnabled()) return;
  const r = getRedis();
  const pipe = r.pipeline();
  pipe.hset(KEY.online, userId, serialize(entry));
  if (entry.teamId) pipe.sadd(KEY.teamSet(entry.teamId), userId);
  pipe.exec().catch((err) => warnOnce('addLocal mirror', err));
}

function getLocal(userId) {
  return local.get(userId) || null;
}

function localEntries() {
  return local;
}

function removeLocal(userId) {
  const entry = local.get(userId);
  local.delete(userId);
  if (!isRedisEnabled()) return;
  const r = getRedis();
  const pipe = r.pipeline();
  pipe.hdel(KEY.online, userId);
  if (entry?.teamId) pipe.srem(KEY.teamSet(entry.teamId), userId);
  pipe.exec().catch((err) => warnOnce('removeLocal mirror', err));
}

// Pozitsiya — hot path: faqat lokal mutatsiya (bepul). Mirror alohida, 15s'da bir.
function updateLocalPosition(userId, lat, lng) {
  const entry = local.get(userId);
  if (entry) { entry.lat = lat; entry.lng = lng; }
  return entry || null;
}

// Owning instance lokal yozuvni Redis'ga ko'chiradi (LOCATION_PERSIST tickida chaqiriladi)
function mirrorEntry(userId) {
  if (!isRedisEnabled()) return;
  const entry = local.get(userId);
  if (!entry) return;
  getRedis().hset(KEY.online, userId, serialize(entry))
    .catch((err) => warnOnce('mirrorEntry', err));
}

// Jamoa o'zgarishi: lokal (agar shu instance'da bo'lsa) + Redis (har doim).
// REST istalgan instance'dan chaqirishi mumkin — Redis'dagi yozuvni patch qiladi.
async function setTeam(userId, newTeamId) {
  const entryLocal = local.get(userId);
  let oldTeamId = entryLocal?.teamId || null;
  if (entryLocal) entryLocal.teamId = newTeamId || null;

  if (!isRedisEnabled()) return;
  try {
    const r = getRedis();
    let toWrite = entryLocal;
    if (!toWrite) {
      // Boshqa instance'dagi user: mirror'dan o'qib, ESKI teamId'ni olib, keyin patch
      const raw = await r.hget(KEY.online, userId);
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (parsed) {
        oldTeamId = parsed.teamId || null;
        parsed.teamId = newTeamId || null;
        toWrite = parsed;
      }
    }
    const pipe = r.pipeline();
    if (oldTeamId) pipe.srem(KEY.teamSet(oldTeamId), userId);
    if (newTeamId) pipe.sadd(KEY.teamSet(newTeamId), userId);
    if (toWrite) pipe.hset(KEY.online, userId, serialize(toWrite));
    await pipe.exec();
  } catch (err) { warnOnce('setTeam mirror', err); }
}

// Faqat lokal teamId yangilash — serverSideEmit qabul qilgan owning instance uchun
function setLocalTeam(userId, newTeamId) {
  const entry = local.get(userId);
  if (entry) entry.teamId = newTeamId || null;
}

// ── O'qish (istalgan instance) ────────────────────────────────────────────────

// Bitta userning onlayn yozuvi: avval lokal, keyin Redis mirror.
async function get(userId) {
  const entry = local.get(userId);
  if (entry) return entry;
  if (!isRedisEnabled()) return null;
  try {
    const raw = await getRedis().hget(KEY.online, userId);
    return parseEntry(raw);
  } catch (err) {
    warnOnce('get', err);
    return null;
  }
}

// Disconnect-guard uchun GLOBAL haqiqat: Redis rejimida MIRROR birinchi o'qiladi
// (lokal emas!) — user boshqa instance'ga reconnect bo'lgan bo'lsa, eski instance'dagi
// lokal nusxa yolg'on "meniki" deb ko'rsatardi. Staleness filtrsiz — bizga faqat
// socketId solishtirish kerak. Xato/yo'q bo'lsa lokalga qaytadi (xavfsiz default).
async function getMirror(userId) {
  if (!isRedisEnabled()) return local.get(userId) || null;
  try {
    const raw = await getRedis().hget(KEY.online, userId);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* buzuq yozuv — lokalga qaytamiz */ }
    }
    return local.get(userId) || null;
  } catch (err) {
    warnOnce('getMirror', err);
    return local.get(userId) || null;
  }
}

// Faqat shu instance'dagi nusxani o'chirish — mirror/team-setga TEGMAYDI.
// Eski instance o'zining eskirgan yozuvini tozalashi uchun (user boshqa instance'da davom etmoqda).
function dropLocalOnly(userId) {
  local.delete(userId);
}

// Jamoaning onlayn a'zolari: { userId: entry } (excludeId siz).
async function getTeamMembers(teamId, excludeId) {
  if (!isRedisEnabled()) {
    const out = {};
    for (const [id, e] of local) {
      if (e.teamId === teamId && id !== excludeId) out[id] = e;
    }
    return out;
  }
  try {
    const r = getRedis();
    const ids = (await r.smembers(KEY.teamSet(teamId))).filter((id) => id !== excludeId);
    if (!ids.length) return {};
    const raws = await r.hmget(KEY.online, ...ids);
    const out = {};
    ids.forEach((id, i) => {
      // Lokal nusxa (shu instance'dagi socket) — eng yangi; mirror — fallback
      const e = local.get(id) || (raws[i] ? parseEntry(raws[i]) : null);
      if (e && e.teamId === teamId) out[id] = e;
    });
    return out;
  } catch (err) {
    warnOnce('getTeamMembers', err);
    // Redis yiqilsa hech bo'lmasa shu instance'dagilarni qaytaramiz
    const out = {};
    for (const [id, e] of local) {
      if (e.teamId === teamId && id !== excludeId) out[id] = e;
    }
    return out;
  }
}

// Admin live-map uchun barcha onlayn o'yinchilar: { userId: entry }.
// cap — xavfsizlik chegarasi (admin UI baribir minglab markerni chizmaydi).
async function getAllObject(cap = 5000) {
  if (!isRedisEnabled()) {
    const out = {};
    let n = 0;
    for (const [id, e] of local) {
      out[id] = e;
      if (++n >= cap) break;
    }
    return out;
  }
  try {
    const r = getRedis();
    const out = {};
    let cursor = '0';
    let n = 0;
    do {
      const [next, kv] = await r.hscan(KEY.online, cursor, 'COUNT', 500);
      cursor = next;
      for (let i = 0; i < kv.length; i += 2) {
        const e = local.get(kv[i]) || parseEntry(kv[i + 1]);
        if (e) {
          out[kv[i]] = e;
          if (++n >= cap) return out;
        }
      }
    } while (cursor !== '0');
    return out;
  } catch (err) {
    warnOnce('getAllObject', err);
    return Object.fromEntries(local);
  }
}

// ── Admin presence — live-map broadcast guard (har nuqtada payload yasamaslik uchun)

let localAdminCount = 0;
let cachedGlobalAdmins = 0;
let cachedGlobalAdminsAt = 0;

function adminJoined() {
  localAdminCount++;
  if (isRedisEnabled()) {
    getRedis().incr(KEY.adminCount).catch((err) => warnOnce('adminJoined', err));
  }
}

function adminLeft() {
  localAdminCount = Math.max(0, localAdminCount - 1);
  if (isRedisEnabled()) {
    // 0 dan pastga tushib ketmasin (instance qulashi va h.k.)
    const r = getRedis();
    r.decr(KEY.adminCount).then((v) => { if (v < 0) return r.set(KEY.adminCount, 0); })
      .catch((err) => warnOnce('adminLeft', err));
  }
}

// Sinxron tekshiruv (hot path): lokal admin bormi YOKI global keshlangan son > 0.
// Global son 5s da bir yangilanadi — kechikish faqat admin xaritasi yoqilish onida.
function adminWatching() {
  if (localAdminCount > 0) return true;
  if (!isRedisEnabled()) return false;
  const now = Date.now();
  if (now - cachedGlobalAdminsAt > 5000) {
    cachedGlobalAdminsAt = now;
    getRedis().get(KEY.adminCount)
      .then((v) => { cachedGlobalAdmins = parseInt(v || '0', 10) || 0; })
      .catch((err) => warnOnce('adminWatching', err));
  }
  return cachedGlobalAdmins > 0;
}

// ── Heartbeat + sweep (faqat Redis rejimida ish bajaradi) ────────────────────
// Heartbeat: shu instance'dagi yozuvlarning 'at' maydonini yangilab turadi —
// lokatsiya yubormayotgan (menyuda o'tirgan) userlar ham mirror'da tirik ko'rinadi.
// Sweep: o'lik instance'lardan qolgan eskirgan yozuvlarni o'chiradi.
function startMaintenance() {
  if (!isRedisEnabled()) return;

  setInterval(() => {
    if (!local.size) return;
    const r = getRedis();
    const pipe = r.pipeline();
    for (const [id] of local) {
      const entry = local.get(id);
      if (entry) pipe.hset(KEY.online, id, serialize(entry));
    }
    pipe.exec().catch((err) => warnOnce('heartbeat', err));
  }, HEARTBEAT_MS).unref();

  setInterval(async () => {
    try {
      const r = getRedis();
      let cursor = '0';
      do {
        const [next, kv] = await r.hscan(KEY.online, cursor, 'COUNT', 500);
        cursor = next;
        const dead = [];
        for (let i = 0; i < kv.length; i += 2) {
          try {
            const e = JSON.parse(kv[i + 1]);
            if (Date.now() - (e.at || 0) > SWEEP_DEAD_MS) dead.push({ id: kv[i], teamId: e.teamId });
          } catch { dead.push({ id: kv[i], teamId: null }); }
        }
        if (dead.length) {
          const pipe = r.pipeline();
          for (const d of dead) {
            pipe.hdel(KEY.online, d.id);
            if (d.teamId) pipe.srem(KEY.teamSet(d.teamId), d.id);
          }
          await pipe.exec();
        }
      } while (cursor !== '0');
    } catch (err) { warnOnce('sweep', err); }
  }, SWEEP_MS).unref();
}

module.exports = {
  addLocal, getLocal, localEntries, removeLocal, dropLocalOnly,
  updateLocalPosition, mirrorEntry,
  setTeam, setLocalTeam,
  get, getMirror, getTeamMembers, getAllObject,
  adminJoined, adminLeft, adminWatching,
  startMaintenance,
};
