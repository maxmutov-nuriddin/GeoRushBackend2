// Payme Merchant API (JSON-RPC 2.0) — POST /api/payments/payme
// Hujjat: https://developer.help.paycom.uz/protokol-merchant-api/
//
// Payme serveri shu endpointni chaqiradi; javob DOIM HTTP 200, xato `error` obyektida.
// Holatlar: 1 yaratildi · 2 bajarildi · -1 yaratilgandan keyin bekor · -2 bajarilgandan keyin bekor.
// Summa tiyinda (1 so'm = 100 tiyin). Mahsulot grantPaidOrder orqali faqat bir marta beriladi.
const crypto = require('crypto');
const { prisma } = require('../config/database');
const { payme } = require('../config/payments');
const { grantPaidOrder, cancelOrder } = require('../services/paymentOrderService');
const logger = require('../utils/logger');

const TX_TIMEOUT_MS = 12 * 60 * 60 * 1000; // Payme: yaratilgan tranzaksiya 12 soatda bajarilmasa bekor
const CANCEL_REASON_TIMEOUT = 4;

const ERR = {
  AUTH:            { code: -32504, message: { uz: 'Ruxsat yo\'q', ru: 'Недостаточно привилегий', en: 'Insufficient privileges' } },
  PARSE:           { code: -32700, message: { uz: 'JSON xato', ru: 'Ошибка парсинга JSON', en: 'Parse error' } },
  METHOD:          { code: -32601, message: { uz: 'Metod topilmadi', ru: 'Метод не найден', en: 'Method not found' } },
  BAD_REQUEST:     { code: -32600, message: { uz: 'Noto\'g\'ri so\'rov', ru: 'Неверный запрос', en: 'Invalid request' } },
  AMOUNT:          { code: -31001, message: { uz: 'Noto\'g\'ri summa', ru: 'Неверная сумма', en: 'Incorrect amount' } },
  TX_NOT_FOUND:    { code: -31003, message: { uz: 'Tranzaksiya topilmadi', ru: 'Транзакция не найдена', en: 'Transaction not found' } },
  CANT_CANCEL:     { code: -31007, message: { uz: 'Buyurtma bajarilgan, bekor qilib bo\'lmaydi', ru: 'Заказ выполнен, отмена невозможна', en: 'Order completed, cannot cancel' } },
  CANT_PERFORM:    { code: -31008, message: { uz: 'Amalni bajarib bo\'lmaydi', ru: 'Невозможно выполнить операцию', en: 'Unable to perform operation' } },
  ORDER_NOT_FOUND: { code: -31050, message: { uz: 'Buyurtma topilmadi', ru: 'Заказ не найден', en: 'Order not found' } },
  ORDER_CLOSED:    { code: -31051, message: { uz: 'Buyurtma to\'langan yoki bekor qilingan', ru: 'Заказ оплачен или отменён', en: 'Order already paid or cancelled' } },
  ORDER_BUSY:      { code: -31052, message: { uz: 'Buyurtma boshqa tranzaksiyada', ru: 'Заказ ожидает другую транзакцию', en: 'Order is pending another transaction' } },
};

class PaymeError extends Error {
  constructor(spec, data = null) {
    super(spec.message.en);
    this.spec = spec;
    this.data = data;
  }
}

