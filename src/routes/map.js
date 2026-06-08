const express = require('express');
const router = express.Router();

const MAP_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; overflow:hidden; background:#0a0a0f; }
#map { position:absolute; top:0; left:0; width:100%; height:100%; background:#0a0a0f; }
.leaflet-container { background:#0a0a0f !important; }
.leaflet-tile-pane { filter: brightness(0.45) invert(1) contrast(3) hue-rotate(195deg) saturate(0.3) brightness(0.72); }
.leaflet-control-zoom, .leaflet-control-attribution { display:none !important; }
.pin-popup .leaflet-popup-content-wrapper {
  background:transparent !important; border:none !important;
  box-shadow:none !important; padding:0 !important; border-radius:0 !important;
}
.pin-popup .leaflet-popup-content { margin:0 !important; padding:0 !important; }
.pin-popup .leaflet-popup-tip-container, .pin-popup .leaflet-popup-close-button { display:none !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map', { zoomControl:false, attributionControl:false, tap:false })
  .setView([41.2995, 69.2401], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom:19, subdomains:'abc'
}).addTo(map);

setTimeout(function(){ map.invalidateSize(false); }, 300);

var territoryLayers = [];
var trailLine = null;
var userMarker = null;
var playerMarkers = {};
var centered = false;
var _apiUrl = '';
var _token = '';
var _myId = '';
var _lastFetchLat = null;
var _lastFetchLng = null;

// ── Pin / Metka ──────────────────────────────────────────────────
var pinMode = false;
var pinMarkers = {};

function loadPins() {
  try { return JSON.parse(localStorage.getItem('georush_pins') || '[]'); } catch(e) { return []; }
}
function savePins(pins) {
  try { localStorage.setItem('georush_pins', JSON.stringify(pins)); } catch(e) {}
}
function notifyPinCount() {
  var count = loadPins().length;
  try { window.ReactNativeWebView.postMessage(JSON.stringify({ type:'pinCount', count:count })); } catch(e) {}
}
function makePinIcon() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="22" viewBox="0 0 16 22"><path d="M8 0C3.58 0 0 3.58 0 8c0 5.5 8 14 8 14S16 13.5 16 8C16 3.58 12.42 0 8 0z" fill="#00ff88" opacity="0.92"/><circle cx="8" cy="8" r="3.2" fill="#0a0a0f"/><\/svg>';
  return L.divIcon({ html:'<div style="filter:drop-shadow(0 2px 5px #00ff8899)">' + svg + '<\/div>', iconSize:[16,22], iconAnchor:[8,22], popupAnchor:[0,-24], className:'' });
}
function makePinPopup(pin) {
  return '<div style="background:rgba(10,10,20,0.97);border:1px solid rgba(0,255,136,0.22);border-radius:8px;padding:8px 10px;min-width:140px;font-family:sans-serif;">' +
    '<div id="pinlbl_' + pin.id + '" style="color:#f0f0f8;font-size:12px;font-weight:700;margin-bottom:7px;">' + pin.label + '<\/div>' +
    '<div style="display:flex;gap:5px;">' +
      '<button onclick="renamePinPrompt(' + pin.id + ')" style="flex:1;background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3);border-radius:5px;color:#00ff88;font-size:10px;font-weight:700;padding:4px 0;cursor:pointer;">✏ Nom<\/button>' +
      '<button onclick="removePin(' + pin.id + ')" style="flex:1;background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);border-radius:5px;color:#ff4444;font-size:10px;font-weight:700;padding:4px 0;cursor:pointer;">🗑 O\'chir<\/button>' +
    '<\/div>' +
    '<div style="color:rgba(255,255,255,0.3);font-size:9px;margin-top:5px;text-align:center;">' + pin.lat.toFixed(5) + ', ' + pin.lng.toFixed(5) + '<\/div>' +
  '<\/div>';
}
function addPinMarker(pin) {
  var m = L.marker([pin.lat, pin.lng], { icon: makePinIcon() }).addTo(map);
  m.bindPopup(makePinPopup(pin), { className:'pin-popup', closeButton:false, minWidth:140 });
  pinMarkers[pin.id] = m;
}
function removePin(id) {
  if (pinMarkers[id]) { map.removeLayer(pinMarkers[id]); delete pinMarkers[id]; }
  savePins(loadPins().filter(function(p){ return p.id !== id; }));
  notifyPinCount();
}
function renamePinPrompt(id) {
  var pins = loadPins();
  var pin = pins.find(function(p){ return p.id === id; });
  var current = pin ? pin.label : '';
  var newName = prompt('Metka nomi:', current);
  if (newName !== null && newName.trim()) {
    var label = newName.trim();
    savePins(pins.map(function(p){ return p.id===id ? Object.assign({},p,{label:label}) : p; }));
    var el = document.getElementById('pinlbl_' + id);
    if (el) el.textContent = label;
    if (pinMarkers[id]) pinMarkers[id].setPopupContent(makePinPopup(Object.assign({}, pin, {label:label})));
  }
}
map.on('click', function(e) {
  if (!pinMode) return;
  var pins = loadPins();
  var id = Date.now();
  var pin = { id:id, lat:e.latlng.lat, lng:e.latlng.lng, label:'Metka ' + (pins.length+1) };
  pins.push(pin);
  savePins(pins);
  addPinMarker(pin);
  notifyPinCount();
});
loadPins().forEach(function(p){ addPinMarker(p); });
// ── /Pin ─────────────────────────────────────────────────────────

