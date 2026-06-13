const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine distance between two GPS points in meters
function haversineDistance(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Speed in m/s between two timestamped points
function calculateSpeed(lat1, lng1, t1, lat2, lng2, t2) {
  const distM = haversineDistance(lat1, lng1, lat2, lng2);
  const timeSec = (t2 - t1) / 1000;
  if (timeSec <= 0) return 0;
  return distM / timeSec;
}

// Polygon area in m² using the shoelace formula projected via equirectangular
function polygonAreaM2(points) {
  if (points.length < 3) return 0;
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = toRad(points[i][1]) * EARTH_RADIUS_M * Math.cos(toRad(points[i][0]));
    const yi = toRad(points[i][0]) * EARTH_RADIUS_M;
    const xj = toRad(points[j][1]) * EARTH_RADIUS_M * Math.cos(toRad(points[j][0]));
    const yj = toRad(points[j][0]) * EARTH_RADIUS_M;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area / 2);
}

// GeoJSON Polygon coordinates ([[ [lng,lat],... outer ], [ hole ],...]) yuzasi m²da —
// teshiklar (holes) AYIRILADI. polygonAreaM2 [lat,lng] kutadi, shuning uchun almashtiramiz.
function geojsonPolygonAreaM2(coords) {
  if (!Array.isArray(coords) || !coords[0]) return 0;
  const ringArea = (ring) => polygonAreaM2(ring.map(([lng, lat]) => [lat, lng]));
  let a = ringArea(coords[0]);
  for (let i = 1; i < coords.length; i++) a -= ringArea(coords[i]);
  return Math.max(0, a);
}

// polygon-clipping MultiPolygon natijasidan ENG KATTA yuzali bitta Polygonni qaytaradi
// (renderlar coordinates[0] — bitta tashqi halqa kutadi). Bo'sh bo'lsa null.
// Qaytaradi: { coordinates: [[lng,lat]...rings], area } yoki null.
function largestPolygonOf(multi) {
  if (!Array.isArray(multi) || multi.length === 0) return null;
  let best = null, bestArea = -1;
  for (const poly of multi) {
    if (!poly || !poly[0]) continue;
    const a = geojsonPolygonAreaM2(poly);
    if (a > bestArea) { bestArea = a; best = poly; }
  }
  if (!best) return null;
  return { coordinates: best, area: bestArea };
}

// JS geometrik ayirish (PostGIS yo'q bo'lganda): subject − Σ(clips).
// subjectCoords / clip elementlari — GeoJSON Polygon coordinates ([[ring],...]).
// Natija: { geoPolygon, area } (eng katta bo'lak) yoki null (bo'sh / hammasi kesildi).
function differenceGeomJS(subjectCoords, clipCoordsList) {
  try {
    const polygonClipping = require('polygon-clipping');
    const res = polygonClipping.difference(subjectCoords, ...clipCoordsList); // MultiPolygon
    const largest = largestPolygonOf(res);
    if (!largest) return null;
    return { geoPolygon: { type: 'Polygon', coordinates: largest.coordinates }, area: largest.area };
  } catch (_) {
    return null;
  }
}

// Check if two line segments (p1->p2) and (p3->p4) intersect
// Returns intersection point {lat, lng} or null
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = { x: p2[1] - p1[1], y: p2[0] - p1[0] };
  const d2 = { x: p4[1] - p3[1], y: p4[0] - p3[0] };

  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-10) return null; // parallel

  const dx = p3[1] - p1[1];
  const dy = p3[0] - p1[0];

  const t = (dx * d2.y - dy * d2.x) / cross;
  const u = (dx * d1.y - dy * d1.x) / cross;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [p1[0] + t * d1.y, p1[1] + t * d1.x];
  }
  return null;
}

// Detect if the trail has self-intersected; returns the closed polygon points or null
// Only checks the last segment against all non-adjacent prior segments
function detectClosedPolygon(trail) {
  const n = trail.length;
  if (n < 4) return null;

  const lastSeg = [trail[n - 2], trail[n - 1]];

  // Check last segment against all non-adjacent segments (skip last 2)
  for (let i = 0; i < n - 3; i++) {
    const seg = [trail[i], trail[i + 1]];
    const intersection = segmentsIntersect(lastSeg[0], lastSeg[1], seg[0], seg[1]);
    if (intersection) {
      // Polygon = intersection + trail[i+1..n-2] + intersection
      const polygon = [intersection, ...trail.slice(i + 1, n - 1), intersection];
      return polygon;
    }
  }
  return null;
}

