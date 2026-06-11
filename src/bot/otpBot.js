const TelegramBot  = require('node-telegram-bot-api');
const crypto       = require('crypto');
const logger       = require('../utils/logger');
// Umumiy (yagona) Prisma instansi — alohida client ochmaymiz (ulanishlarni tejaymiz).
const { prisma }   = require('../config/database');
// welcomeCoins kabi qiymatlar uchun YAGONA manba — tiers.js. Avval bu faylda 350/1000
// hardcode edi, admin panel esa tiers'dagi 2500/7500 berardi — bir xil narxga har xil bonus.
const { TIERS }    = require('../config/tiers');

// DB-backed yordamchi funksiyalar (server restart bo'lsa ham saqlanadi)
async function setPending(chatId, type, windowMs) {
  const expiresAt = new Date(Date.now() + windowMs);
  await prisma.botSession.upsert({
    where: {
      chatId_type: {
        chatId: String(chatId),
        type,
      }
    },
    update: {
      createdAt: new Date(),
      expiresAt,
    },
    create: {
      chatId: String(chatId),
      type,
      createdAt: new Date(),
      expiresAt,
    }
  }).catch(() => {});
}

async function hasPending(chatId, type) {
  const doc = await prisma.botSession.findFirst({
    where: {
      chatId: String(chatId),
      type,
      expiresAt: { gt: new Date() },
    }
  }).catch(() => null);
  return !!doc;
}

async function delPending(chatId, type) {
  await prisma.botSession.deleteMany({
    where: { chatId: String(chatId), type }
  }).catch(() => {});
}

const PREMIUM_DAYS = { monthly: 30, yearly: 365 };
const PREMIUM_PAYLOAD = 'premium_v2';
const TIER_STARS = {
  pro:         150,   // oylik PRO
  ultra:       300,   // oylik Ultra
  pro_yearly:  1250,  // yillik PRO  (~399 000 so'm)
  ultra_yearly: 2500, // yillik Ultra (~799 000 so'm)
};

let bot = null;

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9) return '998' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '998' + digits.slice(1);
  return digits;
}

// Premium faolligini tekshirish
function isActivePremium(u) {
  return !!(u && u.isPremium && u.premiumUntil && new Date() < new Date(u.premiumUntil));
}

function calculateSomPrice(tier, period, discountPct = 0) {
  const basePrices = {
    pro: { monthly: 39900, yearly: 399000 },
    ultra: { monthly: 79900, yearly: 799000 },
  };
  const base = basePrices[tier]?.[period] || 39900;
  if (!discountPct) return base;
  return Math.max(1000, Math.round(base * (1 - discountPct / 100)));
}

function formatSom(amount) {
  return amount.toLocaleString('uz-UZ').replace(/,/g, ' ');
}

