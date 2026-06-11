// Trail saqlash qatlami — IKKI rejim, BIR XIL semantika:
//   • Xotira (default, REDIS_URL yo'q): aynan avvalgi userTrails Map xulqi.
//   • Redis (scale-out): trail Redis listda — REST capture istalgan instance'ga
//     tushganda ham, jamoadoshlar boshqa instance'da bo'lganda ham trail topiladi.
//
// MUHIM semantika (ikkala rejimda saqlanadi):
//   - limit oshganda trail[0] (boshlanish nuqtasi) SAQLANIB, o'rtadagi eski
//     nuqtalar olib tashlanadi (polygon yopilishi uchun birinchi nuqta kerak).
//   - disconnect'da trail o'chadi (bugungi xulq) — TTL esa instance qulaganda
//     qolib ketgan kalitlarni tozalaydi.
const constants = require('../config/constants');
const { isRedisEnabled, getRedis, KEY } = require('../config/redis');
const logger = require('../utils/logger');

const TRAIL_TTL_MS = 24 * 60 * 60 * 1000; // 24 soat — yetim kalitlarga qarshi

// ── Xotira rejimi ─────────────────────────────────────────────────────────────
const memTrails = new Map(); // userId -> [[lat,lng],...]

// ── Redis rejimi: RPUSH + cap bitta atomik Lua skriptda ──────────────────────
// KEYS[1]=trail kaliti, ARGV[1]="lat,lng", ARGV[2]=MAX, ARGV[3]=TTL(ms)
const ADD_POINT_LUA = `
redis.call('RPUSH', KEYS[1], ARGV[1])
local len = redis.call('LLEN', KEYS[1])
local max = tonumber(ARGV[2])
if len > max then
  local first = redis.call('LINDEX', KEYS[1], 0)
  redis.call('LTRIM', KEYS[1], len - max + 1, -1)
  redis.call('LPUSH', KEYS[1], first)
  len = max
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return len
`;

let addPointSha = null;
async function redisAddPoint(userId, lat, lng) {
  const redis = getRedis();
  const args = [KEY.trail(userId), `${lat},${lng}`, String(constants.MAX_TRAIL_POINTS), String(TRAIL_TTL_MS)];
  try {
    if (!addPointSha) addPointSha = await redis.script('LOAD', ADD_POINT_LUA);
    return await redis.evalsha(addPointSha, 1, ...args);
  } catch (err) {
    if (String(err.message).includes('NOSCRIPT')) {
      addPointSha = null;
      return await redis.eval(ADD_POINT_LUA, 1, ...args);
    }
    throw err;
  }
}

function parsePoint(s) {
  const i = s.indexOf(',');
  return [parseFloat(s.slice(0, i)), parseFloat(s.slice(i + 1))];
}

// ── Umumiy API (hammasi async — chaqiruvchilar rejimni bilmaydi) ──────────────

async function addPoint(userId, lat, lng) {
  if (!isRedisEnabled()) {
    if (!memTrails.has(userId)) memTrails.set(userId, []);
    const trail = memTrails.get(userId);
    trail.push([lat, lng]);
    if (trail.length > constants.MAX_TRAIL_POINTS) {
      // trail[0] (boshlanish nuqtasi) saqlanib qoladi — polygon yopilishi uchun kerak
      trail.splice(1, trail.length - constants.MAX_TRAIL_POINTS);
    }
    return trail.length;
  }
  return redisAddPoint(userId, lat, lng);
}

async function getTrail(userId) {
  if (!isRedisEnabled()) return memTrails.get(userId) || [];
  const raw = await getRedis().lrange(KEY.trail(userId), 0, -1);
  return raw.map(parsePoint);
}

async function resetTrail(userId) {
  if (!isRedisEnabled()) {
    memTrails.set(userId, []);
    return;
  }
  await getRedis().del(KEY.trail(userId));
}

// Disconnect'dagi tozalash — bugungi xulq bilan bir xil (trail yo'qoladi).
async function dropTrail(userId) {
  if (!isRedisEnabled()) {
    memTrails.delete(userId);
    return;
  }
  await getRedis().del(KEY.trail(userId));
}

module.exports = { addPoint, getTrail, resetTrail, dropTrail };
