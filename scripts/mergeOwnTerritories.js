// Qo'lda ishga tushirish uchun (avtomatik bootда ham ishlaydi — territoryMergeBackfill).
//   node scripts/mergeOwnTerritories.js          → DRY-RUN (o'zgartirmaydi)
//   node scripts/mergeOwnTerritories.js --apply   → HAQIQIY birlashtirish
//
// Eslatma: server bootда bu allaqachon AVTOMATIK bir marta ishlaydi (SystemFlag bilan).
// Bu skript faqat qo'lda tekshirish/qayta ishlatish uchun.

require('dotenv').config();
const { mergeAllOwnTerritories } = require('../src/services/territoryMergeBackfill');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? '=== HAQIQIY BIRLASHTIRISH (--apply) ===' : '=== DRY-RUN (o\'zgartirmaydi) ===');
  const stats = await mergeAllOwnTerritories({ apply: APPLY });
  console.log(`Foydalanuvchilar (ta'sir): ${stats.usersAffected}`);
  console.log(`Birlashtirilgan guruhlar:  ${stats.groupsMerged}`);
  console.log(`O'chiriladigan hududlar:    ${stats.territoriesRemoved}`);
  console.log(`Tashlab ketilgan guruhlar:  ${stats.skipped} (bitta poligonga birlashmagan)`);
  if (!APPLY) console.log('\n>>> Bu DRY-RUN edi. Haqiqiy uchun: node scripts/mergeOwnTerritories.js --apply');
  process.exit(0);
})().catch((e) => { console.error('XATO:', e.message); process.exit(1); });