// Convert polygon points array [[lat,lng],...] to WKT POLYGON string for PostGIS
function pointsToWKT(points) {
  // PostGIS uses (lng lat) order
  const coords = points.map(([lat, lng]) => `${lng} ${lat}`).join(', ');
  return `POLYGON((${coords}))`;
}

// Convert WKT/GeoJSON from PostGIS to [[lat,lng]] array
function wktToPoints(wkt) {
  const match = wkt.match(/POLYGON\(\((.+)\)\)/);
  if (!match) return [];
  return match[1].split(', ').map((pair) => {
    const [lng, lat] = pair.trim().split(' ').map(Number);
    return [lat, lng];
  });
}

// Point-in-polygon using ray casting — checks if [lat,lng] is inside polygon
function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][1], yi = polygon[i][0];
    const xj = polygon[j][1], yj = polygon[j][0];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Build a GeoJSON Feature from points
function toGeoJSONPolygon(points) {
  const coords = points.map(([lat, lng]) => [lng, lat]);
  if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
    coords.push(coords[0]);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: {},
  };
}

// Deterministik grid-sampling: oldGeoJSON hududining qancha qismi newPoints polygon bilan
// qoplanganini hisoblaydi (0..1). Avval Math.random ishlatilardi — bir xil capture har gal
// turlicha foiz berardi (invasion notification beqaror). Endi tekis grid → bir xil kirish
// har doim bir xil natija, va 2304 nuqta 300 tasodifiy nuqtadan aniqroq.
function estimateOverlapFraction(newPoints, oldGeoJSON) {
  const oldPoints = oldGeoJSON.coordinates[0].map(([lng, lat]) => [lat, lng]);

  const lats = oldPoints.map((p) => p[0]);
  const lngs = oldPoints.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  let insideOld = 0, insideBoth = 0;
  const GRID = 48; // 48 x 48 = 2304 nuqta
  for (let i = 0; i < GRID; i++) {
    // Har hujayra markazidan namuna olamiz (+0.5) — chekka artefaktlaridan qochish uchun
    const lat = minLat + ((i + 0.5) / GRID) * (maxLat - minLat);
    for (let j = 0; j < GRID; j++) {
      const lng = minLng + ((j + 0.5) / GRID) * (maxLng - minLng);
      if (pointInPolygon(lat, lng, oldPoints)) {
        insideOld++;
        if (pointInPolygon(lat, lng, newPoints)) insideBoth++;
      }
    }
  }
  if (insideOld < 20) return 0;
  return insideBoth / insideOld;
}

// Douglas-Peucker polygon simplification (degree-space tolerance)
function perpendicularDistanceDeg(p, a, b) {
  const dx = b[1] - a[1];
  const dy = b[0] - a[0];
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag < 1e-12) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
  return Math.abs(dy * p[1] - dx * p[0] + b[1] * a[0] - b[0] * a[1]) / mag;
}

function _dpReduce(pts, tolerance, start, end, keep) {
  if (end <= start + 1) return;
  let maxDist = 0, maxIdx = start + 1;
  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistanceDeg(pts[i], pts[start], pts[end]);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    keep[maxIdx] = true;
    _dpReduce(pts, tolerance, start, maxIdx, keep);
    _dpReduce(pts, tolerance, maxIdx, end, keep);
  }
}

function simplifyPolygon(points, tolerance) {
  if (points.length <= 4) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  _dpReduce(points, tolerance, 0, points.length - 1, keep);
  return points.filter((_, i) => keep[i]);
}

module.exports = {
  haversineDistance,
  calculateSpeed,
  polygonAreaM2,
  geojsonPolygonAreaM2,
  largestPolygonOf,
  differenceGeomJS,
  simplifyPolygon,
  segmentsIntersect,
  detectClosedPolygon,
  pointsToWKT,
  wktToPoints,
  pointInPolygon,
  toGeoJSONPolygon,
  estimateOverlapFraction,
};
