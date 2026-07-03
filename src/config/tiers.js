// ─── Premium pog'onalari (Free / Pro / Ultra) — yagona manba ─────────────────
// Butun ilovadagi limit, multiplikator va flaglar shu yerda. Boshqa joylar shuni o'qiydi.
// Cheksiz qiymatlar Infinity bilan beriladi; JSON uchun entitlementsPublic() null ga aylantiradi.

const TIERS = {
  free: {
    key: 'free',
    teamCreate: false,
    teamMaxMembers: 0,        // o'zi jamoa egasi bo'la olmaydi
    territoryLimit: 3,
    pathLimit: 2000,          // bitta startда saqlanadigan yo'l nuqtalari (rolling buffer); ~30km perimetr
    expandLimit: 5,           // hisob bo'yicha jami kengaytirish (merge) soni; coin bilan oshiriladi (2026-06-22: 2→5 jalb uchun)
    maxPurchasedSlots: 1,     // coin bilan olinadigan qo'shimcha hudud slotlari chegarasi
    shieldMargin: null,       // null = himoya yo'q
    integrations: false,
    notifications: 'none',    // 'none' | 'attack' | 'realtime'
    stats: 'basic',           // 'basic' | 'weekly' | 'heatmap'
    leaderboard: 'top50',     // 'top50' | 'city' | 'global'
    territoryName: false,
    territoryEmoji: false,
    historyDays: 0,           // 0 = yo'q, Infinity = cheksiz
    xpMult: 1,
    coinMult: 1,
    welcomeCoins: 0,
    dailyCoins: 15,
    freeSkins: false,
    badge: null,              // null | 'premium' | 'elite'
    price: 0,
  },
  pro: {
    key: 'pro',
    teamCreate: true,
    teamMaxMembers: 4,        // ega + 3 qo'shiladi
    territoryLimit: 10,       // 15→10 (2026-06-22 balans): tiniqroq zinapoya 3→10→∞, Ultra qiymati oshadi
    pathLimit: 6000,          // bitta startда saqlanadigan yo'l nuqtalari (~90km perimetr); Free'ning 3×
    expandLimit: 15,          // hisob bo'yicha jami kengaytirish; coin bilan oshiriladi (2026-06-22: 7→15, Free'ning 3×)
    maxPurchasedSlots: 2,     // coin bilan olinadigan qo'shimcha hudud slotlari chegarasi
    shieldMargin: 5,          // attacker.level < owner.level - 5 bo'lsa himoyalanadi
    integrations: true,
    notifications: 'attack',
    stats: 'weekly',
    leaderboard: 'city',
    territoryName: false,    // hudud nomi faqat Ultra'da
    territoryEmoji: false,
    historyDays: 7,
    xpMult: 1.25,
    coinMult: 1.25,
    welcomeCoins: 1000,   // 2500→1000 (2026-06-22 balans): boshlang'ich bonus, lekin hammasini
                          // darhol bermaydi → grind/maqsad qoladi; ongoing 1.5x coinMult+2x XP qiymat beradi
    dailyCoins: 15,
    freeSkins: false,
    badge: 'premium',
    price: 39900,
  },
  ultra: {
    key: 'ultra',
    teamCreate: true,
    teamMaxMembers: Infinity,
    territoryLimit: Infinity,
    pathLimit: 10000,         // bitta startда saqlanadigan yo'l nuqtalari (~150km perimetr); render xavfsiz zonada
    expandLimit: Infinity,    // Ultra — cheksiz kengaytirish
    maxPurchasedSlots: 0,     // Ultra allaqachon cheksiz — slot sotib olish kerak emas
    shieldMargin: 0,          // qat'iy: pastdagilar umuman ololmaydi
    integrations: true,
    notifications: 'realtime',
    stats: 'heatmap',
    leaderboard: 'global',
    territoryName: true,
    territoryEmoji: true,
    historyDays: Infinity,
    xpMult: 1.5,
    coinMult: 1.5,
    welcomeCoins: 2500,   // 7500→2500 (2026-06-22 balans): avval ~barcha skinni darhol olardi
                          // (grind yo'q → zerikish); endi legendary+qo'shimcha, ongoing 2x coin+3x XP
    dailyCoins: 30,
    // 2026-07-03: Ultra ham skinlarni COIN'ga sotib oladi (coin qadri/sink uchun).
    // Shop'dagi owned/free/equip tekshiruvlari shu bayroqdan o'qiydi — flip yetarli.
    freeSkins: false,
    badge: 'elite',
    price: 79900,
  },
};

const TIER_KEYS = ['free', 'pro', 'ultra'];
const PAID_TIER_KEYS = ['pro', 'ultra'];

// ── Hudud iqtisodi (GeoCoin sink) — oson sozlanadigan narxlar ────────────────
// Slot = DOIMIY +1 hudud (qimmat, kuchli). Kengaytirish = ISTE'MOL to'plami (sarflanadi).
const TERRITORY_SLOT_PRICE = 3000;                  // doimiy +1 hudud sloti (coin)
const EXPANSION_PACK = { amount: 3, price: 600 };   // +3 kengaytirish (iste'mol, coin)
const TEAM_CREATE_PRICE = 5000;                     // Free: coin bilan jamoa yaratish huquqi (qimmat)
const PURCHASED_TEAM_MAX_MEMBERS = 4;               // coin bilan ochilgan jamoa a'zo chegarasi (Pro kabi)

function isActivePremium(u) {
  return !!(u && u.isPremium && u.premiumUntil && new Date() < new Date(u.premiumUntil));
}

// Foydalanuvchining joriy tier kaliti.
// Premium faol → premiumTier ('pro'/'ultra'); eski premiumlarda maydon yo'q → 'pro' (orqaga moslik).
// Premium faol emas → 'free'.
function tierOf(u) {
  if (!isActivePremium(u)) return 'free';
  const t = u && u.premiumTier;
  return t === 'pro' || t === 'ultra' ? t : 'pro';
}

function entitlements(tierKey) {
  return TIERS[tierKey] || TIERS.free;
}

// JSON-xavfsiz nusxa: Infinity → null (client null = cheksiz deb biladi)
function entitlementsPublic(tierKey) {
  const e = entitlements(tierKey);
  const out = {};
  for (const k in e) out[k] = e[k] === Infinity ? null : e[k];
  return out;
}

// Jamoa egasining haqiqiy a'zo chegarasi — tier 0 bersa-yu coin bilan ochilgan bo'lsa, PURCHASED limit.
function effectiveTeamMax(owner) {
  const base = entitlements(tierOf(owner)).teamMaxMembers;
  if (base > 0) return base;
  return owner && owner.purchasedTeamCreate ? PURCHASED_TEAM_MAX_MEMBERS : base;
}

module.exports = { TIERS, TIER_KEYS, PAID_TIER_KEYS, TERRITORY_SLOT_PRICE, EXPANSION_PACK, TEAM_CREATE_PRICE, PURCHASED_TEAM_MAX_MEMBERS, isActivePremium, tierOf, entitlements, entitlementsPublic, effectiveTeamMax };
