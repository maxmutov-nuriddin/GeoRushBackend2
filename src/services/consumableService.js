// Iste'mol buyumlari (consumables) uchun umumiy yordamchilar:
//   • vaqtli effektlar (XP boost / stealth / shield) — "hozir faolmi" va muddat uzaytirish
//   • trail revive — uzilgan trail nusxasini qisqa muddat saqlash
//
// Capture/anti-cheat mantiqiga aralashmaydi: bu yerdagi funksiyalar faqat o'qiydi yoki
// o'z xotira Map'ini boshqaradi. Revive nusxasi instance xotirasida (Redis rejimida ham) —
// o'yinchi socket'i shu instance'da bo'lgani uchun yetarli; instance qayta ishga tushsa
// nusxa yo'qoladi (token sarflanmaydi, chunki sarf faqat muvaffaqiyatli tiklashda).
const logger = require('../utils/logger');

// Uzilgan trailni tiklash oynasi va "ko'prik" chegarasi (suiiste'mol himoyasi):
// faqat yaqinda uzilgan va hozirgi joy uzilgan nuqtaga yaqin bo'lsa tiklanadi —
// aks holda revive shahar bo'ylab to'g'ri chiziq "sakrash"iga aylanardi.
const REVIVE_WINDOW_MS = 3 * 60 * 1000;
// Uzilish o'zi >30s va >60m siljishda yuzaga keladi (antiCheatService) — piyoda ~2 m/s bilan
// 2-3 daqiqada 150 m'dan oshib ketadi, shuning uchun ko'prik chegarasi 300 m.
const REVIVE_MAX_BRIDGE_M = 300;
const REVIVE_MIN_POINTS = 3;
const REVIVE_STORE_CAP = 10000;

const reviveSnapshots = new Map(); // userId -> { points: [[lat,lng],...], at }

function isActiveUntil(until, now = new Date()) {
  return !!(until && new Date(until) > now);
}

// Faol muddat ustiga qo'shamiz (2 marta olsa — 2 baravar uzun), tugagan bo'lsa hozirdan.
function extendUntil(currentUntil, durationMs, now = new Date()) {
  const base = isActiveUntil(currentUntil, now) ? new Date(currentUntil).getTime() : now.getTime();
  return new Date(base + durationMs);
}

// trailPromise — trailStore.getTrail(userId) natijasi (resetTrail'dan OLDIN chaqirilgan).
// Hot path'ni kutdirmaslik uchun await qilinmaydi; xato bo'lsa nusxa shunchaki yo'q.
// onSaved — nusxa saqlangach chaqiriladi (mijozga "tiklash mumkin" signali uchun).
function saveReviveSnapshot(userId, trailPromise, onSaved = null) {
  Promise.resolve(trailPromise)
    .then((points) => {
      if (!Array.isArray(points) || points.length < REVIVE_MIN_POINTS) return;
      if (reviveSnapshots.size >= REVIVE_STORE_CAP) sweepReviveSnapshots(Date.now());
      reviveSnapshots.set(userId, { points: points.map((p) => [p[0], p[1]]), at: Date.now() });
      if (onSaved) onSaved({ points: points.length, expiresInMs: REVIVE_WINDOW_MS });
    })
    .catch((err) => logger.warn('Revive snapshot failed', { userId, err: err.message }));
}

function getReviveSnapshot(userId, now = Date.now()) {
  const snap = reviveSnapshots.get(userId);
  if (!snap) return null;
  if (now - snap.at > REVIVE_WINDOW_MS) {
    reviveSnapshots.delete(userId);
    return null;
  }
  return snap;
}

function clearReviveSnapshot(userId) {
  reviveSnapshots.delete(userId);
}

function sweepReviveSnapshots(now) {
  for (const [uid, snap] of reviveSnapshots) {
    if (now - snap.at > REVIVE_WINDOW_MS) reviveSnapshots.delete(uid);
  }
}

module.exports = {
  REVIVE_WINDOW_MS,
  REVIVE_MAX_BRIDGE_M,
  isActiveUntil,
  extendUntil,
  saveReviveSnapshot,
  getReviveSnapshot,
  clearReviveSnapshot,
};
