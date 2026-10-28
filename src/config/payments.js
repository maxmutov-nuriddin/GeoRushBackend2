// Click / Payme sozlamalari — FAQAT env'dan. Kalit yo'q bo'lsa provayder o'chiq
// (checkout 503 qaytaradi, callback'lar auth xatosi beradi) — server yiqilmaydi.
const env = process.env;

const payme = {
  merchantId: env.PAYME_MERCHANT_ID || '',
  // Kassa kaliti (test rejimida test kaliti). Payme callback'larini Basic auth bilan tasdiqlash uchun.
  key: env.PAYME_KEY || '',
  checkoutUrl: (env.PAYME_CHECKOUT_URL || 'https://checkout.paycom.uz').replace(/\/+$/, ''),
  accountField: env.PAYME_ACCOUNT_FIELD || 'order_id',
};

const click = {
  serviceId: env.CLICK_SERVICE_ID || '',
  merchantId: env.CLICK_MERCHANT_ID || '',
  secretKey: env.CLICK_SECRET_KEY || '',
  payUrl: (env.CLICK_PAY_URL || 'https://my.click.uz/services/pay').replace(/\/+$/, ''),
};

// To'lovdan keyin foydalanuvchi qaytadigan sahifa (web Shop sahifasi yoki mobil deep link).
const returnUrl = env.PAYMENT_RETURN_URL || `${env.FRONTEND_URL || 'http://localhost:5173'}/shop?payment=done`;

function isEnabled(provider) {
  if (provider === 'payme') return !!(payme.merchantId && payme.key);
  if (provider === 'click') return !!(click.serviceId && click.merchantId && click.secretKey);
  return false;
}

module.exports = { payme, click, returnUrl, isEnabled };
