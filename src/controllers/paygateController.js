// PayGate callback — POST /api/payments/paygate/complete (x-www-form-urlencoded).
// Maydonlar: shop_id, payment_id, order_id, amount, status ('paid' | 'cancel'), card, paid_at, sign.
// Imzo to'g'ri bo'lsa DOIM 200 "OK" — aks holda PayGate qayta-qayta yuboraveradi.
// Takroriy callback xavfsiz: grantPaidOrder faqat pending → paid o'tishda mahsulot beradi.
const { prisma } = require('../config/database');
const { paygate } = require('../config/payments');
const { verifySign, applyStatus } = require('../services/paygateService');
const logger = require('../utils/logger');

async function handleComplete(req, res) {
  const form = req.body || {};
  if (String(form.shop_id) !== paygate.shopId || !verifySign(form)) {
    logger.warn('PayGate callback: imzo noto\'g\'ri', { paymentId: form.payment_id });
    return res.status(403).send('bad sign');
  }

  try {
    const order = await prisma.paymentOrder.findUnique({ where: { providerTxId: String(form.payment_id) } });
    if (!order || order.provider !== 'paygate') {
      logger.warn('PayGate callback: buyurtma topilmadi', { paymentId: form.payment_id, orderId: form.order_id });
      return res.status(200).send('OK');
    }
    if (order.status === 'pending') await applyStatus(order, String(form.status), form.amount);
    return res.status(200).send('OK');
  } catch (err) {
    // 500 — PayGate keyinroq qayta urinadi (CALLBACK_RETRIES)
    logger.error('PayGate callback failed', { paymentId: form.payment_id, err: err.message });
    return res.status(500).send('retry');
  }
}

module.exports = { handleComplete };
