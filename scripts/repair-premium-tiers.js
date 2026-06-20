#!/usr/bin/env node
// Eski foydalanuvchilar premiumTier'ini AUDIT/TUZATISH.
// Muammo: tierOf() premiumTier null/noto'g'ri bo'lsa 'pro'ga default qiladi → Ultra egalar
// Pro shield (margin 5) oladi. Bu skript faol-premium, lekin premiumTier null/noto'g'ri
// userlarni topadi va TO'LOV LEDGER'idan (premiumPurchase) haqiqiy tier'ni tiklaydi.
//
// Standart: faqat HISOBOT (hech narsa o'zgartirmaydi).
//   node scripts/repair-premium-tiers.js
// Ledger asosida tuzatish (ishonchli — haqiqiy to'lovdan):
//   node scripts/repair-premium-tiers.js --apply
//
// Ledger'i YO'Q userlar (100% promo / legacy / gift) — tier'ini bilib bo'lmaydi →
// "QO'LDA" deb belgilanadi, admin panel orqali to'g'rilanadi (Premium ber → tier).
require('dotenv').config();
const { prisma } = require('../src/config/database');

(async () => {
  const apply = process.argv.includes('--apply');
  const now = new Date();

  const users = await prisma.user.findMany({
    where: {
      isPremium: true,
      premiumUntil: { gt: now },
      // premiumTier @default("free") (null emas) — faol premium bo'la turib 'free'/noto'g'ri
      // tier'da qolgan eski userlar (tierOf ularni 'pro'ga default qiladi → Ultra'lar margin5 oladi).
      premiumTier: { notIn: ['pro', 'ultra'] },
    },
    select: { id: true, username: true, premiumTier: true, premiumIsGift: true },
  });

  console.log(`Faol premium, lekin premiumTier null/noto'g'ri: ${users.length} ta\n`);
  let fixable = 0, manual = 0;

  for (const u of users) {
    const lastPurchase = await prisma.premiumPurchase.findFirst({
      where: { userId: u.id, tier: { in: ['pro', 'ultra'] } },
      orderBy: { createdAt: 'desc' },
      select: { tier: true, createdAt: true },
    });

    if (lastPurchase) {
      fixable++;
      console.log(`  ${u.username.padEnd(18)} ${String(u.premiumTier)} → ${lastPurchase.tier}  (ledger: ${lastPurchase.createdAt.toISOString().slice(0,10)})`);
      if (apply) {
        await prisma.user.update({ where: { id: u.id }, data: { premiumTier: lastPurchase.tier } });
      }
    } else {
      manual++;
      console.log(`  ${u.username.padEnd(18)} ${String(u.premiumTier)} → QO'LDA (ledger yo'q${u.premiumIsGift ? ', gift/promo' : ''}) — admin paneldan tier qo'ying`);
    }
  }

  console.log(`\n— Xulosa —`);
  console.log(`  Ledger asosida tuzatiladi : ${fixable}`);
  console.log(`  Qo'lda ko'rib chiqish      : ${manual}`);
  console.log(apply
    ? `\n✅ ${fixable} ta akkaunt ledger asosida TUZATILDI.`
    : `\nℹ️  Hech narsa o'zgartirilmadi (hisobot). Tuzatish uchun: node scripts/repair-premium-tiers.js --apply`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
