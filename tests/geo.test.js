// node --test tests/geo.test.js
// DB talab qilmaydi — sof funksiya testlari
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  haversineDistance,
  polygonAreaM2,
  simplifyPolygon,
  pointInPolygon,
} = require('../src/services/geoService');

describe('haversineDistance', () => {
  test('bir xil nuqta — masofa 0', () => {
    assert.strictEqual(haversineDistance(41.299, 69.240, 41.299, 69.240), 0);
  });

  test("Toshkent → Samarqand taxminan ~270 km", () => {
    const d = haversineDistance(41.299, 69.240, 39.654, 66.975);
    assert.ok(d > 260_000 && d < 290_000, `kutilgan 260-290 km, keldi ${Math.round(d / 1000)} km`);
  });

  test('kichik masofa — 100 m atrofida', () => {
    // 0.001° lat ≈ 111 m
    const d = haversineDistance(41.0, 69.0, 41.001, 69.0);
    assert.ok(d > 100 && d < 120, `kutilgan ~111 m, keldi ${Math.round(d)} m`);
  });
});

describe('polygonAreaM2', () => {
  test('3 nuqtadan kam — 0 qaytaradi', () => {
    assert.strictEqual(polygonAreaM2([[41, 69], [41.001, 69]]), 0);
  });

  test('taxminan kvadrat ~100x100 m ≈ 10,000 m²', () => {
    // 0.001° ≈ 111 m lat, 0.001° ≈ 85 m lng (41° da)
    const square = [
      [41.000, 69.000],
      [41.001, 69.000],
      [41.001, 69.001],
      [41.000, 69.001],
    ];
    const area = polygonAreaM2(square);
    assert.ok(area > 7_000 && area < 13_000, `kutilgan ~9000 m², keldi ${Math.round(area)} m²`);
  });

  test('katta polygon — 1 km²', () => {
    const big = [
      [41.000, 69.000],
      [41.009, 69.000],
      [41.009, 69.012],
      [41.000, 69.012],
    ];
    const area = polygonAreaM2(big);
    assert.ok(area > 500_000 && area < 2_000_000, `kutilgan ~1 km², keldi ${Math.round(area / 1000)} km²`);
  });
});

describe('pointInPolygon', () => {
  const box = [[0, 0], [0, 1], [1, 1], [1, 0]]; // [lat,lng]

  test('markazdagi nuqta — ichida', () => {
    assert.strictEqual(pointInPolygon(0.5, 0.5, box), true);
  });

  test('tashqaridagi nuqta — tashqarida', () => {
    assert.strictEqual(pointInPolygon(2, 2, box), false);
  });
});

describe('simplifyPolygon', () => {
  test('kam nuqtali polygon o\'zgarmaydi', () => {
    const pts = [[0,0],[1,0],[1,1],[0,1]];
    const result = simplifyPolygon(pts, 0.5);
    assert.ok(result.length >= 3, 'kamida 3 nuqta');
  });

  test('takroriy nuqtalar olib tashlanadi', () => {
    const pts = [[0,0],[0,0],[1,0],[1,0],[1,1],[0,1]];
    const result = simplifyPolygon(pts, 0.01);
    assert.ok(result.length <= pts.length, 'simplify nuqtalar sonini kamaytiradi');
  });
});