function fetchTerritories(lat, lng) {
  if (!_apiUrl || !_token || !lat || !lng) return;
  _lastFetchLat = lat;
  _lastFetchLng = lng;
  var d = 0.3;
  var url = _apiUrl + '/api/territories?swLat=' + (lat-d) + '&swLng=' + (lng-d) + '&neLat=' + (lat+d) + '&neLng=' + (lng+d);
  fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + _token } })
  .then(function(r) { return r.json(); })
  .then(function(data) { renderTerritories(data.territories || []); })
  .catch(function() {});
}

function fetchTerritoriesIfNeeded(lat, lng) {
  if (_lastFetchLat === null) { fetchTerritories(lat, lng); return; }
  var dlat = lat - _lastFetchLat, dlng = lng - _lastFetchLng;
  if (Math.sqrt(dlat*dlat + dlng*dlng) > 0.0025) fetchTerritories(lat, lng);
}

function renderTerritories(terrs) {
  territoryLayers.forEach(function(l){ map.removeLayer(l); });
  territoryLayers = [];
  terrs.forEach(function(t) { addTerritoryLayers(t); });
}

function addTerritoryLayers(t) {
  var geom = t.geometry || t.polygon;
  if (geom && geom.type === 'Feature') geom = geom.geometry;
  if (!geom || !geom.coordinates) return;
  var coords = geom.coordinates[0].map(function(c){ return [c[1],c[0]]; });
  var owner = t.ownerId || t.ownerUserId || '';
  var isOwned = _myId && String(owner) === String(_myId);
  var color = t.color || '#00ff88';
  var glow = L.polygon(coords, {
    color:color, fillColor:'transparent', fillOpacity:0,
    weight:isOwned?14:6, opacity:isOwned?0.15:0.07, interactive:false,
  }).addTo(map);
  var poly = L.polygon(coords, {
    color:color, fillColor:color,
    fillOpacity:isOwned?0.28:0.1,
    weight:isOwned?1.5:0.8, opacity:isOwned?0.85:0.35,
    interactive:isOwned,
  }).addTo(map);
  if (isOwned) {
    var tid = t._id || t.id || '';
    var tname = t.name || '';
    poly.on('click', function() {
      try { window.ReactNativeWebView.postMessage(JSON.stringify({ type:'territoryTap', id:tid, name:tname, color:color })); } catch(e) {}
    });
    poly.bindTooltip(
      '<div style="font-size:11px;font-weight:700;color:' + color + ';">' + (tname || t.ownerUsername || 'Sizning hududingiz') + '<\/div>' +
      '<div style="font-size:9px;color:rgba(255,255,255,0.4);margin-top:2px;">Bosib nom o\'zgartiring<\/div>',
      { sticky:true, className:'pin-popup' }
    );
  }
  territoryLayers.push(glow, poly);
}

