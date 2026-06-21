// Strategik xarita uchun "kengayish tavsiyalari" — hududim chetidagi BO'SH yo'l bo'laklari.
// OSM (Overpass) yo'llarini oladi, faqat (a) hech kim egallamagan va (b) mening hududim
// chetiga yaqin (≤NEAR_M) bo'laklarni qaytaradi → tavsiya YO'L ustidan chiziladi (to'rtburchak emas).
// HECH QACHON throw qilmaydi: xato/timeout → null (chaqiruvchi to'r-fallback'iga o'tadi).
// buildingMaskService bilan bir xil pattern (fetch + bbox-kesh + qisqa timeout + graceful fallback).

// Bir nechta Overpass mirror — biri sekin/ishlamasa keyingisiga o'tamiz (public API beqaror).
// ENV OVERPASS_URL berilsa — birinchi bo'lib u sinaladi.
const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL,
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
].filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.ROAD_SUGGEST_TIMEOUT_MS || '7000', 10);
const CACHE_TTL_MS = parseInt(process.env.ROAD_SUGGEST_CACHE_TTL_MS || '600000', 10); // 10 daqiqa
const NEAR_M = parseInt(process.env.ROAD_SUGGEST_NEAR_M || '100', 10); // hudud chetiga yaqinlik
const MAX_WAYS = 250;        // Overpass javobidan ko'pi bilan shuncha yo'l
const MAX_SEGMENTS = 6;      // tavsiya bo'laklari soni
const MAX_PTS_PER_SEG = 12;  // har bo'lak nuqtalari (payload kichik bo'lsin)

const _cache = new Map(); // key -> { ts, roads: [[[lng,lat],...], ...] }

function _haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Nuqta poligon ichidami — ring [lng,lat] formatida.
function _pip(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

const _warming = new Set(); // fonda isitilayotgan bbox kalitlari (takror so'rovni oldini oladi)

// Overpass'dan yo'llarni TARMOQ orqali oladi (mirror'larni navbatma-navbat) va keshga yozadi.
async function _networkFetch(query, key) {
  for (const url of OVERPASS_ENDPOINTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': process.env.OVERPASS_USER_AGENT || 'GeoRush/1.0 (territory road suggest)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const roads = [];
      for (const el of json.elements || []) {
        if (roads.length >= MAX_WAYS) break;
        if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2) {
          roads.push(el.geometry.filter(p => p && typeof p.lon === 'number').map(p => [p.lon, p.lat]));
        }
      }
      _cache.set(key, { ts: Date.now(), roads });
      return roads;
    } catch (_) {
      // shu mirror sekin/abort/xato — keyingisini sinaymiz
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // hech bir mirror javob bermadi
}

// Kesh bo'sh bo'lsa:
//  - opts.maxWaitMs: tarmoqni shu vaqtgacha KUTAMIZ — Overpass tez javob bersa yo'llar DARHOL
//    chiqadi; sekin bo'lsa sahifa qotmasin uchun null qaytaramiz, lekin tarmoq fonda davom etib
//    keshlaydi (keyingi ochishda tayyor). Eng yaxshi kelishuv (tez + bloklanmaydi).
//  - opts.noWait: umuman kutmaymiz (faqat fonda isitamiz).
//  - hech biri yo'q: to'liq kutamiz (default).
async function _fetchRoads(bbox, opts = {}) {
  const { swLat: s, swLng: w, neLat: n, neLng: e } = bbox;
  const r = (v) => Math.round(v / 0.001) * 0.001;
  const key = `${r(s)},${r(w)},${r(n)},${r(e)}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.roads;

  // Yurish mumkin bo'lgan ko'cha/yo'lak turlari (avtomagistral emas).
  const query =
    `[out:json][timeout:20];` +
    `way["highway"~"^(residential|living_street|service|unclassified|tertiary|secondary|primary|footway|path|pedestrian|cycleway|track|steps)$"]` +
    `(${s},${w},${n},${e});out geom;`;

  // Bitta bbox uchun bitta tarmoq so'rovi (takrorni _warming guard oldini oladi).
  let net = null;
  if (!_warming.has(key)) {
    _warming.add(key);
    net = _networkFetch(query, key).catch(() => null).finally(() => _warming.delete(key));
  }

  if (opts.noWait) return null; // umuman kutmaymiz — fonda isiydi
  if (opts.maxWaitMs && net) {
    // Tarmoq vs timeout poygasi — qaysi avval bo'lsa. Timeout yutsa null (net fonda keshlaydi).
    const winner = await Promise.race([net, new Promise((res) => setTimeout(() => res('__timeout__'), opts.maxWaitMs))]);
    return winner === '__timeout__' ? null : (winner || null);
  }
  return net ? await net : null; // default: to'liq kutish (yoki allaqachon isiyapti → null)
}

// myRings/rivalRings: [ [ [lng,lat],... ], ... ]  (hudud tashqi halqalari)
// Qaytaradi: [{ line: [[lng,lat],...] }, ...]  yoki null (xato/bo'sh).
async function suggestRoadGaps(bbox, myRings, rivalRings, opts = {}) {
  if (!bbox || !Array.isArray(myRings) || !myRings.length) return null;
  const roads = await _fetchRoads(bbox, opts);
  if (!roads || !roads.length) return null;

  // Mening barcha tepalarim (yaqinlik tekshiruvi uchun) — soni cheklangan (soddalashtirilgan).
  const myVerts = [];
  for (const ring of myRings) for (const [lng, lat] of ring) myVerts.push([lat, lng]);

  const empty = (lat, lng) =>
    !myRings.some(r => _pip(lat, lng, r)) && !rivalRings.some(r => _pip(lat, lng, r));
  const nearMine = (lat, lng) => {
    for (const [vlat, vlng] of myVerts) if (_haversine(lat, lng, vlat, vlng) <= NEAR_M) return true;
    return false;
  };

  const segments = [];
  for (const road of roads) {
    let cur = [];
    for (const [lng, lat] of road) {
      if (empty(lat, lng) && nearMine(lat, lng)) {
        cur.push([lng, lat]);
      } else if (cur.length) {
        if (cur.length >= 2) segments.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) segments.push(cur);
  }
  if (!segments.length) return null;

  // Eng uzun bo'laklarni oldinga (eng foydali yo'nalishlar), MAX_SEGMENTS tagacha.
  const segLen = (seg) => {
    let d = 0;
    for (let i = 1; i < seg.length; i++) d += _haversine(seg[i - 1][1], seg[i - 1][0], seg[i][1], seg[i][0]);
    return d;
  };
  segments.sort((a, b) => segLen(b) - segLen(a));
  const top = segments.slice(0, MAX_SEGMENTS).filter(s => segLen(s) >= 15); // <15m bo'laklarni tashlaymiz

  // Har bo'lakni ≤MAX_PTS_PER_SEG nuqtaga siyraklashtiramiz (payload kichik).
  return top.map((seg) => {
    if (seg.length <= MAX_PTS_PER_SEG) return { line: seg };
    const step = Math.ceil(seg.length / MAX_PTS_PER_SEG);
    const line = seg.filter((_, i) => i % step === 0);
    if (line[line.length - 1] !== seg[seg.length - 1]) line.push(seg[seg.length - 1]);
    return { line };
  });
}

module.exports = { suggestRoadGaps };
