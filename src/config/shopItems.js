// GeoRush Shop Catalog — server-side hayot manbai
// type: 'color' | 'marker' | 'trail'
// rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
//
// NARX ZINAPOYASI (2026-06-22 balans) — narx FAQAT noyoblikka (rarity) bog'liq,
// kategoriyaga (color/marker/trail) emas. Shu sababli bir xil rarity'dagi har qanday
// buyum bir xil narxda turadi → adolatli va tushunarli. (Avval marker/trail ranglardan
// nomutanosib qimmat edi: legendary marker 800 < legendary rang 900, epic crown 600.)
//   common 60 · uncommon 140 · rare 240 · epic 400 · legendary 900
//   spectrum (kamalak) — yagona flagman 1000.
// Diapazon 60–1000, o'rtacha ~320 — otpBot.js iqtisod izohi bilan mos.

const RARITY_PRICE = { common: 60, uncommon: 140, rare: 240, epic: 400, legendary: 900 };

const SHOP_ITEMS = [
  // ── RANGLAR ─────────────────────────────────────────────────────────────────
  { id: 'color_silver',   name: 'Kumush',      name_uz: 'Kumush',       type: 'color', value: '#C0C0C0', price: 60,   rarity: 'common' },
  { id: 'color_ice',      name: 'Muz',          name_uz: 'Muz',          type: 'color', value: '#00E5FF', price: 60,   rarity: 'common' },
  { id: 'color_mint',     name: 'Yashil',       name_uz: 'Yashil',       type: 'color', value: '#00BFA5', price: 60,   rarity: 'common' },
  { id: 'color_sunset',   name: "G'urub",       name_uz: "G'urub",       type: 'color', value: '#FF7043', price: 140,  rarity: 'uncommon' },
  { id: 'color_ocean',    name: 'Okean',         name_uz: 'Okean',        type: 'color', value: '#0277BD', price: 140,  rarity: 'uncommon' },
  { id: 'color_fire',     name: "O't",           name_uz: "O't",          type: 'color', value: '#FF6B00', price: 140,  rarity: 'uncommon' },
  { id: 'color_ruby',     name: 'Yoqut',         name_uz: 'Yoqut',        type: 'color', value: '#E91E63', price: 240,  rarity: 'rare' },
  { id: 'color_gold',     name: 'Oltin',         name_uz: 'Oltin',        type: 'color', value: '#FFC107', price: 240,  rarity: 'rare' },
  { id: 'color_neon',     name: 'Neon Pushti',   name_uz: 'Neon Pushti',  type: 'color', value: '#FF0099', price: 240,  rarity: 'rare' },
  { id: 'color_galaxy',   name: 'Galaktika',     name_uz: 'Galaktika',    type: 'color', value: '#7B2FBE', price: 400,  rarity: 'epic' },
  { id: 'color_cyber',    name: 'Kiber',         name_uz: 'Kiber',        type: 'color', value: '#00FF41', price: 400,  rarity: 'epic' },
  { id: 'color_crimson',  name: 'Qizil Olov',    name_uz: 'Qizil Olov',  type: 'color', value: '#DC143C', price: 400,  rarity: 'epic' },
  { id: 'color_legend',   name: 'Afsonaviy',     name_uz: 'Afsonaviy',   type: 'color', value: '#F0C040', price: 900,  rarity: 'legendary' },
  { id: 'color_spectrum', name: 'Spektr',        name_uz: 'Spektr',       type: 'color', value: '#FF00FF', price: 1000, rarity: 'legendary' },

  // ── MARKER USLUBLARI ─────────────────────────────────────────────────────────
  { id: 'marker_square', name: 'Kvadrat',        name_uz: 'Kvadrat',      type: 'marker', value: 'square', price: 60,   rarity: 'common' },
  { id: 'marker_hex',    name: 'Oltiburcha',    name_uz: 'Oltiburcha',   type: 'marker', value: 'hex',    price: 140,  rarity: 'uncommon' },
  { id: 'marker_star',   name: 'Yulduz',          name_uz: 'Yulduz',       type: 'marker', value: 'star',   price: 240,  rarity: 'rare' },
  { id: 'marker_crown',  name: 'Toj',             name_uz: 'Toj',          type: 'marker', value: 'crown',  price: 400,  rarity: 'epic' },
  { id: 'marker_diamond',name: 'Olmos',           name_uz: 'Olmos',        type: 'marker', value: 'diamond',price: 900,  rarity: 'legendary' },

  // ── TRAIL USLUBLARI ──────────────────────────────────────────────────────────
  { id: 'trail_thick',   name: 'Qalin Iz',       name_uz: 'Qalin Iz',    type: 'trail', value: 'thick',   price: 140,  rarity: 'uncommon' },
  { id: 'trail_dashed',  name: 'Chiziqli Iz',    name_uz: 'Chiziqli Iz', type: 'trail', value: 'dashed',  price: 240,  rarity: 'rare' },
  { id: 'trail_glow',    name: 'Nurli Iz',        name_uz: 'Nurli Iz',    type: 'trail', value: 'glow',    price: 400,  rarity: 'epic' },
];

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

const RARITY_COLOR = {
  common:    '#9E9E9E',
  uncommon:  '#4CAF50',
  rare:      '#2196F3',
  epic:      '#9C27B0',
  legendary: '#FF9800',
};

function getItemById(id) {
  return SHOP_ITEMS.find(i => i.id === id) || null;
}

module.exports = { SHOP_ITEMS, RARITY_ORDER, RARITY_COLOR, RARITY_PRICE, getItemById };
