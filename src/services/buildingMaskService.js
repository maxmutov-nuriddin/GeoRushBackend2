// ─────────────────────────────────────────────────────────────────────────────
// BINO NIQOBI (building mask) — "yo'lak/uylarni sezish"
// Egallangan hudud poligonidan OSM bino konturlarini AYIRADI. Eng muhimi: hududning
// TASHQI chegarasiga chiqib qolgan (yurgan yo'ldan tashqaridagi) bino qismi kesiladi →
// chegara uy/yo'lak bo'yicha bukiladi, uy ustiga CHIQMAYDI. Bu render'da KO'RINADI
// (tashqi halqa o'zgaradi). Ichki (to'liq hudud ichidagi) binolar teshik bo'ladi —
// ular render'da ko'rinmaydi, lekin maydon/mukofotni kamaytiradi (halol).
//
// EHTIYOTKORLIK (production'ni buzmaslik):
//  • Env-flag bilan o'chiriladi: BUILDING_MASK_ENABLED=false → darhol eski xulq.
//  • Har qanday xato / timeout / bo'sh javob → ASL poligonni qaytaradi (egallash YIQILMAYDI).
//  • Qisqa timeout (AbortController) + bbox bo'yicha xotira kesh + bbox/bino soni cheklovlari.
//  • Yangi npm paket SHART EMAS: global fetch (Node 18+) + mavjud polygon-clipping.
// ─────────────────────────────────────────────────────────────────────────────
const { differenceGeomJS, largestPolygonOf, geojsonPolygonAreaM2 } = require('./geoService');
const turfBuffer = require('@turf/buffer').default || require('@turf/buffer');
const { polygon: turfPolygon, multiPolygon: turfMultiPolygon } = require('@turf/helpers');

// Default O'CHIQ (2026-06-22): "yurgan yo'l = chegara, ichi to'liq to'ladi" modeliga ziddir
// edi — uy atrofidan to'liq yurilsa ham binoni kesib teshik qoldirardi. Egallash endi aynan
// yurib o'rab olingan SOLID maydon. Qayta yoqish: BUILDING_MASK_ENABLED=true.
const ENABLED = String(process.env.BUILDING_MASK_ENABLED || 'false').toLowerCase() === 'true';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const TIMEOUT_MS = parseInt(process.env.BUILDING_MASK_TIMEOUT_MS || '3500', 10);
const CACHE_TTL_MS = parseInt(process.env.BUILDING_MASK_CACHE_TTL_MS || '600000', 10); // 10 daqiqa
const BBOX_PAD_DEG = 0.0008;        // ~80m havo — chekka binolarni ham qamrash uchun
const MAX_BBOX_DEG = 0.06;          // ~6.5km — juda katta so'rovni rad et (himoya)
const MAX_BUILDINGS = 600;          // polygon-clipping og'ir bo'lmasligi uchun cheklov
// Bino ayirilgach hosil bo'lgan o'tkir/ingichka "tirnoq"larni silliqlaydigan radius (metr).
// Morfologik "close" (shishir +R → qaytar −R): ~2×SMOOTH_M dan TOR tirnoqlar to'ladi,
// asl katta bino kesimlari va tashqi chegara deyarli o'zgarmaydi. 0 → silliqlash o'chiq.
const SMOOTH_M = parseFloat(process.env.BUILDING_MASK_SMOOTH_M || '5');

// bbox (yumaloqlangan) bo'yicha oddiy xotira kesh — qisqa muddatli, jarayon umri davomida.
const _cache = new Map(); // key -> { ts, clips: [GeoJSON Polygon coords...] }

function _bboxOf(ring) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lng, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, minLng, maxLat, maxLng };
}

// Overpass element'laridan bino tashqi halqalarini GeoJSON Polygon coordinates'ga aylantirish.
function _ringsFromElements(elements) {
  const clips = [];
  const pushRing = (geometry) => {
    if (!Array.isArray(geometry) || geometry.length < 3) return;
    const ring = geometry
      .filter(p => p && typeof p.lon === 'number' && typeof p.lat === 'number')
      .map(p => [p.lon, p.lat]);
    if (ring.length < 3) return;
    // Halqani yopish (GeoJSON talabi)
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    if (ring.length < 4) return;
    clips.push([ring]); // GeoJSON Polygon coords: [ [ring] ]
  };
  for (const el of elements) {
    if (clips.length >= MAX_BUILDINGS) break;
    if (el.type === 'way' && el.geometry) {
      pushRing(el.geometry);
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const m of el.members) {
        if (m && m.type === 'way' && (m.role === 'outer' || !m.role) && m.geometry) {
          pushRing(m.geometry);
          if (clips.length >= MAX_BUILDINGS) break;
        }
      }
    }
  }
  return clips;
}

