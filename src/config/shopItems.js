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
  { id: 'color_blush',    name: 'Pushti',        name_uz: 'Pushti',       type: 'color', value: '#FFB3C1', price: 140,  rarity: 'uncommon' },
  { id: 'color_lime',     name: 'Limon',         name_uz: 'Limon',        type: 'color', value: '#AEEA00', price: 140,  rarity: 'uncommon' },
  { id: 'color_lavender', name: 'Lavanda',       name_uz: 'Lavanda',      type: 'color', value: '#C77DFF', price: 240,  rarity: 'rare' },
  { id: 'color_bronze',   name: 'Bronza',        name_uz: 'Bronza',       type: 'color', value: '#CD7F32', price: 240,  rarity: 'rare' },
  { id: 'color_indigo',   name: 'Indigo',        name_uz: 'Indigo',       type: 'color', value: '#3D5AFE', price: 400,  rarity: 'epic' },
  { id: 'color_legend',   name: 'Afsonaviy',     name_uz: 'Afsonaviy',   type: 'color', value: '#F0C040', price: 900,  rarity: 'legendary' },
  { id: 'color_pearl',    name: 'Marvarid',      name_uz: 'Marvarid',     type: 'color', value: '#F5F5FF', price: 900,  rarity: 'legendary' },
  { id: 'color_spectrum', name: 'Spektr',        name_uz: 'Spektr',       type: 'color', value: '#FF00FF', price: 1000, rarity: 'legendary' },

  // ── MARKER USLUBLARI ─────────────────────────────────────────────────────────
  { id: 'marker_square',  name: 'Kvadrat',        name_uz: 'Kvadrat',      type: 'marker', value: 'square',  price: 60,   rarity: 'common' },
  { id: 'marker_hex',     name: 'Oltiburcha',    name_uz: 'Oltiburcha',   type: 'marker', value: 'hex',     price: 140,  rarity: 'uncommon' },
  { id: 'marker_triangle',name: 'Uchburchak',     name_uz: 'Uchburchak',   type: 'marker', value: 'triangle',price: 140,  rarity: 'uncommon' },
  { id: 'marker_star',    name: 'Yulduz',          name_uz: 'Yulduz',       type: 'marker', value: 'star',    price: 240,  rarity: 'rare' },
  { id: 'marker_shield',  name: 'Qalqon',          name_uz: 'Qalqon',       type: 'marker', value: 'shield',  price: 240,  rarity: 'rare' },
  { id: 'marker_crown',   name: 'Toj',             name_uz: 'Toj',          type: 'marker', value: 'crown',   price: 400,  rarity: 'epic' },
  { id: 'marker_octagon', name: 'Sakkizburchak',   name_uz: 'Sakkizburchak',type: 'marker', value: 'octagon', price: 400,  rarity: 'epic' },
  { id: 'marker_diamond', name: 'Olmos',           name_uz: 'Olmos',        type: 'marker', value: 'diamond', price: 900,  rarity: 'legendary' },

  // ── TRAIL USLUBLARI ──────────────────────────────────────────────────────────
  { id: 'trail_thick',   name: 'Qalin Iz',       name_uz: 'Qalin Iz',    type: 'trail', value: 'thick',   price: 140,  rarity: 'uncommon' },
  { id: 'trail_dotted',  name: 'Nuqtali Iz',     name_uz: 'Nuqtali Iz',  type: 'trail', value: 'dotted',  price: 140,  rarity: 'uncommon' },
  { id: 'trail_dashed',  name: 'Chiziqli Iz',    name_uz: 'Chiziqli Iz', type: 'trail', value: 'dashed',  price: 240,  rarity: 'rare' },
  { id: 'trail_bold',    name: 'Dadil Iz',       name_uz: 'Dadil Iz',    type: 'trail', value: 'bold',    price: 240,  rarity: 'rare' },
  { id: 'trail_glow',    name: 'Nurli Iz',        name_uz: 'Nurli Iz',    type: 'trail', value: 'glow',    price: 400,  rarity: 'epic' },

  // ── NIK BEZAKLARI ────────────────────────────────────────────────────────────
  // type:'nick' — reyting va profildagi ism uslubi. value = frontend nickStyles.js
  // xaritasidagi kalit (rang/nur/belgi). badge — ism oldiga qo'yiladigan belgi.
  { id: 'nick_ice',    name: 'Muzli Nik',    name_uz: 'Muzli Nik',    type: 'nick', value: 'ice',    price: 240,  rarity: 'rare' },
  { id: 'nick_shadow', name: 'Soyali Nik',   name_uz: 'Soyali Nik',   type: 'nick', value: 'shadow', price: 240,  rarity: 'rare' },
  { id: 'nick_neon',   name: 'Neon Nik',     name_uz: 'Neon Nik',     type: 'nick', value: 'neon',   price: 400,  rarity: 'epic' },
  { id: 'nick_toxic',  name: 'Zaharli Nik',  name_uz: 'Zaharli Nik',  type: 'nick', value: 'toxic',  price: 400,  rarity: 'epic' },
  { id: 'nick_ghost',  name: '👾 Alien Nik', name_uz: '👾 Alien Nik', type: 'nick', value: 'ghost',  price: 400,  rarity: 'epic',      badge: '👾' },
  { id: 'nick_gold',   name: 'Oltin Nik',    name_uz: 'Oltin Nik',    type: 'nick', value: 'gold',   price: 900,  rarity: 'legendary' },
  { id: 'nick_flame',  name: '🔥 Olov Nik',  name_uz: '🔥 Olov Nik',  type: 'nick', value: 'flame',  price: 900,  rarity: 'legendary', badge: '🔥' },
  { id: 'nick_crown',  name: '♛ Toj Nik',    name_uz: '♛ Toj Nik',    type: 'nick', value: 'crown',  price: 1000, rarity: 'legendary', badge: '♛' },
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