// Stars invoice yuborish
async function sendPremiumInvoice(chatId, userId, tier = 'pro', period = 'monthly', promoCode = null) {
  if (!bot) throw new Error('Bot ishlamayapti');
  const isYearly = period === 'yearly';
  const starKey  = isYearly ? `${tier}_yearly` : tier;
  let finalStars = TIER_STARS[starKey] || 150;
  const days = PREMIUM_DAYS[period] || 30;
  const welcomeCoins = (TIERS[tier] || TIERS.pro).welcomeCoins;
  const periodLabel  = isYearly ? '12 oy (2 oy bepul!)' : '1 oy';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true }
  });
  const isWelcomeActive = user && (Date.now() - new Date(user.createdAt).getTime()) < 10 * 60 * 1000;
  let welcomeDiscount = 0;
  if (isWelcomeActive) {
    welcomeDiscount = 30;
  }

  let promoDiscount = 0;
  if (promoCode) {
    const promo = await prisma.promoCode.findUnique({ where: { code: promoCode.toUpperCase() } });
    if (promo && promo.isActive && new Date() <= promo.expiresAt) {
      if (!promo.maxUses || promo.usesCount < promo.maxUses) {
        promoDiscount = promo.discountPct;
      }
    }
  }

  const effectiveDiscount = Math.max(welcomeDiscount, promoDiscount);
  if (effectiveDiscount > 0) {
    finalStars = Math.max(1, Math.round(finalStars * (1 - effectiveDiscount / 100)));
  }

  const baseAmount = calculateSomPrice(tier, period, 0);
  const finalAmount = calculateSomPrice(tier, period, effectiveDiscount);
  const priceLabel = effectiveDiscount > 0
    ? `${formatSom(finalAmount)} so'm (chegirma bilan, aslida ${formatSom(baseAmount)} so'm)`
    : `${formatSom(finalAmount)} so'm`;

  const coinsLabel = formatSom(welcomeCoins);
  let description = tier === 'ultra'
    ? `👑 Qat'iy himoya  •  ⚡ 3x XP  •  🪙 ${coinsLabel} coin + 2x bonus\n• Elite badge, skinlar bepul!\n\n${periodLabel} — ${priceLabel}${isYearly ? '\n🎁 2 oy BEPUL!' : ''}`
    : `💎 Hudud himoyasi  •  ⚡ 2x XP  •  🪙 ${coinsLabel} coin + 1.5x bonus\n• Premium badge\n\n${periodLabel} — ${priceLabel}${isYearly ? '\n🎁 2 oy BEPUL!' : ''}`;

  if (isWelcomeActive && welcomeDiscount >= promoDiscount) {
    description += `\n\n🎁 Birinchi ro'yxatdan o'tganingiz uchun 30% start chegirmasi qo'llandi!`;
  } else if (promoDiscount > 0) {
    description += `\n\n🎟 Promokod (${promoCode}): -${promoDiscount}% CHEGIRMA!`;
  }

  await bot.sendInvoice(
    chatId,
    `GeoRush ${tier.toUpperCase()} — ${periodLabel}`,
    description,
    JSON.stringify({ userId, type: PREMIUM_PAYLOAD, tier, period, promoCode }),
    '',
    'XTR',
    [{ label: `GeoRush Premium ${tier.toUpperCase()} (${periodLabel})`, amount: finalStars }],
  );
}

async function handleSuccessfulPayment(msg) {
  const payment = msg.successful_payment;
  if (!payment) return;

  let payload;
  try { payload = JSON.parse(payment.invoice_payload); } catch { return; }
  if (payload.type !== PREMIUM_PAYLOAD || !payload.userId) return;

  const tier   = payload.tier   || 'pro';
  const period = payload.period || 'monthly';
  const days   = PREMIUM_DAYS[period] || 30;
  const promoCode = payload.promoCode;
  const coinsBonus = (TIERS[tier] || TIERS.pro).welcomeCoins;
  const xpMult     = tier === 'ultra' ? '3x' : '2x';
  const periodLabel = period === 'yearly' ? '12 oy (365 kun)' : '30 kun';

  try {
    if (promoCode) {
      await prisma.promoCode.updateMany({
        where: { code: promoCode.toUpperCase() },
        data: { usesCount: { increment: 1 } }
      }).catch(() => {});
    }

    // Faol premium bo'lsa muddat USTIGA qo'shiladi (admin givePremium bilan bir xil) —
    // avval to'lov sanasidan qayta hisoblanib, qolgan kunlar yo'qolardi.
    const existing = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { premiumUntil: true }
    });
    const base = (existing?.premiumUntil && existing.premiumUntil > new Date())
      ? existing.premiumUntil.getTime()
      : Date.now();
    const premiumUntil = new Date(base + days * 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: payload.userId },
      data: {
        isPremium: true,
        premiumUntil,
        premiumTier: tier,
        premiumIsGift: false, // real to'lov — statistika/daromad hisobida qatnashadi
        coins: { increment: coinsBonus },
      }
    });

    const until = premiumUntil.toLocaleDateString('uz-UZ');
    await bot.sendMessage(msg.chat.id,
      `🎉 GeoRush ${tier.toUpperCase()} faollashtirildi!\n\n` +
      `⏳ Muddati: ${until} gacha (${periodLabel})\n` +
      `🛡️ Hudud himoyasi yoqildi\n` +
      `⚡ ${xpMult} XP yoqildi\n` +
      `🪙 +${coinsBonus.toLocaleString()} GeoCoins berildi!`
    );
    logger.info(`Premium activated: userId=${payload.userId}, tier=${tier}, period=${period}, until=${until}`);
  } catch (err) {
    logger.error('Premium activation error:', err.message);
    await bot.sendMessage(msg.chat.id, '⚠️ Xatolik yuz berdi. @fortisweb_support bilan bog\'laning.');
  }
}

