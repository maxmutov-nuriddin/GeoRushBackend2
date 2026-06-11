// Redis ulanishi — FAQAT REDIS_URL berilganda yoqiladi (scale-out rejimi).
// REDIS_URL yo'q bo'lsa: hech qanday ulanish ochilmaydi, hech narsa o'zgarmaydi —
// butun backend avvalgidek bitta-instance xotira rejimida ishlayveradi.
//
// Scale-out rejimida Redis 3 narsa uchun ishlatiladi:
//   1. Socket.IO redis-adapter (room broadcast'lar barcha instance'larga yetadi)
//   2. trailStore — trail'lar Redis listlarida (REST capture istalgan instance'ga tushadi)
//   3. onlineStore mirror — onlayn o'yinchilar ro'yxati cross-instance o'qish uchun
const logger = require('../utils/logger');

const REDIS_URL = process.env.REDIS_URL || '';

function isRedisEnabled() {
  return !!REDIS_URL;
}

let lastErrLogAt = 0;
function throttledErrorLog(name) {
  return (err) => {
    const now = Date.now();
    if (now - lastErrLogAt > 30000) { // 30s da bir marta — log to'lib ketmasin
      lastErrLogAt = now;
      logger.error(`Redis (${name}) xatosi: ${err.message}`);
    }
  };
}

// ioredis faqat kerak bo'lganda require qilinadi — dependency o'rnatilmagan
// muhitda ham REDIS_URL'siz backend bemalol yuklanadi.
function createRedisClient(name) {
  const Redis = require('ioredis');
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 10000,
  });
  client.on('error', throttledErrorLog(name));
  client.on('connect', () => logger.info(`Redis (${name}) ulandi`));
  return client;
}

let mainClient = null;
// Umumiy (key-value/list/hash amallar uchun) client. Adapter o'z pub/sub
// clientlarini alohida oladi (createRedisClient orqali).
function getRedis() {
  if (!isRedisEnabled()) return null;
  if (!mainClient) mainClient = createRedisClient('main');
  return mainClient;
}

// Kalit prefiksi — bitta Redis'ni boshqa servislar bilan bo'lishganda to'qnashmaslik uchun
const KEY = {
  trail:     (userId) => `gr:trail:${userId}`,
  online:    'gr:online',                      // HASH: userId -> JSON
  teamSet:   (teamId) => `gr:teamonline:${teamId}`, // SET: userId'lar
  adminCount: 'gr:admincount',                 // INT: onlayn admin soni (live-map broadcast guard)
};

module.exports = { isRedisEnabled, getRedis, createRedisClient, KEY };
