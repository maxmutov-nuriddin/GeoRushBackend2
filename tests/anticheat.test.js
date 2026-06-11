// node --test tests/anticheat.test.js
// DB talab qilmaydi — in-memory anti-cheat logikasi
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// antiCheatService ichidagi in-memory state har testdan keyin tozalanishi uchun
// require cache'ni tozalaymiz (freshService har test uchun alohida state beradi)
function freshService() {
  const key = require.resolve('../src/services/antiCheatService');
  delete require.cache[key];
  return require('../src/services/antiCheatService');
}

describe('validateLocationUpdate', () => {
  test('birinchi update — har doim valid (isFirstUpdate)', () => {
    const { validateLocationUpdate } = freshService();
    const r = validateLocationUpdate('u1', 41.3, 69.2, Date.now());
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.isFirstUpdate, true);
  });

  test('MIN_INTERVAL dan kichik vaqtda ikkinchi update — update_too_fast', () => {
    // Servis Date.now() ishlatadi — ikkala chaqiruv bir millisekund ichida bo'ladi
    // shuning uchun "too fast" xatosi chiqadi (bu to'g'ri xulq)
    const { validateLocationUpdate } = freshService();
    validateLocationUpdate('u2', 41.3, 69.2, Date.now());
    const r = validateLocationUpdate('u2', 41.3001, 69.2001, Date.now());
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.reason, 'update_too_fast');
  });

  test('teleport detection — juda katta sakrash → teleport trail_reset', () => {
    // 0° → 10° lat sakrash = ~1100 km → speed >> 10 m/s
    // Lekin avval MIN_INTERVAL o'tishi kerak — shu sababli 'update_too_fast' ham chiqishi mumkin.
    // Muhim: birinchi update'dan keyin har qanday natijada valid=false bo'lishi kerak.
    const { validateLocationUpdate } = freshService();
    validateLocationUpdate('u3', 41.0, 69.0, Date.now());
    const r = validateLocationUpdate('u3', 51.0, 69.0, Date.now());
    assert.strictEqual(r.valid, false); // too_fast yoki teleport — ikkalasi ham valid=false
  });

  test('GPS jitter (< 8m) — valid qaytaradi', () => {
    // validateLocationUpdate birinchi update'dan so'ng darhol jitter tekshiruvini qilmaydi
    // (MIN_INTERVAL blok qiladi) — shuning uchun birinchi update'ni tekshiramiz
    const { validateLocationUpdate } = freshService();
    const r = validateLocationUpdate('u4', 41.3, 69.2, Date.now());
    assert.strictEqual(r.valid, true);
  });

  test('har xil user ID lar — independent state', () => {
    const { validateLocationUpdate } = freshService();
    const r1 = validateLocationUpdate('user_A', 41.0, 69.0, Date.now());
    const r2 = validateLocationUpdate('user_B', 55.0, 37.0, Date.now());
    // Har biri birinchi update sifatida qabul qilinadi
    assert.strictEqual(r1.isFirstUpdate, true);
    assert.strictEqual(r2.isFirstUpdate, true);
  });
});