async function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    logger.warn('OTP Bot: TELEGRAM_BOT_TOKEN sozlanmagan');
    return null;
  }

  // Scale-out: Telegram bitta tokenga faqat BITTA polling iste'molchiga ruxsat beradi.
  // Ko'p instance'da faqat bittasida polling qoladi (default: yoqilgan — bitta instance
  // uchun hech narsa o'zgarmaydi), qolganlarida BOT_POLLING=false qo'yiladi — ular
  // baribir xabar/invoice YUBORA OLADI (sendMessage/sendInvoice polling talab qilmaydi).
  const pollingEnabled = process.env.BOT_POLLING !== 'false';

  try {
    if (pollingEnabled) {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`)
        .then(r => r.json())
        .then(r => logger.info('Webhook delete:', r.ok ? 'OK' : r.description))
        .catch(e => logger.warn('Webhook delete skip:', e.message));
    }

    bot = new TelegramBot(token, { polling: pollingEnabled });

    const me = await bot.getMe();
    process.env.TELEGRAM_BOT_USERNAME = me.username;
    logger.info(`OTP Bot ishga tushdi: @${me.username}${pollingEnabled ? '' : ' (faqat yuborish — polling o\'chiq)'}`);

    const RECEIPT_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 soat

    // ── Karta ma'lumotlarini yuboruvchi (hisob allaqachon ulangan) ────────────
    async function sendCardInfo(chatId, tier = 'pro', period = 'monthly', promoCode = null) {
      const cardNumber = process.env.PREMIUM_CARD_NUMBER || 'Sozlanmagan';
      const cardOwner  = process.env.PREMIUM_CARD_OWNER  || 'Sozlanmagan';
      
      const user = await prisma.user.findFirst({
        where: { telegramChatId: String(chatId) },
        select: { createdAt: true }
      });
      const isWelcomeActive = user && (Date.now() - new Date(user.createdAt).getTime()) < 10 * 60 * 1000;
      let welcomeDiscount = 0;
      if (isWelcomeActive) {
        welcomeDiscount = 30;
      }

      let promoDiscount = 0;
      if (promoCode) {
        const promo = await prisma.promoCode.findUnique({ where: { code: promoCode.toUpperCase() } });
        if (promo && promo.isActive && new Date() <= promo.expiresAt) {
          if (!promo.maxUses || promo.usesCount < promo.maxUses) {
            promoDiscount = promo.discountPct;
          }
        }
      }

      const finalDiscount = Math.max(welcomeDiscount, promoDiscount);
      const baseAmount = calculateSomPrice(tier, period, 0);
      const finalAmount = calculateSomPrice(tier, period, finalDiscount);
      const periodLabel = period === 'yearly' ? 'Yillik (12 oy)' : 'Oylik (1 oy)';

      const lines = [
        `💎 GeoRush Premium ${tier.toUpperCase()} — Obuna`,
        `Tarif davri: ${periodLabel}`,
        isWelcomeActive && welcomeDiscount >= promoDiscount
          ? `Start chegirma: Birinchi ro'yxatdan o'tganingiz uchun (-30%)`
          : promoDiscount > 0 ? `Promokod: ${promoCode.toUpperCase()} (-${promoDiscount}%)` : null,
        '',
        'To\'lov ma\'lumotlari:',
        '',
        `Karta raqami: ${cardNumber}`,
        `Egasi: ${cardOwner}`,
        finalDiscount > 0 
          ? `Summa: ~${formatSom(baseAmount)}~ *${formatSom(finalAmount)} so'm*`
          : `Summa: *${formatSom(finalAmount)} so'm*`,
        '',
        'Qadamlar:',
        '1. Kartaga pul o\'tkazing',
        '2. Chek skrinshotini shu botga yuboring',
        '3. Admin 24 soat ichida Premium ni yoqadi',
        '',
        'Bu xabar 15 daqiqadan so\'ng o\'chib ketadi',
      ].filter(l => l !== null);

      let sentMsg;
      try {
        sentMsg = await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        logger.info(`Obuna karta yuborildi: chatId=${chatId}, tier=${tier}, period=${period}, promoCode=${promoCode}`);
      } catch (err) {
        logger.error('Karta yuborishda xato:', err.message);
        try { await bot.sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq urinib koring.'); } catch {}
        return;
      }

      const typeKey = `pendingReceipt:${tier}:${period}:${promoCode || ''}`;
      await setPending(chatId, typeKey, RECEIPT_WINDOW_MS);

      // 15 daqiqada karta xabarini o'chirish
      setTimeout(async () => {
        try {
          await bot.deleteMessage(chatId, sentMsg.message_id);
          await bot.sendMessage(chatId,
            'To\'lov ma\'lumotlari o\'chirildi. To\'lov qilgan bo\'lsangiz, chek skrinshotini yuboring.'
          );
        } catch {}
      }, 15 * 60 * 1000);
    }

    // ── /obuna — hisob ulanganmi tekshiradi, yo'q bo'lsa telefon so'raydi ────
    async function sendObuna(chatId, tier = 'pro', period = 'monthly', promoCode = null) {
      const strChatId = String(chatId);
      try {
        const linked = await prisma.user.findFirst({
          where: { telegramChatId: strChatId },
          select: { id: true }
        });
        if (linked) {
          // Hisob ulangan — karta yuboramiz
          await sendCardInfo(chatId, tier, period, promoCode);
        } else {
          // Hisob ulanmagan — avval telefon so'raymiz
          const typeKey = `pendingObuna:${tier}:${period}:${promoCode || ''}`;
          await setPending(chatId, typeKey, RECEIPT_WINDOW_MS);
          await bot.sendMessage(chatId,
            `Obuna (${tier.toUpperCase()}) uchun ilovadagi hisobingizni tasdiqlash kerak.\nTelefon raqamingizni ulashing:`,
            {
              reply_markup: {
                keyboard: [[{ text: '📱 Raqamni ulashish', request_contact: true }]],
                resize_keyboard: true,
                one_time_keyboard: true,
              },
            }
          );
        }
      } catch (err) {
        logger.error('sendObuna xato:', err.message);
        try { await bot.sendMessage(chatId, 'Xatolik yuz berdi. Keyinroq urinib koring.'); } catch {}
      }
    }

    // ── Chek rasmini qabul qilib adminга yuboruvchi funksiya ─────────────────
    async function handleReceipt(msg, tier = 'pro', period = 'monthly', promoCode = null, sessionCreatedAt = null) {
      const chatId  = String(msg.chat.id);
      const adminId = process.env.PREMIUM_ADMIN_TG_ID;

      // Foydalanuvchi ma'lumotlarini DB dan olamiz
      let username = '—';
      let phone    = '—';
      let createdAt = null;
      try {
        const user = await prisma.user.findFirst({
          where: { telegramChatId: chatId },
          select: { username: true, phone: true, createdAt: true }
        });
        if (user) {
          username = user.username || '—';
          phone    = user.phone    || '—';
          createdAt = user.createdAt;
        }
      } catch {}

      const vaqt = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });

      const refTime = sessionCreatedAt ? new Date(sessionCreatedAt).getTime() : Date.now();
      const isWelcomeActive = createdAt && (refTime - new Date(createdAt).getTime()) < 10 * 60 * 1000;
      let welcomeDiscount = 0;
      if (isWelcomeActive) {
        welcomeDiscount = 30;
      }

      let promoDiscount = 0;
      if (promoCode) {
        const promo = await prisma.promoCode.findUnique({ where: { code: promoCode.toUpperCase() } });
        if (promo && promo.isActive && new Date() <= promo.expiresAt) {
          if (!promo.maxUses || promo.usesCount < promo.maxUses) {
            promoDiscount = promo.discountPct;
          }
        }
      }

      const finalDiscount = Math.max(welcomeDiscount, promoDiscount);
      const finalAmount = calculateSomPrice(tier, period, finalDiscount);
      const periodLabel = period === 'yearly' ? 'YILLIK (12 oy)' : 'OYLIK (1 oy)';

      // Adminга rasm + to'liq ma'lumot
      if (adminId) {
        try {
          const fileId  = msg.photo[msg.photo.length - 1].file_id;
          const caption = [
            `Yangi Premium (${tier.toUpperCase()}) to'lov cheki!`,
            '',
            `Ism (ilova): ${username}`,
            `Telefon:     ${phone}`,
            `Vaqt:        ${vaqt}`,
            `Tarif:       ${tier.toUpperCase()} (${periodLabel})`,
            `To'lov summasi: ${formatSom(finalAmount)} so'm`,
            isWelcomeActive && welcomeDiscount >= promoDiscount
              ? `Chegirma:    10 daqiqalik start chegirmasi (-30%)`
              : promoCode ? `Promokod:    ${promoCode.toUpperCase()} (-${promoDiscount}%)` : null,
            '',
            `Premium yoqish: Admin panel > Users > 💎 (Tanlangan: ${tier.toUpperCase()}, Davomiyligi: ${periodLabel})`,
          ].filter(l => l !== null).join('\n');

          await bot.sendPhoto(adminId, fileId, { caption });
          logger.info(`Chek adminga yuborildi: chatId=${chatId}, user=${username}, tier=${tier}`);
        } catch (err) {
          logger.error('Chekni adminga yuborishda xato:', err.message);
        }
      }

      // Foydalanuvchiga tasdiqlash
      await bot.sendMessage(msg.chat.id,
        `Chekingiz qabul qilindi!\nAdmin 24 soat ichida Premium (${tier.toUpperCase()}, ${periodLabel}) ni yoqadi.`
      ).catch(() => {});

      // Hamma kutilayotgan receipt sessiyalarni o'chiramiz
      await prisma.botSession.deleteMany({
        where: {
          chatId: String(chatId),
          type: { startsWith: 'pendingReceipt' }
        }
      }).catch(() => {});
    }

    // ── /start obuna ─────────────────────────────────────────────────────────
    bot.onText(/\/start obuna(?:_([a-zA-Z0-9]+))?(?:_([a-zA-Z0-9]+))?(?:_([a-zA-Z0-9]+))?/, async (msg, match) => {
      const tier      = match[1] || 'pro';
      const period    = match[2] || 'monthly';
      const promoCode = match[3] || null;
      logger.info(`Bot /start obuna: chatId=${msg.chat.id}, tier=${tier}, period=${period}, promoCode=${promoCode}`);
      await sendObuna(msg.chat.id, tier, period, promoCode);
    });

    // ── /obuna — to'g'ridan-to'g'ri komanda (bot avval start qilingan bo'lsa) ─
    bot.onText(/^\/obuna(?:_([a-zA-Z0-9]+))?(?:_([a-zA-Z0-9]+))?(?:_([a-zA-Z0-9]+))?/, async (msg, match) => {
      const tier      = match[1] || 'pro';
      const period    = match[2] || 'monthly';
      const promoCode = match[3] || null;
      logger.info(`Bot /obuna komandasi: chatId=${msg.chat.id}, tier=${tier}, period=${period}, promoCode=${promoCode}`);
      await sendObuna(msg.chat.id, tier, period, promoCode);
    });

    // ── /start TOKEN — OTP ro'yxatdan o'tish ──────────────────────────────────
    bot.onText(/\/start ([a-f0-9]{40,})/, async (msg, match) => {
      const chatId    = String(msg.chat.id);
      const sessToken = match[1].trim();

      logger.info(`Bot /start: chatId=${chatId}`);

      let session;
      try {
        session = await prisma.oTPSession.findFirst({
          where: { token: sessToken, verified: false }
        });
      } catch (err) {
        logger.error('Bot sessiya topishda xato:', err.message);
        return bot.sendMessage(chatId, '⚠️ Server xatosi. Qaytadan urinib ko\'ring.');
      }

      if (!session || session.expiresAt < new Date()) {
        return bot.sendMessage(chatId,
          '❌ Havola eskirgan yoki noto\'g\'ri.\n\nIlovaga qaytib yangi havola oling.'
        );
      }

      await prisma.oTPSession.update({
        where: { id: session.id },
        data: { chatId }
      }).catch(() => {});

      bot.sendMessage(chatId,
        `👋 Salom!\n\nGeoRush uchun telefon raqamingizni ulashing.\n\n📱 Ro'yxatdan o'tayotgan raqam: <b>+${session.phone}</b>`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [[{ text: '📱 Raqamni ulashish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    });

    // ── /start (token yo'q) ───────────────────────────────────────────────────
    bot.onText(/^\/start$/, (msg) => {
      bot.sendMessage(msg.chat.id,
        '👋 Salom! GeoRush tasdiqlash boti.\n\n📱 Telefon raqamingizni ulashing:',
        {
          reply_markup: {
            keyboard: [[{ text: '📱 Raqamni ulashish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    });

    // ── /link — mavjud foydalanuvchi chatId ni ulashi ─────────────────────────
    bot.onText(/^\/link$/, (msg) => {
      bot.sendMessage(msg.chat.id,
        '🔗 GeoRush akkauntingizni Telegram bilan ulash uchun raqamingizni ulashing:',
        {
          reply_markup: {
            keyboard: [[{ text: '📱 Raqamni ulashish', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
    });

    // ── /premium — Premium haqida ma'lumot ────────────────────────────────────
    bot.onText(/^\/premium$/, async (msg) => {
      const chatId = String(msg.chat.id);
      try {
        const user = await prisma.user.findFirst({
          where: { telegramChatId: chatId },
          select: { username: true, isPremium: true, premiumUntil: true, premiumTier: true }
        });

        if (!user) {
          return bot.sendMessage(chatId,
            '❌ Akkauntingiz botga ulanmagan.\n\n/link komandasi bilan ulang.',
          );
        }

        if (isActivePremium(user)) {
          const until = new Date(user.premiumUntil).toLocaleDateString('uz-UZ');
          const tierName = (user.premiumTier || 'pro').toUpperCase();
          return bot.sendMessage(chatId,
            `@${user.username} — Premium ${tierName} faol\nMuddati: ${until}\n\nLimitlar va imtiyozlar faollashtirilgan.`
          );
        }

        bot.sendMessage(chatId,
          'GeoRush Premium tariflari:\n\n' +
          '1. 💎 PRO — 39,900 so\'m / 150 Stars\n' +
          '• 🛡️ Hudud himoyasi (daraja marjasi 5)\n' +
          '• ⚡ 2x XP va 🪙 1.5x GeoCoins\n' +
          '• 🎁 2 500 welcome coin va jamoa yaratish\n\n' +
          '2. 👑 ULTRA — 79,900 so\'m / 300 Stars\n' +
          '• 🛡️ Qat\'iy himoya (cheksiz hududlar)\n' +
          '• ⚡ 3x XP va 🪙 2x GeoCoins\n' +
          '• 🎁 7 500 welcome coin, cheksiz jamoa a\'zolari va barcha skinlar bepul!\n\n' +
          'Obuna bo\'lish uchun /obuna yoki /obuna_ultra komandasini yuboring.'
        );
      } catch {}
    });

    // ── Barcha xabarlar ───────────────────────────────────────────────────────
    bot.on('message', async (msg) => {
      const chatId = String(msg.chat.id);
      const msgType = msg.successful_payment ? 'payment'
        : msg.photo   ? 'photo'
        : msg.contact ? 'contact'
        : msg.text    ? 'text'
        : 'other';
      logger.info(`Bot xabar: chatId=${chatId}, type=${msgType}`);

      // Stars to'lov muvaffaqiyatli
      if (msg.successful_payment) {
        return handleSuccessfulPayment(msg);
      }

      // Chek rasmi — faqat obuna kutilayotgan foydalanuvchidan
      if (msg.photo) {
        const session = await prisma.botSession.findFirst({
          where: {
            chatId: String(chatId),
            type: { startsWith: 'pendingReceipt:' },
            expiresAt: { gt: new Date() },
          }
        }).catch(() => null);

        if (session) {
          const parts = session.type.split(':');
          const tier = parts[1] || 'pro';
          const period = parts[2] || 'monthly';
          const promoCode = parts[3] || null;
          return handleReceipt(msg, tier, period, promoCode, session.createdAt);
        }
        return bot.sendMessage(msg.chat.id,
          'Rasm qabul qilindi.\nAgar obuna uchun chek yuborayotgan bo\'lsangiz, avval /obuna komandasini yuboring.'
        ).catch(() => {});
      }

      // Kontakt ulashish
      if (msg.contact) {
        return handleContact(msg);
      }
    });

    // ── Stars pre-checkout (har doim ruxsat beramiz) ──────────────────────────
    bot.on('pre_checkout_query', async (query) => {
      try {
        await bot.answerPreCheckoutQuery(query.id, true);
      } catch (err) {
        logger.error('pre_checkout_query error:', err.message);
        try { await bot.answerPreCheckoutQuery(query.id, false, 'Xatolik'); } catch {}
      }
    });

    // ── Kontakt ulashish ──────────────────────────────────────────────────────
    bot.on('contact', async () => {}); // message handler allaqachon ushlaydi

    async function handleContact(msg) {
      const chatId  = String(msg.chat.id);
      const contact = msg.contact;

      logger.info(`Bot kontakt: chatId=${chatId}, phone=${contact.phone_number}`);

      if (contact.user_id && contact.user_id !== msg.from.id) {
        return bot.sendMessage(chatId,
          '❌ Iltimos, faqat o\'z raqamingizni ulashing.',
          { reply_markup: { remove_keyboard: true } }
        );
      }

      const incomingPhone = normalizePhone(contact.phone_number);

      // Avval OTP sessiyasini topamiz (OTP oqimi)
      let session;
      try {
        session = await prisma.oTPSession.findFirst({
          where: {
            OR: [
              { chatId, otpSent: false, verified: false },
              { phone: incomingPhone, otpSent: false, verified: false },
            ],
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'desc' },
        });
      } catch (err) {
        logger.error('Bot sessiya topishda xato:', err.message);
        return bot.sendMessage(chatId, '⚠️ Server xatosi. Qaytadan urinib ko\'ring.');
      }

      // OTP oqimi — sessiya topildi
      if (session) {
        if (!session.chatId) {
          await prisma.oTPSession.update({
            where: { id: session.id },
            data: { chatId }
          }).catch(() => {});
        }

        const expectedPhone = normalizePhone(session.phone);
        if (incomingPhone !== expectedPhone) {
          return bot.sendMessage(chatId,
            `❌ Raqam mos kelmadi!\n\nIlovada <b>+${expectedPhone}</b> raqami uchun so'rov yaratilgan.`,
            { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
          );
        }

        const otpPlain = session.otp;
        const otpHash  = crypto.createHash('sha256').update(otpPlain).digest('hex');
        // Yuborilgandan keyin: hash saqlanadi, plaintext o'chiriladi
        await prisma.oTPSession.update({
          where: { id: session.id },
          data: {
            otpSent: true,
            otpHash,
            otp: null,
          }
        }).catch(() => {});
        bot.sendMessage(chatId,
          `✅ Raqam tasdiqlandi!\n\n🔑 Sizning kodingiz:\n\n<code>${otpPlain}</code>\n\n⏱ Kod 5 daqiqa amal qiladi.`,
          { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
        );
        logger.info(`Bot OTP yuborildi: chatId=${chatId}`);
        return;
      }

      // /obuna oqimi — hisob ulash va karta yuborish
      const obunaSession = await prisma.botSession.findFirst({
        where: {
          chatId: String(chatId),
          type: { startsWith: 'pendingObuna:' },
          expiresAt: { gt: new Date() },
        }
      }).catch(() => null);

      if (obunaSession) {
        const parts = obunaSession.type.split(':');
        const tier = parts[1] || 'pro';
        const period = parts[2] || 'monthly';
        const promoCode = parts[3] || null;

        // Delete this session
        await prisma.botSession.delete({
          where: { chatId_type: { chatId: String(chatId), type: obunaSession.type } }
        }).catch(() => {});

        try {
          const userFound = await prisma.user.findUnique({
            where: { phone: incomingPhone },
            select: { id: true, username: true }
          });

          if (userFound) {
            const user = await prisma.user.update({
              where: { id: userFound.id },
              data: { telegramChatId: chatId },
              select: { username: true }
            });

            await bot.sendMessage(chatId,
              `Hisob tasdiqlandi, ${user.username}!\nKarta ma'lumotlari yuborilmoqda...`,
              { reply_markup: { remove_keyboard: true } }
            );
            await sendCardInfo(chatId, tier, period, promoCode);
          } else {
            await bot.sendMessage(chatId,
              'Bu raqam ilovada topilmadi.\nAvval ilovadan ro\'yxatdan o\'ting.',
              { reply_markup: { remove_keyboard: true } }
            );
          }
        } catch (err) {
          logger.error('Obuna link xato:', err.message);
          await bot.sendMessage(chatId, 'Xatolik. Keyinroq urinib koring.').catch(() => {});
        }
        return;
      }

      // /link oqimi — mavjud foydalanuvchi chatId ni bog'laydi
      try {
        const existingInfo = await prisma.user.findUnique({
          where: { phone: incomingPhone },
          select: { id: true, username: true }
        });

        if (existingInfo) {
          const existing = await prisma.user.update({
            where: { id: existingInfo.id },
            data: { telegramChatId: chatId },
            select: { username: true }
          });
          bot.sendMessage(chatId,
            `✅ @${existing.username}, akkauntingiz Telegram ga ulandi!\n\nEndi /premium orqali obuna bo'lishingiz mumkin.`,
            { reply_markup: { remove_keyboard: true } }
          );
        } else {
          bot.sendMessage(chatId,
            '⏰ Aktiv so\'rov topilmadi.\n\nIlovada ro\'yxatdan o\'tish sahifasiga o\'ting.',
            { reply_markup: { remove_keyboard: true } }
          );
        }
      } catch (err) {
        logger.error('Link error:', err.message);
        bot.sendMessage(chatId, '⚠️ Xatolik yuz berdi.');
      }
    }

    bot.on('polling_error', (err) => logger.error('Bot polling xatosi:', err.message));

    return bot;
  } catch (err) {
    logger.error('OTP Bot xatosi:', err.message || String(err));
    return null;
  }
}

function getBot() { return bot; }

module.exports = { initBot, getBot, sendPremiumInvoice };
