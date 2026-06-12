require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

// XAVFSIZLIK GUARD: bu test bazaga YOZADI va o'chiradi (deleteMany!).
// Lokal .env PRODUCTION bazaga ulangan bo'lishi mumkin — shuning uchun faqat
// localhost bazaga ruxsat beriladi. Remote bazada ataylab ishlatish kerak bo'lsa:
//   E2E_ALLOW_REMOTE_DB=1 node test-e2e.js
(function guardDatabaseUrl() {
  const url = process.env.DATABASE_URL || '';
  let host = '';
  try { host = new URL(url).hostname; } catch { /* bo'sh yoki yaroqsiz URL — quyida rad etiladi */ }
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (!isLocal && process.env.E2E_ALLOW_REMOTE_DB !== '1') {
    console.error('❌ E2E test to\'xtatildi: DATABASE_URL lokal emas (host: ' + (host || 'aniqlanmadi') + ').');
    console.error('   Bu test bazada test user yaratadi va deleteMany ishlatadi — prod bazaga qarshi xavfli.');
    console.error('   Lokal Postgres bilan ishga tushiring yoki ongli ravishda E2E_ALLOW_REMOTE_DB=1 qo\'ying.');
    process.exit(1);
  }
})();

const prisma = new PrismaClient();
const API_URL = 'http://localhost:5001/api';
let authToken = '';
let testUserId = '';

async function runTests() {
  console.log('--- GeoRush E2E Test Boshlandi ---');
  
  try {
    // 1. Tozlash
    console.log('[1] Eski test ma\'lumotlarini tozalash...');
    await prisma.user.deleteMany({ where: { phone: '998991234567' } });
    await prisma.team.deleteMany({ where: { name: 'E2E Test Team' } });
    
    // 2. Auth: User yaratish
    console.log('[2] Test foydalanuvchisini yaratish...');
    const passwordHash = await bcrypt.hash('testpass123', 12);
    const user = await prisma.user.create({
      data: {
        username: 'E2E_Tester',
        phone: '998991234567',
        passwordHash,
        color: '#ff0000',
        coins: 1000,
        isPremium: true,
        premiumTier: 'ultra',
        premiumUntil: new Date('2030-01-01'),
      }
    });
    testUserId = user.id;
    console.log('✅ User yaratildi: ID', user.id);

    // 3. Login orqali token olish
    console.log('[3] Login orqali token olish...');
    const loginRes = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '998991234567', password: 'testpass123' })
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error('Login xatosi: ' + JSON.stringify(loginData));
    authToken = loginData.token;
    console.log('✅ Login muvaffaqiyatli! Token olindi.');

    // 4. Do'kon (Shop) - Skin xarid qilish
    console.log('[4] Do\'kondan Skin sotib olish...');
    const shopRes = await fetch(`${API_URL}/shop/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ category: 'color', itemId: 'color_ice' })
    });
    const shopData = await shopRes.json();
    if (!shopRes.ok) throw new Error('Xarid xatosi: ' + JSON.stringify(shopData));
    console.log('✅ Xarid muvaffaqiyatli! Qolgan tanga:', shopData.coins);

    // 5. Jamoa (Teams) - Jamoa yaratish
    console.log('[5] Yangi Jamoa yaratish...');
    const teamRes = await fetch(`${API_URL}/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ name: 'E2E Test Team', tag: 'E2E', color: '#00ff00' })
    });
    const teamText = await teamRes.text();
    let teamData;
    try {
      teamData = JSON.parse(teamText);
    } catch(e) {
      throw new Error('Jamoa yaratish HTML qaytardi: ' + teamText.substring(0, 200));
    }
    if (!teamRes.ok) throw new Error('Jamoa yaratish xatosi: ' + JSON.stringify(teamData));
    console.log('✅ Jamoa yaratildi! ID:', teamData.team.id);

    // 6. Hudud (Territory) - Hudud egallash logikasi
    // Biz to'g'ridan-to'g'ri db xizmatini yozishimiz kerak, yoki PostGIS geometryni to'g'ri parse qila oladimi tekshiramiz.
    console.log('[6] Kichik test hudud yaratish (Prisma xom SQL orqali)...');
    
    const lat = 41.2995;
    const lng = 69.2401;
    const geoJson = JSON.stringify({
      type: 'Polygon',
      coordinates: [[
        [lng, lat], [lng+0.001, lat], [lng+0.001, lat+0.001], [lng, lat+0.001], [lng, lat]
      ]]
    });
    
    // Xom SQL hudud yaratish test (Territory controller buni avtomat qiladi aslida, lekin hudud yuborish formatini ko'ramiz)
    const territoryRes = await fetch(`${API_URL}/territories/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({
        points: [
          { latitude: lat, longitude: lng },
          { latitude: lat, longitude: lng+0.001 },
          { latitude: lat+0.001, longitude: lng+0.001 },
          { latitude: lat+0.001, longitude: lng },
        ]
      })
    });
    const territoryData = await territoryRes.json();
    if (!territoryRes.ok) {
       console.log('⚠️ Hudud egallashda ogohlantirish yoki xato:', territoryData);
    } else {
       console.log('✅ Hudud muvaffaqiyatli yozildi:', territoryData.message || 'ok');
    }

    console.log('\\n🎉 BARCHA TESTLAR MUVAFFAQIYATLI YAKUNLANDI!');
  } catch (error) {
    console.error('\\n❌ TEST XATOSI:', error.message);
    process.exitCode = 1; // DB yoki test xatosida CI "pass" bermasin (false-positive oldini oladi)
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
