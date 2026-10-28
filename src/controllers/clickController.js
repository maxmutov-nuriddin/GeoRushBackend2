// Click SHOP API — Prepare / Complete callback'lari.
//   POST /api/payments/click/prepare   (action=0)
//   POST /api/payments/click/complete  (action=1)
// Hujjat: https://docs.click.uz/click-api-request/
//
// So'rov application/x-www-form-urlencoded; javob DOIM HTTP 200 JSON, natija `error` kodida.
// Imzo: md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
//           [+ merchant_prepare_id (faqat complete)] + amount + action + sign_time)
const crypto = require('crypto');
const { prisma } = require('../config/database');
const { click } = require('../config/payments');
const { grantPaidOrder, cancelOrder } = require('../services/paymentOrderService');
const logger = require('../utils/logger');

const E = {
  OK:            [0, 'Success'],
  SIGN:          [-1, 'SIGN CHECK FAILED!'],
  AMOUNT:        [-2, 'Incorrect parameter amount'],
  ACTION:        [-3, 'Action not found'],
  ALREADY_PAID:  [-4, 'Already paid'],
  NO_ORDER:      [-5, 'User does not exist'],
  NO_TX:         [-6, 'Transaction does not exist'],
  UPDATE_FAILED: [-7, 'Failed to update user'],
  BAD_REQUEST:   [-8, 'Error in request from click'],
  CANCELLED:     [-9, 'Transaction cancelled'],
};

const AMOUNT_EPSILON = 0.01;

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function signOk(b, withPrepareId) {
  if (!click.secretKey || typeof b.sign_string !== 'string') return false;
  const raw = [
    b.click_trans_id, b.service_id, click.secretKey, b.merchant_trans_id,
    withPrepareId ? b.merchant_prepare_id : '',
    b.amount, b.action, b.sign_time,
  ].map((v) => (v == null ? '' : String(v))).join('');
  const expected = Buffer.from(md5(raw));
  const given = Buffer.from(b.sign_string.toLowerCase());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function respond(res, b, [error, note], extra = {}) {
  res.status(200).json({
    click_trans_id: b.click_trans_id ?? null,
    merchant_trans_id: b.merchant_trans_id ?? null,
    ...extra,
    error,
    error_note: note,
  });
}

async function loadOrder(b) {
  if (String(b.service_id) !== String(click.serviceId)) return { err: E.BAD_REQUEST };
  const order = typeof b.merchant_trans_id === 'string'
    ? await prisma.paymentOrder.findUnique({ where: { id: b.merchant_trans_id } })
    : null;
  if (!order || order.provider !== 'click') return { err: E.NO_ORDER };
  if (order.status === 'paid') return { err: E.ALREADY_PAID, order };
  if (order.status === 'cancelled') return { err: E.CANCELLED, order };
  if (Math.abs(parseFloat(b.amount) - order.amountSom) > AMOUNT_EPSILON) return { err: E.AMOUNT, order };
  return { order };
}

// POST /api/payments/click/prepare
async function handlePrepare(req, res) {
  const b = req.body || {};
  try {
    if (!signOk(b, false)) return respond(res, b, E.SIGN);
    if (String(b.action) !== '0') return respond(res, b, E.ACTION);

    const { order, err } = await loadOrder(b);
    if (err) return respond(res, b, err);

    // Foydalanuvchi to'lovni qayta boshlasa Click yangi click_trans_id yuboradi — ochiq buyurtmada yangilaymiz.
    if (order.providerTxId !== String(b.click_trans_id)) {
      await prisma.paymentOrder.update({ where: { id: order.id }, data: { providerTxId: String(b.click_trans_id) } });
    }
    return respond(res, b, E.OK, { merchant_prepare_id: order.num });
  } catch (e) {
    logger.error('Click prepare failed', { err: e.message, merchantTransId: b.merchant_trans_id });
    return respond(res, b, E.UPDATE_FAILED);
  }
}

// POST /api/payments/click/complete
async function handleComplete(req, res) {
  const b = req.body || {};
  try {
    if (!signOk(b, true)) return respond(res, b, E.SIGN);
    if (String(b.action) !== '1') return respond(res, b, E.ACTION);

    const { order, err } = await loadOrder(b);
    if (err) return respond(res, b, err, order ? { merchant_confirm_id: order.num } : {});
    if (String(b.merchant_prepare_id) !== String(order.num) || order.providerTxId !== String(b.click_trans_id)) {
      return respond(res, b, E.NO_TX);
    }

    // Click to'lov amalga oshmaganini bildirsa (error < 0) — buyurtmani bekor qilamiz
    if (Number(b.error) < 0) {
      await cancelOrder(order.id);
      return respond(res, b, E.CANCELLED, { merchant_confirm_id: order.num });
    }

    const { granted } = await grantPaidOrder(order.id);
    if (!granted) return respond(res, b, E.ALREADY_PAID, { merchant_confirm_id: order.num });
    return respond(res, b, E.OK, { merchant_confirm_id: order.num });
  } catch (e) {
    logger.error('Click complete failed', { err: e.message, merchantTransId: b.merchant_trans_id });
    return respond(res, b, E.UPDATE_FAILED);
  }
}

module.exports = { handlePrepare, handleComplete };