// ── ISTE'MOL BUYUMLARI (consumables) — skinlardan ALOHIDA ro'yxat ─────────────
// SHOP_ITEMS'ga qo'shilmaydi: eski mijozlar /shop/items'dagi har buyumni skin deb
// ko'rsatadi va /shop/buy ownedSkins'ga yozib yuborardi. Xarid — /shop/buy-consumable.
// effect: consumableController qaysi ustunni o'zgartirishini belgilaydi.
//   durationMs — vaqtli effekt (mavjud muddat ustiga QO'SHILADI, qayta yozilmaydi).
//   needsTerritory — xaridda o'z hududi (territoryId) tanlanishi shart.
const CONSUMABLES = [
  { id: 'instant_shield_24h', name: 'Shield 24 soat',   name_uz: 'Shield 24 soat',   type: 'consumable', effect: 'shield',  price: 250, durationMs: 24 * 60 * 60 * 1000, needsTerritory: true,  icon: '🛡️' },
  { id: 'trail_revive_token', name: 'Trail tiklash',    name_uz: 'Trail tiklash',    type: 'consumable', effect: 'revive',  price: 150, amount: 1,                                                     icon: '♻️' },
  { id: 'xp_boost_2h',        name: '2x XP (2 soat)',   name_uz: '2x XP (2 soat)',   type: 'consumable', effect: 'xpBoost', price: 200, durationMs: 2 * 60 * 60 * 1000,                                    icon: '⚡' },
  { id: 'stealth_mode_1h',    name: 'Ko\'rinmas (1 soat)', name_uz: 'Ko\'rinmas (1 soat)', type: 'consumable', effect: 'stealth', price: 300, durationMs: 60 * 60 * 1000,                                  icon: '👻' },
];

function getConsumableById(id) {
  return CONSUMABLES.find(i => i.id === id) || null;
}

module.exports = { SHOP_ITEMS, CONSUMABLES, RARITY_ORDER, RARITY_COLOR, RARITY_PRICE, getItemById, getConsumableById };