function handleMessage(raw) {
  try {
    var msg = JSON.parse(raw);
    if (msg.type === 'init') {
      _apiUrl = msg.apiUrl || ''; _token = msg.token || ''; _myId = msg.myId || '';
      _lastFetchLat = null;
      if (!centered && msg.lat) { map.setView([msg.lat, msg.lng], 17); centered = true; }
      map.invalidateSize(false);
      if (msg.lat && msg.lng) fetchTerritories(msg.lat, msg.lng);
    } else if (msg.type === 'updateLocation') {
      updateUserMarker(msg.lat, msg.lng, msg.color);
      if (!centered) { map.setView([msg.lat, msg.lng], 17); centered = true; }
      fetchTerritoriesIfNeeded(msg.lat, msg.lng);
    } else if (msg.type === 'addTerritory') {
      if (msg.territory) addTerritoryLayers(msg.territory);
    } else if (msg.type === 'updateTerritories') {
      renderTerritories(msg.territories || []);
    } else if (msg.type === 'updateTrail') {
      updateTrail(msg.trail);
    } else if (msg.type === 'updatePlayers') {
      updatePlayers(msg.players);
    } else if (msg.type === 'flyTo') {
      map.flyTo([msg.lat, msg.lng], 17, { duration:0.6 });
    } else if (msg.type === 'refreshTerritories') {
      if (_lastFetchLat !== null) fetchTerritories(_lastFetchLat, _lastFetchLng);
    } else if (msg.type === 'setPinMode') {
      pinMode = msg.active;
      map.getContainer().style.cursor = msg.active ? 'crosshair' : '';
    }
  } catch(e) {}
}

document.addEventListener('message', function(e){ handleMessage(e.data); });
window.addEventListener('message', function(e){ handleMessage(e.data); });

function updateUserMarker(lat, lng, color) {
  var c = color || '#00ff88';
  var html = '<div style="width:18px;height:18px;border-radius:50%;background:' + c + ';border:3px solid rgba(5,5,12,0.9);box-shadow:0 0 10px ' + c + ';"><\/div>';
  var icon = L.divIcon({ html:html, iconSize:[18,18], iconAnchor:[9,9], className:'' });
  if (!userMarker) { userMarker = L.marker([lat,lng], { icon:icon, zIndexOffset:1000 }).addTo(map); }
  else { userMarker.setLatLng([lat,lng]).setIcon(icon); }
}

function updateTrail(points) {
  if (trailLine) { map.removeLayer(trailLine); trailLine = null; }
  if (points && points.length > 1) {
    var lls = points.map(function(p){ return [p.latitude, p.longitude]; });
    trailLine = L.polyline(lls, {
      color:'#00ff88', weight:3, dashArray:'6,4', opacity:0.9, interactive:false,
    }).addTo(map);
  }
}

function updatePlayers(players) {
  Object.keys(playerMarkers).forEach(function(id) {
    if (!players[id]) { map.removeLayer(playerMarkers[id]); delete playerMarkers[id]; }
  });
  Object.keys(players).forEach(function(id) {
    var p = players[id];
    if (!p.lat) return;
    var c = p.color || '#888';
    var init = (p.username||'?')[0].toUpperCase();
    var html = '<div style="width:22px;height:22px;border-radius:50%;background:' + c + ';border:2px solid rgba(255,255,255,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#0a0a0f;font-family:sans-serif;">' + init + '<\/div>';
    var icon = L.divIcon({ html:html, iconSize:[22,22], iconAnchor:[11,11], className:'' });
    if (playerMarkers[id]) { playerMarkers[id].setLatLng([p.lat,p.lng]).setIcon(icon); }
    else { playerMarkers[id] = L.marker([p.lat,p.lng], { icon:icon }).addTo(map); }
  });
}
<\/script>
</body>
</html>`;

router.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(MAP_HTML);
});

module.exports = router;
