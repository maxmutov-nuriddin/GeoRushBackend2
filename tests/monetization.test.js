// Monetizatsiya: consumable yordamchilari va konfiguratsiya yaxlitligi (DB talab qilmaydi).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const consumables = require('../src/services/consumableService');
const { CONSUMABLES, SHOP_ITEMS, getConsumableById } = require('../src/config/shopItems');
const { COIN_PACKS, XP_BOOST_MULT } = require('../src/config/tiers');

const HOUR = 60 * 60 * 1000;

describe('consumableService.isActiveUntil', () => {
  test('null va o\'tgan sana — faol emas', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    assert.equal(consumables.isActiveUntil(null, now), false);
    assert.equal(consumables.isActiveUntil(new Date('2026-10-28T09:59:59Z'), now), false);
  });

  test('kelajakdagi sana — faol', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    assert.equal(consumables.isActiveUntil('2026-10-28T10:00:01Z', now), true);
  });
});

describe('consumableService.extendUntil', () => {
  test('tugagan effekt hozirdan boshlanadi', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    const until = consumables.extendUntil(new Date('2026-10-27T00:00:00Z'), 2 * HOUR, now);
    assert.equal(until.toISOString(), '2026-10-28T12:00:00.000Z');
  });

  test('faol effekt ustiga qo\'shiladi (to\'planadi)', () => {
    const now = new Date('2026-10-28T10:00:00Z');
    const until = consumables.extendUntil(new Date('2026-10-28T11:00:00Z'), 2 * HOUR, now);
    assert.equal(until.toISOString(), '2026-10-28T13:00:00.000Z');
  });
});

describe('consumableService revive snapshot', () => {
  test('kam nuqtali trail saqlanmaydi', async () => {
    consumables.saveReviveSnapshot('u-short', Promise.resolve([[41, 69], [41.0001, 69]]));
    await new Promise((r) => setImmediate(r));
    assert.equal(consumables.getReviveSnapshot('u-short'), null);
  });

  test('saqlanadi, onSaved chaqiriladi va oyna tugagach yo\'qoladi', async () => {
    let saved = null;
    const pts = [[41, 69], [41.0001, 69], [41.0002, 69.0001]];
    consumables.saveReviveSnapshot('u-ok', Promise.resolve(pts), (info) => { saved = info; });
    await new Promise((r) => setImmediate(r));
    const snap = consumables.getReviveSnapshot('u-ok');
    assert.deepEqual(snap.points, pts);
    assert.equal(saved.points, 3);
    assert.equal(consumables.getReviveSnapshot('u-ok', Date.now() + consumables.REVIVE_WINDOW_MS + 1), null);
  });

  test('nusxa asl massivdan mustaqil (keyingi o\'zgarish ta\'sir qilmaydi)', async () => {
    const pts = [[1, 1], [2, 2], [3, 3]];
    consumables.saveReviveSnapshot('u-copy', Promise.resolve(pts));
    await new Promise((r) => setImmediate(r));
    pts.push([4, 4]);
    assert.equal(consumables.getReviveSnapshot('u-copy').points.length, 3);
    consumables.clearReviveSnapshot('u-copy');
    assert.equal(consumables.getReviveSnapshot('u-copy'), null);
  });
});

describe('monetizatsiya konfiguratsiyasi', () => {
  test('consumable id\'lari skin id\'lari bilan to\'qnashmaydi', () => {
    const skinIds = new Set(SHOP_ITEMS.map((i) => i.id));
    for (const c of CONSUMABLES) assert.equal(skinIds.has(c.id), false, c.id);
  });

  test('har consumable narxi musbat, vaqtli effektda davomiylik bor', () => {
    for (const c of CONSUMABLES) {
      assert.ok(c.price > 0, c.id);
      if (['shield', 'xpBoost', 'stealth'].includes(c.effect)) assert.ok(c.durationMs > 0, c.id);
    }
    assert.equal(getConsumableById('instant_shield_24h').needsTerritory, true);
    assert.equal(getConsumableById('nope'), null);
  });

  test('tanga paketlari: narx va coin musbat butun son, faqat starter bir martalik', () => {
    for (const [id, p] of Object.entries(COIN_PACKS)) {
      assert.ok(Number.isInteger(p.priceSom) && p.priceSom > 0, id);
      assert.ok(Number.isInteger(p.coins) && p.coins > 0, id);
    }
    const once = Object.entries(COIN_PACKS).filter(([, p]) => p.oncePerUser).map(([id]) => id);
    assert.deepEqual(once, ['starter_pack']);
  });

  test('XP booster multiplikatori 1 dan katta', () => {
    assert.ok(XP_BOOST_MULT > 1);
  });
});
