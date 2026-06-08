// ─── Premium pog'onalari (Free / Pro / Ultra) — yagona manba ─────────────────
// Butun ilovadagi limit, multiplikator va flaglar shu yerda. Boshqa joylar shuni o'qiydi.
// Cheksiz qiymatlar Infinity bilan beriladi; JSON uchun entitlementsPublic() null ga aylantiradi.

const TIERS = {
  free: {
    key: 'free',
    teamCreate: false,
    teamMaxMembers: 0,        // o'zi jamoa egasi bo'la olmaydi
    territoryLimit: 3,
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
    territoryLimit: 15,
    shieldMargin: 5,          // attacker.level < owner.level - 5 bo'lsa himoyalanadi
    integrations: true,
    notifications: 'attack',
    stats: 'weekly',
    leaderboard: 'city',
    territoryName: false,    // hudud nomi faqat Ultra'da
    territoryEmoji: false,
    historyDays: 7,
    xpMult: 2,
    coinMult: 1.5,
    welcomeCoins: 2500,
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
    shieldMargin: 0,          // qat'iy: pastdagilar umuman ololmaydi
    integrations: true,
    notifications: 'realtime',
    stats: 'heatmap',
    leaderboard: 'global',
    territoryName: true,
    territoryEmoji: true,
    historyDays: Infinity,
    xpMult: 3,
    coinMult: 2,
    welcomeCoins: 7500,
    dailyCoins: 30,
    freeSkins: true,
    badge: 'elite',
    price: 79900,
  },
};

const TIER_KEYS = ['free', 'pro', 'ultra'];
const PAID_TIER_KEYS = ['pro', 'ultra'];

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

module.exports = { TIERS, TIER_KEYS, PAID_TIER_KEYS, isActivePremium, tierOf, entitlements, entitlementsPublic };
