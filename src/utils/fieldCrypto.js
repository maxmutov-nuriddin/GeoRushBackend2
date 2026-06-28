// ─── PII maydon-shifrlash (field-level encryption) ───────────────────────────
// Maqsad: baza to'liq sizib chiqsa ham telefon/joylashuv/telegram kabi shaxsiy
// ma'lumotlar foydasiz (shifrli) bo'lsin. Parollar allaqachon bcrypt bilan himoyalangan.
//
// Ikki rejim:
//   • encDet  — DETERMINISTIK (bir xil kirish → bir xil chiqish). Qidiriladigan
//               maydonlar uchun (phone, telegramChatId, email): `where`/`@unique`
//               ishlashda davom etadi. Sintetik IV = HMAC(plaintext) → GCM nonce
//               takrorlanmaydi (har xil qiymat → har xil IV).
//   • encRand — TASODIFIY (har safar boshqa chiqish). Qidirilmaydigan maydonlar
//               uchun (lastLocation) — eng kuchli.
//
// Orqaga moslik: dec() prefiksi yo'q (eski plaintext) qiymatni o'zgartirmay qaytaradi,
// shuning uchun migration'dan OLDIN ham tizim ishlaydi. ENCRYPTION_KEY qo'yilmasa —
// passthrough rejim (hech narsa shifrlanmaydi, lekin hech narsa buzilmaydi).

const crypto = require('crypto');
const logger = require('./logger');

const RAW = process.env.ENCRYPTION_KEY || '';
let MASTER = null;
if (/^[0-9a-fA-F]{64}$/.test(RAW)) {
  MASTER = Buffer.from(RAW, 'hex');           // 64 hex = 32 bayt (tavsiya etilgan format)
} else if (RAW) {
  MASTER = crypto.createHash('sha256').update(RAW).digest(); // boshqa formatni 32 baytga keltiramiz
}

const ENABLED = !!MASTER;
if (!ENABLED) {
  logger.warn('[fieldCrypto] ENCRYPTION_KEY topilmadi — PII shifrlanmaydi (passthrough). '
    + 'Render env\'ga 64-belgili hex kalit qo\'ying.');
}

// Asosiy kalitdan ikki sub-kalit (shifrlash + HMAC) hosil qilamiz — bir maqsadli kalit qoidasi.
const ENC_KEY = ENABLED ? crypto.createHash('sha256').update(Buffer.concat([MASTER, Buffer.from('enc')])).digest() : null;
const MAC_KEY = ENABLED ? crypto.createHash('sha256').update(Buffer.concat([MASTER, Buffer.from('mac')])).digest() : null;

function isEncrypted(v) {
  return typeof v === 'string' && (v.startsWith('e1:') || v.startsWith('r1:'));
}

function _seal(prefix, plaintext, iv) {
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${prefix}:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

// Deterministik — qidiriladigan maydonlar (phone, telegramChatId, email)
function encDet(plaintext) {
  if (!ENABLED || plaintext == null || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;            // ikki marta shifrlamaymiz
  const iv = crypto.createHmac('sha256', MAC_KEY).update(String(plaintext)).digest().subarray(0, 12);
  return _seal('e1', plaintext, iv);
}

// Tasodifiy — qidirilmaydigan maydonlar (lastLocation)
function encRand(plaintext) {
  if (!ENABLED || plaintext == null || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  return _seal('r1', plaintext, crypto.randomBytes(12));
}

// Ochish — prefiks bo'lmasa (eski plaintext/null) o'zini qaytaradi
function dec(value) {
  if (!isEncrypted(value)) return value;
  if (!ENABLED) return value;                              // kalit yo'q — ocholmaymiz
  try {
    const [, ivB, ctB, tagB] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    logger.error('[fieldCrypto] dec xato:', e.message);
    return null;
  }
}

// lastLocation (GeoJSON obyekt) — JSON sifatida tasodifiy shifrlash
function encLocation(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return encRand(obj);
  return encRand(JSON.stringify(obj));
}
function decLocation(value) {
  if (value == null) return value;
  if (typeof value === 'object') return value;            // eski xom obyekt
  const raw = dec(value);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  ENABLED, isEncrypted, dec,
  encDet, encRand, encLocation, decLocation,
  // semantik yordamchilar (hammasi deterministik):
  encPhone: encDet, encTelegram: encDet, encEmail: encDet,
};
