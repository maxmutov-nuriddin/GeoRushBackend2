#!/usr/bin/env node
// Akkauntning HAQIQIY premium holatini prod DB'dan o'qiydi va shield qarorini ko'rsatadi.
// Ixtiyoriy: --fix=ultra|pro bilan premiumTier'ni to'g'rilaydi (faol premiumni uzaytirmaydi,
// faqat tier'ni tuzatadi). DATABASE_URL prod'ga ishora qilishi kerak (.env yoki env orqali).
//
//   node scripts/check-premium.js <username|userId>
//   node scripts/check-premium.js <username|userId> --fix=ultra
//
require('dotenv').config();
const { prisma } = require('../src/config/database');
const { tierOf, entitlements } = require('../src/config/tiers');

(async () => {
  const arg = process.argv[2];
  const fixArg = (process.argv.find((a) => a.startsWith('--fix=')) || '').split('=')[1];
  if (!arg) { console.error('Foydalanish: node scripts/check-premium.js <username|userId> [--fix=ultra|pro]'); process.exit(1); }

  const u = await prisma.user.findFirst({
    where: { OR: [{ id: arg }, { username: arg }] },
    select: { id: true, username: true, level: true, isPremium: true, premiumUntil: true, premiumTier: true, premiumIsGift: true },
  });
  if (!u) { console.error('Foydalanuvchi topilmadi:', arg); process.exit(1); }

  const now = new Date();
  const active = !!(u.isPremium && u.premiumUntil && now < new Date(u.premiumUntil));
  const tier = tierOf(u);
  const margin = entitlements(tier).shieldMargin;

  console.log('— Akkaunt —');
  console.log('  username      :', u.username);
  console.log('  level         :', u.level);
  console.log('  isPremium     :', u.isPremium);
  console.log('  premiumUntil  :', u.premiumUntil, active ? '(FAOL)' : '(MUDDATI O\'TGAN/yo\'q)');
  console.log('  premiumTier   :', JSON.stringify(u.premiumTier), u.premiumTier === 'ultra' ? '✓' : '← ULTRA EMAS!');
  console.log('  premiumIsGift :', u.premiumIsGift);
  console.log('— Shield qarori —');
  console.log('  tierOf()      :', tier);
  console.log('  shieldMargin  :', margin, '(ultra=0, pro=5, free=null)');
  console.log('  Misol: lvl 3 hujumchi sizning hududingizni ololadimi? ->',
    margin == null ? 'HA (himoya yo\'q)' : (3 < (u.level - margin) ? 'YO\'Q (himoyalangan) ✓' : 'HA (himoyalanmagan) ✗'));

  if (fixArg === 'ultra' || fixArg === 'pro') {
    await prisma.user.update({ where: { id: u.id }, data: { premiumTier: fixArg } });
    console.log(`\n✅ premiumTier '${fixArg}' ga TO'G'RILANDI. (premium muddati o'zgarmadi)`);
  } else if (u.premiumTier !== 'ultra' && active) {
    console.log('\nℹ️  Tuzatish uchun:  node scripts/check-premium.js', u.username, '--fix=ultra');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
