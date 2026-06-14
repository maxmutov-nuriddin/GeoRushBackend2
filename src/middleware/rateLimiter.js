const rateLimit = require('express-rate-limit');

// Umumiy per-IP backstop. 500 → 2000 (15 daqiqaga) ko'tarildi: mobil operatorlar ko'p
// o'yinchini BITTA NAT-IP ortiga qo'yadi → 500 ularga yetmасди. Endi haqiqiy per-akkaunt
// nazorat userRateLimiter (300/daq) + auth endpoint limitlari (login 3/7daq h.k.); bu esa
// faqat ekstremal IP-flood'ga qarshi qo'pol himoya. Ko'tarish — faqat KENGAYTIRADI, hech
// narsani buzmaydi.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

// Login: 3 marta noto'g'ri urinish → 7 daqiqa blok (muvaffaqiyatlilar hisoblanmaydi)
const loginLimiter = rateLimit({
  windowMs: 7 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Juda ko\'p noto\'g\'ri urinish. 7 daqiqadan keyin urinib ko\'ring.', code: 'RATE_LIMITED' },
});

// OTP so'rash (register/reset): 3 urinish / 7 daqiqa
const registerLimiter = rateLimit({
  windowMs: 7 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Juda ko\'p OTP so\'rovi. 7 daqiqadan keyin urinib ko\'ring.', code: 'RATE_LIMITED' },
});

// OTP tekshirish: 3 marta noto'g'ri kod → 7 daqiqa blok
const otpVerifyLimiter = rateLimit({
  windowMs: 7 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Juda ko\'p noto\'g\'ri OTP urinish. 7 daqiqadan keyin urinib ko\'ring.', code: 'RATE_LIMITED' },
});

// Parol tiklash: 3 urinish / soat
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Juda ko\'p parol tiklash urinishi. 1 soatdan keyin urinib ko\'ring.', code: 'RATE_LIMITED' },
});

// Landing "Bog'lanish" formasi — auth talab qilmaydi, shuning uchun spamга qarshi
// IP bo'yicha cheklov: 5 xabar / 10 daqiqa.
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Juda ko\'p xabar yuborildi. 10 daqiqadan keyin urinib ko\'ring.', code: 'RATE_LIMITED' },
});

const authLimiter = loginLimiter;

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'API rate limit exceeded.' },
});

module.exports = { globalLimiter, authLimiter, loginLimiter, registerLimiter, otpVerifyLimiter, forgotPasswordLimiter, contactLimiter, apiLimiter };