function isAuthorized(req) {
  if (!payme.key) return false;
  const header = req.headers.authorization || '';
  const expected = `Basic ${Buffer.from(`Paycom:${payme.key}`).toString('base64')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const num = (v) => (v == null ? 0 : Number(v));

function txView(order) {
  return {
    create_time: num(order.paymeCreateTime),
    perform_time: num(order.paymePerformTime),
    cancel_time: num(order.paymeCancelTime),
    transaction: order.id,
    state: order.paymeState,
    reason: order.cancelReason ?? null,
  };
}

// Buyurtma mavjud, ochiq va summa mos — aks holda PaymeError
async function loadPayableOrder(params) {
  const orderId = params?.account?.[payme.accountField];
  if (!orderId || typeof orderId !== 'string') throw new PaymeError(ERR.ORDER_NOT_FOUND, payme.accountField);
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order || order.provider !== 'payme') throw new PaymeError(ERR.ORDER_NOT_FOUND, payme.accountField);
  if (order.status !== 'pending') throw new PaymeError(ERR.ORDER_CLOSED, payme.accountField);
  if (Number(params.amount) !== order.amountSom * 100) throw new PaymeError(ERR.AMOUNT);
  return order;
}

async function findByTxId(id) {
  if (!id || typeof id !== 'string') throw new PaymeError(ERR.TX_NOT_FOUND);
  const order = await prisma.paymentOrder.findUnique({ where: { providerTxId: id } });
  if (!order || order.provider !== 'payme') throw new PaymeError(ERR.TX_NOT_FOUND);
  return order;
}

async function expireIfTimedOut(order, now) {
  if (now - num(order.paymeCreateTime) <= TX_TIMEOUT_MS) return false;
  await prisma.paymentOrder.update({
    where: { id: order.id },
    data: { paymeState: -1, paymeCancelTime: BigInt(now), cancelReason: CANCEL_REASON_TIMEOUT },
  });
  await cancelOrder(order.id);
  return true;
}

async function checkPerformTransaction(params) {
  await loadPayableOrder(params);
  return { allow: true };
}

async function createTransaction(params) {
  const now = Date.now();
  const existing = params.id ? await prisma.paymentOrder.findUnique({ where: { providerTxId: String(params.id) } }) : null;
  if (existing) {
    if (existing.paymeState !== 1) throw new PaymeError(ERR.CANT_PERFORM);
    if (await expireIfTimedOut(existing, now)) throw new PaymeError(ERR.CANT_PERFORM);
    return { create_time: num(existing.paymeCreateTime), transaction: existing.id, state: 1 };
  }

  const order = await loadPayableOrder(params);
  if (order.providerTxId && order.paymeState === 1) throw new PaymeError(ERR.ORDER_BUSY, payme.accountField);

  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: {
      providerTxId: String(params.id),
      paymeState: 1,
      paymeTime: BigInt(num(params.time)),
      paymeCreateTime: BigInt(now),
    },
  });
  return { create_time: num(updated.paymeCreateTime), transaction: updated.id, state: 1 };
}

async function performTransaction(params) {
  const now = Date.now();
  const order = await findByTxId(params.id);
  if (order.paymeState === 2) {
    return { transaction: order.id, perform_time: num(order.paymePerformTime), state: 2 };
  }
  if (order.paymeState !== 1) throw new PaymeError(ERR.CANT_PERFORM);
  if (await expireIfTimedOut(order, now)) throw new PaymeError(ERR.CANT_PERFORM);

  const { order: paid, granted } = await grantPaidOrder(order.id, { paymeState: 2, paymePerformTime: BigInt(now) });
  if (!granted && paid.paymeState !== 2) throw new PaymeError(ERR.CANT_PERFORM);
  return { transaction: paid.id, perform_time: num(paid.paymePerformTime), state: 2 };
}

async function cancelTransaction(params) {
  const now = Date.now();
  const order = await findByTxId(params.id);
  if (order.paymeState === -1 || order.paymeState === -2) {
    return { transaction: order.id, cancel_time: num(order.paymeCancelTime), state: order.paymeState };
  }
  // Tanga allaqachon berilgan (va sarflangan bo'lishi mumkin) — qaytarib bo'lmaydi
  if (order.paymeState === 2) throw new PaymeError(ERR.CANT_CANCEL);

  const reason = Number.isInteger(params.reason) ? params.reason : null;
  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: { paymeState: -1, paymeCancelTime: BigInt(now), cancelReason: reason },
  });
  await cancelOrder(order.id);
  return { transaction: updated.id, cancel_time: num(updated.paymeCancelTime), state: -1 };
}

async function checkTransaction(params) {
  return txView(await findByTxId(params.id));
}

async function getStatement(params) {
  const from = num(params?.from);
  const to = num(params?.to);
  if (!from || !to || from > to) throw new PaymeError(ERR.BAD_REQUEST);
  const orders = await prisma.paymentOrder.findMany({
    where: { provider: 'payme', paymeCreateTime: { gte: BigInt(from), lte: BigInt(to) } },
    orderBy: { paymeCreateTime: 'asc' },
  });
  return {
    transactions: orders.map((o) => ({
      id: o.providerTxId,
      time: num(o.paymeTime),
      amount: o.amountSom * 100,
      account: { [payme.accountField]: o.id },
      ...txView(o),
    })),
  };
}

const METHODS = {
  CheckPerformTransaction: checkPerformTransaction,
  CreateTransaction: createTransaction,
  PerformTransaction: performTransaction,
  CancelTransaction: cancelTransaction,
  CheckTransaction: checkTransaction,
  GetStatement: getStatement,
};

function reply(res, id, payload) {
  res.status(200).json({ jsonrpc: '2.0', id: id ?? null, ...payload });
}

// POST /api/payments/payme
async function handlePayme(req, res) {
  const rpcId = req.body?.id;
  if (!isAuthorized(req)) return reply(res, rpcId, { error: ERR.AUTH });
  if (!req.body || typeof req.body.method !== 'string') return reply(res, rpcId, { error: ERR.PARSE });

  const handler = METHODS[req.body.method];
  if (!handler) return reply(res, rpcId, { error: ERR.METHOD });

  try {
    const result = await handler(req.body.params || {});
    return reply(res, rpcId, { result });
  } catch (err) {
    if (err instanceof PaymeError) {
      return reply(res, rpcId, { error: { ...err.spec, data: err.data } });
    }
    logger.error('Payme handler failed', { method: req.body.method, err: err.message });
    return reply(res, rpcId, { error: ERR.CANT_PERFORM });
  }
}

module.exports = { handlePayme };
