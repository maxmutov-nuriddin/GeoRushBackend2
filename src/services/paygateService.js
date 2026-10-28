// PayGate klienti — o'z to'lov serverimiz (karta → karta, Telegram karta-bot tasdig'i).
// API: POST /payment/create, GET /payment/status, POST /payment/cancel (shop_id + shop_key).
// Callback imzosi: md5(shop_id + payment_id + amount + shop_key).
//
// Buyurtma holati ikki yo'l bilan yangilanadi: PayGate callback'i (asosiy) va mijoz holatni
// so'raganda /payment/status orqali sinxron (callback yetib bormasa — masalan NAT ortida).
// Ikkalasi ham grantPaidOrder orqali — mahsulot faqat bir marta beriladi.
const crypto = require('crypto');
const { prisma } = require('../config/database');
const { paygate } = require('../config/payments');
const { grantPaidOrder, cancelOrder } = require('./paymentOrderService');
const logger = require('../utils/logger');

class PaygateError extends Error {}

async function call(method, path, fields) {
  const body = new URLSearchParams({ shop_id: paygate.shopId, shop_key: paygate.shopKey, ...fields });
  const url = method === 'GET' ? `${paygate.url}${path}?${body}` : `${paygate.url}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : body,
      signal: AbortSignal.timeout(paygate.timeoutMs),
    });
  } catch (err) {
    throw new PaygateError(`PayGate bilan aloqa yo'q: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new PaygateError(data.error || `PayGate HTTP ${res.status}`);
  return data;
}

function signFor(paymentId, amount) {
  return crypto.createHash('md5').update(`${paygate.shopId}${paymentId}${amount}${paygate.shopKey}`).digest('hex');
}

function verifySign(form) {
  if (!paygate.shopKey || typeof form.sign !== 'string') return false;
  const expected = Buffer.from(signFor(form.payment_id || '', form.amount || ''));
  const given = Buffer.from(form.sign.toLowerCase());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Buyurtma uchun PayGate to'lovini ochadi. AUTO_UNIQUE_AMOUNT yoqilgan bo'lsa summa +1..+N
// so'mga oshishi mumkin — mijozga DOIM payAmount ko'rsatiladi (amountSom emas).
async function openPayment(order) {
  const data = await call('POST', '/payment/create', {
    amount: String(order.amountSom),
    order_id: order.id,
    ...(paygate.callbackUrl ? { complete_url: paygate.callbackUrl } : {}),
  });
  const expiresInMs = (Number(data.expires_in) || 300) * 1000;
  try {
    return await prisma.paymentOrder.update({
      where: { id: order.id },
      data: {
        providerTxId: String(data.payment_id),
        payAmount: Number(data.amount),
        payCard: String(data.card || ''),
        payExpiresAt: new Date(Date.now() + expiresInMs),
      },
    });
  } catch (err) {
    // PayGate'da to'lov ochildi, lekin bizda saqlanmadi — u yerda yetim pending qolmasin
    // (aks holda o'sha summa band bo'lib, keyingi mijozlarga +1 so'm surilardi).
    await call('POST', '/payment/cancel', { payment_id: String(data.payment_id) }).catch(() => {});
    throw err;
  }
}

// PayGate holatini buyurtmaga qo'llaydi. paid → mahsulot (summa mos bo'lsagina), cancel → bekor.
async function applyStatus(order, status, amount) {
  if (status === 'paid') {
    if (Number(amount) !== order.payAmount) {
      logger.error('PayGate summa mos emas', { orderId: order.id, expected: order.payAmount, got: amount });
      return { granted: false, mismatch: true };
    }
    return grantPaidOrder(order.id);
  }
  if (status === 'cancel') await cancelOrder(order.id);
  return { granted: false };
}

// Mijoz holatni so'raganda: ochiq PayGate buyurtmasini serverdan tekshirib sinxronlaydi.
async function syncOrder(order) {
  if (order.provider !== 'paygate' || order.status !== 'pending' || !order.providerTxId) return;
  try {
    const p = await call('GET', '/payment/status', { payment_id: order.providerTxId });
    if (p.status && p.status !== 'pending') await applyStatus(order, p.status, p.amount);
  } catch (err) {
    logger.warn('PayGate status sync failed', { orderId: order.id, err: err.message });
  }
}

async function cancelPayment(order) {
  if (order.providerTxId) {
    try { await call('POST', '/payment/cancel', { payment_id: order.providerTxId }); }
    catch (err) { logger.warn('PayGate cancel failed', { orderId: order.id, err: err.message }); }
  }
  await cancelOrder(order.id);
}

module.exports = { PaygateError, openPayment, syncOrder, cancelPayment, applyStatus, verifySign, signFor };
