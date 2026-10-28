// O'yinchi tomoni: so'mdagi tanga paketlari (Click / Payme) — ro'yxat, checkout, holat.
// Callback'lar alohida: paymeController / clickController.
const { prisma } = require('../config/database');
const payments = require('../config/payments');
const { PROVIDERS, publicPacks, createOrder } = require('../services/paymentOrderService');

function paymeUrl(order) {
  const params = [
    `m=${payments.payme.merchantId}`,
    `ac.${payments.payme.accountField}=${order.id}`,
    `a=${order.amountSom * 100}`,
    `c=${payments.returnUrl}`,
  ].join(';');
  return `${payments.payme.checkoutUrl}/${Buffer.from(params).toString('base64')}`;
}

function clickUrl(order) {
  const q = new URLSearchParams({
    service_id: payments.click.serviceId,
    merchant_id: payments.click.merchantId,
    amount: String(order.amountSom),
    transaction_param: order.id,
    return_url: payments.returnUrl,
  });
  return `${payments.click.payUrl}?${q.toString()}`;
}

// GET /api/payments/packs
async function getPacks(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { starterPackBought: true } });
    res.json({
      packs: publicPacks(user),
      providers: PROVIDERS.filter((p) => payments.isEnabled(p)),
    });
  } catch (err) { next(err); }
}

// POST /api/payments/checkout { packId, provider }
async function checkout(req, res, next) {
  try {
    const { packId, provider } = req.body;
    if (!payments.isEnabled(provider)) {
      return res.status(503).json({ error: 'Bu to\'lov usuli hozircha ulanmagan', code: 'PROVIDER_DISABLED' });
    }
    const order = await createOrder({ userId: req.user.id, provider, productId: packId });
    const url = provider === 'payme' ? paymeUrl(order) : clickUrl(order);
    res.json({ orderId: order.id, amountSom: order.amountSom, provider, url });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
}

// GET /api/payments/orders/:id — mijoz to'lovdan qaytgach holatni tekshiradi
async function getOrder(req, res, next) {
  try {
    const order = await prisma.paymentOrder.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      select: { id: true, provider: true, productId: true, amountSom: true, status: true, createdAt: true, paidAt: true },
    });
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    res.json({ order });
  } catch (err) { next(err); }
}

module.exports = { getPacks, checkout, getOrder };
