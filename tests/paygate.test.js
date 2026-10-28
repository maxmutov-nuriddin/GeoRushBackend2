// PayGate konfiguratsiyasi va imzo tekshiruvi testlari
require('dotenv').config();
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const payments = require('../src/config/payments');
const { signFor, verifySign } = require('../src/services/paygateService');

describe('PayGate integratsiyasi', () => {
  test('konfiguratsiya to\'g\'ri yuklangan va yoqilgan', () => {
    assert.equal(payments.isEnabled('paygate'), true);
    assert.equal(payments.paygate.shopId, process.env.PAYGATE_SHOP_ID);
    assert.ok(payments.paygate.url.startsWith('http'));
    assert.ok(payments.paygate.shopKey.startsWith('sk_'));
  });

  test('signFor MD5 imzoni to\'g\'ri hisoblaydi', () => {
    const paymentId = 'pay_abc123';
    const amount = 50000;
    const expected = crypto
      .createHash('md5')
      .update(`${payments.paygate.shopId}${paymentId}${amount}${payments.paygate.shopKey}`)
      .digest('hex');

    assert.equal(signFor(paymentId, amount), expected);
  });

  test('verifySign to\'g\'ri imzoni tasdiqlaydi, xato imzoni rad etadi', () => {
    const paymentId = 'pay_test_999';
    const amount = 25000;
    const validSign = signFor(paymentId, amount);

    // To'g'ri imzo
    assert.equal(verifySign({
      shop_id: payments.paygate.shopId,
      payment_id: paymentId,
      amount,
      sign: validSign,
    }), true);

    // Katta-kichik harflar (case-insensitive)
    assert.equal(verifySign({
      shop_id: payments.paygate.shopId,
      payment_id: paymentId,
      amount,
      sign: validSign.toUpperCase(),
    }), true);

    // Noto'g'ri imzo
    assert.equal(verifySign({
      shop_id: payments.paygate.shopId,
      payment_id: paymentId,
      amount,
      sign: 'invalid_signature_hash',
    }), false);

    // Summa o'zgartirilgan bo'lsa
    assert.equal(verifySign({
      shop_id: payments.paygate.shopId,
      payment_id: paymentId,
      amount: 10000,
      sign: validSign,
    }), false);
  });
});