async function _fetchBuildings(bbox) {
  const s = bbox.minLat - BBOX_PAD_DEG;
  const w = bbox.minLng - BBOX_PAD_DEG;
  const n = bbox.maxLat + BBOX_PAD_DEG;
  const e = bbox.maxLng + BBOX_PAD_DEG;

  // Kesh kaliti: ~110m to'rga yumaloqlangan bbox (qo'shni egallashlar keshdan foydalanadi)
  const r = (v) => Math.round(v / 0.001) * 0.001;
  const key = `${r(s)},${r(w)},${r(n)},${r(e)}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.clips;

  const query =
    `[out:json][timeout:20];(` +
    `way["building"](${s},${w},${n},${e});` +
    `relation["building"](${s},${w},${n},${e});` +
    `);out geom;`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass User-Agent talab qiladi (aks holda 406/429). Aniq ilova nomi.
        'User-Agent': process.env.OVERPASS_USER_AGENT || 'GeoRush/1.0 (territory building mask)',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const clips = _ringsFromElements(json.elements || []);
    _cache.set(key, { ts: Date.now(), clips });
    return clips;
  } catch (_) {
    return null; // timeout / tarmoq xatosi → niqobsiz davom etadi
  } finally {
    clearTimeout(timer);
  }
}

// Morfologik "close" (shishir +R → qaytar −R) — bino ayirilgach hosil bo'lgan o'tkir/ingichka
// tirnoqlarni TO'LDIRADI (GPS shovqini va uy chetiga tegib o'tish artefaktlari), lekin tashqi
// chegara va katta bino kesimlarini saqlaydi. Mayda ichki bino teshiklari ham yo'qoladi (toza
// kontur). HECH QACHON throw qilmaydi — xato/bo'sh natija bo'lsa asl coords'ni qaytaradi.
function _smoothNotches(coords) {
  try {
    if (!(SMOOTH_M > 0) || !Array.isArray(coords) || !coords[0]) return coords;
    const km = SMOOTH_M / 1000;
    const feat = turfPolygon(coords);
    const inflated = turfBuffer(feat, km, { units: 'kilometers' });        // +R: tirnoqlarni to'ldiradi
    if (!inflated || !inflated.geometry) return coords;
    const closed = turfBuffer(inflated, -km, { units: 'kilometers' });      // −R: tashqarini asliga qaytaradi
    if (!closed || !closed.geometry) return coords;
    let multi;
    if (closed.geometry.type === 'Polygon') multi = [closed.geometry.coordinates];
    else if (closed.geometry.type === 'MultiPolygon') multi = closed.geometry.coordinates;
    else return coords;
    const largest = largestPolygonOf(multi);
    if (!largest || !largest.coordinates || !largest.coordinates[0]) return coords;
    return largest.coordinates;
  } catch (_) {
    return coords; // silliqlash xatosi → silliqlanmagan (lekin to'g'ri) kontur
  }
}

// Egallangan poligon (GeoJSON Polygon coordinates [[ring],...]) dan binolarni ayiradi.
// Qaytaradi: { coordinates, area } (niqoblangan) YOKI null (o'zgarish yo'q → chaqiruvchi
// asl poligondan foydalanadi). HECH QACHON throw qilmaydi.
async function maskBuildingsFromPolygon(geoPolygonCoords) {
  try {
    if (!ENABLED) return null;
    if (!Array.isArray(geoPolygonCoords) || !geoPolygonCoords[0]) return null;

    const bbox = _bboxOf(geoPolygonCoords[0]);
    if (!isFinite(bbox.minLat)) return null;
    if ((bbox.maxLat - bbox.minLat) > MAX_BBOX_DEG || (bbox.maxLng - bbox.minLng) > MAX_BBOX_DEG) {
      return null; // juda katta hudud — Overpass'ni yuklamaymiz
    }

    const clips = await _fetchBuildings(bbox);
    if (!clips || clips.length === 0) return null; // bino yo'q / xato → o'zgarishsiz

    const diff = differenceGeomJS(geoPolygonCoords, clips);
    if (!diff || !diff.geoPolygon || !diff.geoPolygon.coordinates) return null;

    // Bino ayirilgach hosil bo'lgan o'tkir tirnoqlarni silliqlaymiz (yo'lni his qilish saqlanadi,
    // lekin rasmdagi ingichka kesilishlar yo'qoladi). Silliqlash o'chiq/xato → diff coords'i.
    const smoothed = _smoothNotches(diff.geoPolygon.coordinates);
    if (smoothed === diff.geoPolygon.coordinates) {
      return { coordinates: diff.geoPolygon.coordinates, area: diff.area };
    }
    return { coordinates: smoothed, area: geojsonPolygonAreaM2(smoothed) };
  } catch (_) {
    return null; // har qanday kutilmagan xato → asl poligon
  }
}

module.exports = { maskBuildingsFromPolygon, ENABLED };
