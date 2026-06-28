#!/usr/bin/env node
// Mavjud foydalanuvchilarning PII (phone, telegramChatId, email, lastLocation)
// maydonlarini bir martalik shifrlash. Idempotent — allaqachon shifrlangan (e1:/r1:)
// qiymatlar o'tkazib yuboriladi, qayta ishga tushirsa zarar yo'q.
//
// SHART: avval ENCRYPTION_KEY env'i o'rnatilgan bo'lishi kerak (kod bilan bir xil kalit).
//
//   DRY-RUN (faqat hisobot, hech narsa o'zgarmaydi):
//     node scripts/encrypt-existing-pii.js
//   HAQIQIY shifrlash:
//     node scripts/encrypt-existing-pii.js --apply
require('dotenv').config();
const { prisma } = require('../src/config/database');
const fc = require('../src/utils/fieldCrypto');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!fc.ENABLED) {
    console.error('❌ ENCRYPTION_KEY topilmadi. Avval env\'ga 64-hex kalit qo\'ying.');
    process.exit(1);
  }

  const users = await prisma.user.findMany({
    select: { id: true, phone: true, telegramChatId: true, email: true, lastLocation: true },
  });

  let changed = 0;
  const counts = { phone: 0, telegramChatId: 0, email: 0, lastLocation: 0 };

  for (const u of users) {
    const data = {};
    if (u.phone && !fc.isEncrypted(u.phone))                   { data.phone = fc.encPhone(u.phone); counts.phone++; }
    if (u.telegramChatId && !fc.isEncrypted(u.telegramChatId)) { data.telegramChatId = fc.encTelegram(String(u.telegramChatId)); counts.telegramChatId++; }
    if (u.email && !fc.isEncrypted(u.email))                   { data.email = fc.encEmail(u.email); counts.email++; }
    if (u.lastLocation && typeof u.lastLocation === 'object')  { data.lastLocation = fc.encLocation(u.lastLocation); counts.lastLocation++; }

    if (Object.keys(data).length) {
      changed++;
      if (APPLY) await prisma.user.update({ where: { id: u.id }, data });
    }
  }

  console.log(`${APPLY ? '✅ SHIFRLANDI' : '🔍 DRY-RUN (hech narsa o\'zgarmadi)'}`);
  console.log(`   Jami foydalanuvchi: ${users.length}`);
  console.log(`   O'zgaradigan/o'zgargan: ${changed}`);
  console.log(`   Maydonlar: phone=${counts.phone}, telegram=${counts.telegramChatId}, email=${counts.email}, location=${counts.lastLocation}`);
  if (!APPLY) console.log('\n   Haqiqiy shifrlash uchun: node scripts/encrypt-existing-pii.js --apply');

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
