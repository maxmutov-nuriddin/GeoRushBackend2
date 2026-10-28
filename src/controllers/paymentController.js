// O'yinchi tomoni: so'mdagi tanga paketlari (Click / Payme / PayGate) — ro'yxat, checkout, holat.
// Callback'lar alohida: paymeController / clickController / paygateController.
const { prisma } = require('../config/database');
const payments = require('../config/payments');
const { PROVIDERS, publicPacks, createOrder, cancelOrder } = require('../services/paymentOrderService');
const paygateService = require('../services/paygateService');
const logger = require('../utils/logger');

const ORDER_SELECT = {
  id: true, provider: true, productId: true, amountSom: true, status: true, createdAt: true, paidAt: true,
  payAmount: true, payCard: true, payExpiresAt: true,
};

// PayGate: redirect yo'q — mijozga karta, aniq summa va muddat ko'rsatiladi.
function paygateView(order) {
  return {
    payAmount: order.payAmount,
    card: order.payCard,
    cardHolder: process.env.PAYGATE_CARD_HOLDER || null,
    expiresAt: order.payExpiresAt,
  };
}

async function checkoutPaygate(order, res) {
  try {
    const opened = await paygateService.openPayment(order);
    return res.json({ orderId: opened.id, amountSom: opened.amountSom, provider: 'paygate', ...paygateView(opened) });
  } catch (err) {
    await cancelOrder(order.id);
    logger.warn('PayGate checkout failed', { orderId: order.id, err: err.message });
    const status = err instanceof paygateService.PaygateError ? 502 : 500;
    return res.status(status).json({ error: err.message, code: 'PAYGATE_ERROR' });
  }
}

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
    if (provider === 'paygate') return checkoutPaygate(order, res);
    const url = provider === 'payme' ? paymeUrl(order) : clickUrl(order);
    res.json({ orderId: order.id, amountSom: order.amountSom, provider, url });
  } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
}

// GET /api/payments/orders/:id — mijoz to'lovdan qaytgach (yoki PayGate kutayotganda) holatni tekshiradi.
// PayGate ochiq buyurtmasi bo'lsa — callback kelmagan holat uchun serverdan sinxronlaymiz.
async function getOrder(req, res, next) {
  try {
    const where = { id: req.params.id, userId: req.user.id };
    let order = await prisma.paymentOrder.findFirst({ where, select: { ...ORDER_SELECT, providerTxId: true } });
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    if (order.provider === 'paygate' && order.status === 'pending') {
      await paygateService.syncOrder(order);
      order = await prisma.paymentOrder.findFirst({ where, select: ORDER_SELECT });
    }
    const { providerTxId, ...pub } = order;
    res.json({ order: pub });
  } catch (err) { next(err); }
}

// POST /api/payments/orders/:id/cancel — mijoz PayGate to'lovidan voz kechdi
async function cancelMyOrder(req, res, next) {
  try {
    const order = await prisma.paymentOrder.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'Buyurtma allaqachon yakunlangan', status: order.status });
    if (order.provider === 'paygate') await paygateService.cancelPayment(order);
    else await cancelOrder(order.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = { getPacks, checkout, getOrder, cancelMyOrder };
