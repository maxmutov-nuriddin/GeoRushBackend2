const TelegramBot  = require('node-telegram-bot-api');
const crypto       = require('crypto');
const logger       = require('../utils/logger');
// Umumiy (yagona) Prisma instansi — alohida client ochmaymiz (ulanishlarni tejaymiz).
const { prisma }   = require('../config/database');
// welcomeCoins kabi qiymatlar uchun YAGONA manba — tiers.js. Avval bu faylda 350/1000
// hardcode edi, admin panel esa tiers'dagi 2500/7500 berardi — bir xil narxga har xil bonus.
const { TIERS }    = require('../config/tiers');
const { recordPremiumPurchase } = require('../services/premiumLedger');
const { promoApplies, userAlreadyUsedPromo } = require('../controllers/promoController');

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
  if (discountPct >= 100) return 0;
  return Math.max(1000, Math.round(base * (1 - discountPct / 100)));
}

async function grantPremiumFree(chatId, userId, tier, period, promoCode) {
  const days = PREMIUM_DAYS[period] || 30;
  const coinsBonus = (TIERS[tier] || TIERS.pro).welcomeCoins;
  const xpMult = tier === 'ultra' ? '3x' : '2x';
  const periodLabel = period === 'yearly' ? '12 oy (365 kun)' : '30 kun';

  if (promoCode) {
    await prisma.promoCode.updateMany({
      where: { code: promoCode.toUpperCase() },
      data: { usesCount: { increment: 1 } }
    }).catch(() => {});
  }

  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { premiumUntil: true } });
  const base = (existing?.premiumUntil && existing.premiumUntil > new Date())
    ? existing.premiumUntil.getTime()
    : Date.now();
  const premiumUntil = new Date(base + days * 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: userId },
    data: { isPremium: true, premiumUntil, premiumTier: tier, premiumIsGift: true, coins: { increment: coinsBonus } }
  });

  const until = premiumUntil.toLocaleDateString('uz-UZ');
  await bot.sendMessage(chatId,
    `🎉 GeoRush ${tier.toUpperCase()} faollashtirildi! (100% promokod)\n\n` +
    `⏳ Muddati: ${until} gacha (${periodLabel})\n` +
    `⚡ ${xpMult} XP yoqildi\n` +
    `🪙 +${coinsBonus.toLocaleString()} GeoCoins berildi!`
  );
  logger.info(`Free premium granted: userId=${userId}, tier=${tier}, period=${period}, promoCode=${promoCode}`);
}

function formatSom(amount) {
  return amount.toLocaleString('uz-UZ').replace(/,/g, ' ');
}

// ── Asosiy menyu tugmalari: Obuna + Yordam (DOIM ko'rinadigan persistent klaviatura) ──
const MENU_PREMIUM = '💎 Obuna';
const MENU_HELP = '🆘 Yordam';
function mainMenuRow() {
  return [{ text: MENU_PREMIUM }, { text: MENU_HELP }];
}
// Raqam tasdiqlangandan keyin ham Obuna + Yordam tugmalari DOIM ko'rinib tursin
// (avval remove_keyboard bilan klaviatura butunlay yo'qolardi).
function mainMenuKeyboard() {
  return { keyboard: [mainMenuRow()], resize_keyboard: true, is_persistent: true };
}

// Premium tariflari — /premium komandasi VA "💎 Obuna" tugmasi shuni ishlatadi.
async function sendPremiumInfo(chatId) {
  if (!bot) return;
  try {
    const user = await prisma.user.findFirst({
      where: { telegramChatId: String(chatId) },
      select: { username: true, isPremium: true, premiumUntil: true, premiumTier: true },
    });
    if (user && isActivePremium(user)) {
      const until = new Date(user.premiumUntil).toLocaleDateString('uz-UZ');
      const tierName = (user.premiumTier || 'pro').toUpperCase();
      return bot.sendMessage(chatId,
        `@${user.username} — Premium ${tierName} faol\nMuddati: ${until}\n\nLimitlar va imtiyozlar faollashtirilgan.`);
    }
    return bot.sendMessage(chatId,
      'GeoRush Premium tariflari:\n\n' +
      '1. 💎 PRO — 39,900 so\'m / 150 Stars\n' +
      '• 🛡️ Hudud himoyasi (daraja marjasi 5)\n' +
      '• ⚡ 2x XP va 🪙 1.5x GeoCoins\n' +
      '• 🎁 2 500 welcome coin va jamoa yaratish\n\n' +
      '2. 👑 ULTRA — 79,900 so\'m / 300 Stars\n' +
      '• 🛡️ Qat\'iy himoya (cheksiz hududlar)\n' +
      '• ⚡ 3x XP va 🪙 2x GeoCoins\n' +
      '• 🎁 7 500 welcome coin, cheksiz jamoa a\'zolari va barcha skinlar bepul!\n\n' +
      'Obuna bo\'lish uchun GeoRush ilovasini oching → Premium → tarifni tanlab to\'lang (Telegram Stars).');
  } catch { /* jim */ }
}

// "🆘 Yordam" — support botга havola (alohida bot). Username SUPPORT_BOT_USERNAME env'дан.
async function sendSupportLink(chatId) {
  if (!bot) return;
  const username = (process.env.SUPPORT_BOT_USERNAME || '').replace(/^@/, '');
  if (username) {
    return bot.sendMessage(chatId,
      '🆘 Yordam kerakmi? Quyidagi tugma orqali qo\'llab-quvvatlash botiga o\'ting — savolingizni yozing, jamoamiz javob beradi:',
      { reply_markup: { inline_keyboard: [[{ text: '💬 Qo\'llab-quvvatlashga yozish', url: `https://t.me/${username}` }]] } });
  }
  return bot.sendMessage(chatId, '🆘 Yordam uchun @GeoRushSupportBot bilan bog\'laning.');
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
    if (promo && promo.isActive && new Date() <= promo.expiresAt && promoApplies(promo, tier, period)) {
      if (!promo.maxUses || promo.usesCount < promo.maxUses) {
        // Har user 1 marta — avval ishlatgan bo'lsa, chegirma qo'llanmaydi
        const usedBefore = await userAlreadyUsedPromo(userId, promoCode);
        if (!usedBefore) promoDiscount = promo.discountPct;
      }
    }
  }

  const effectiveDiscount = Math.max(welcomeDiscount, promoDiscount);
  if (effectiveDiscount >= 100) {
    return grantPremiumFree(chatId, userId, tier, period, promoCode);
  }
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
    // Idempotency: Telegram bir xil to'lovni qayta yuborsa (retry), ikki marta premium
    // berilmasligi va coins ikki marta qo'shilmasligi uchun charge ID bo'yicha tekshiramiz.
    const chargeId = payment.telegram_payment_charge_id || null;
    if (chargeId) {
      const dup = await prisma.premiumPurchase.findFirst({
        where: { chargeId: String(chargeId) }, select: { id: true }
      });
      if (dup) {
        logger.warn(`Takroriy Stars to'lovi e'tiborsiz qoldirildi: chargeId=${chargeId}, userId=${payload.userId}`);
        return;
      }
    }

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

    // Haqiqiy to'lov ledger'ga — chegirma actual to'langan Stars'dan aniqlanadi
    // (welcome + promo, ikkalasi ham finalStars ichida hisobga olingan).
    const starKey   = period === 'yearly' ? `${tier}_yearly` : tier;
    const baseStars = TIER_STARS[starKey] || TIER_STARS[tier] || 150;
    const paidStars = Number(payment.total_amount) || 0;
    const discountPct = baseStars > 0
      ? Math.max(0, Math.min(100, Math.round((1 - paidStars / baseStars) * 100)))
      : 0;
    await recordPremiumPurchase({
      userId: payload.userId, tier, period, method: 'stars',
      amountStars: paidStars,
      amountSom: calculateSomPrice(tier, period, discountPct),
      baseSom: calculateSomPrice(tier, period, 0),
      discountPct, promoCode, chargeId,
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
    await bot.sendMessage(msg.chat.id, '⚠️ Xatolik yuz berdi. @GeoRushSupportBot bilan bog\'laning.');
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

    // ── Karta orqali to'lov oqimi (sendCardInfo / sendObuna / handleReceipt) OLIB TASHLANDI ──
    // Premium endi faqat Telegram Stars orqali (ilovadan /api/premium/send-invoice → sendPremiumInvoice).

    // Karta orqali to'lov (/obuna) OLIB TASHLANDI — endi faqat Telegram Stars (ilovadan).
    // /obuna yozsa, foydalanuvchiga ilovadan to'lashni aytamiz.
    bot.onText(/^\/(start obuna|obuna)/, async (msg) => {
      await bot.sendMessage(msg.chat.id,
        "💎 Premium endi ilova orqali to'lanadi.\n\nGeoRush ilovasini oching → Premium → tarifni tanlab to'lang (Telegram Stars)."
      ).catch(() => {});
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
        '👋 Salom! GeoRush botiga xush kelibsiz.\n\n📱 Ro\'yxatdan o\'tish/ulanish uchun raqamingizni ulashing, yoki quyidagi tugmalardan foydalaning:',
        {
          reply_markup: {
            keyboard: [
              [{ text: '📱 Raqamni ulashish', request_contact: true }],
              mainMenuRow(), // 💎 Obuna  +  🆘 Yordam (doim ko'rinadi)
            ],
            resize_keyboard: true,
            is_persistent: true,
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
    bot.onText(/^\/premium$/, (msg) => sendPremiumInfo(msg.chat.id));

    // ── Menyu tugmalari ───────────────────────────────────────────────────────
    bot.onText(/^💎 Obuna$/, (msg) => sendPremiumInfo(msg.chat.id));
    bot.onText(/^🆘 Yordam$/, (msg) => sendSupportLink(msg.chat.id));

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

      // Rasm — karta cheki oqimi OLIB TASHLANDI. Premium endi ilovadan (Stars).
      if (msg.photo) {
        return bot.sendMessage(msg.chat.id,
          "Rasm qabul qilindi. Premium uchun GeoRush ilovasidan to'lov qiling (Telegram Stars)."
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

      // XAVFSIZLIK: faqat foydalanuvchining O'ZIGA tegishli, Telegram tasdiqlagan raqamni
      // qabul qilamiz. `request_contact: true` tugmasi har doim msg.from.id ga teng `user_id`
      // biriktiradi. Attachment orqali yuborilgan boshqa odamning yoki soxta (telegram'siz)
      // kontaktida `user_id` UMUMAN BO'LMAYDI — ilgari shart `contact.user_id && ...` edi,
      // shuning uchun user_id yo'q soxta kontakt guard'ni chetlab o'tib, hujumchi qurbon
      // OTP'sini o'z chatiga oldirib akkauntni egallashi mumkin edi.
      if (!contact.user_id || contact.user_id !== msg.from.id) {
        return bot.sendMessage(chatId,
          '❌ Iltimos, faqat o\'z raqamingizni "📱 Raqamni ulashish" tugmasi orqali ulashing.',
          { reply_markup: { remove_keyboard: true } }
        );
      }

      const incomingPhone = normalizePhone(contact.phone_number);

      // ── Mavjud hisobni DARHOL Telegram'ga bog'laymiz ─────────────────────────
      // Oqimdan qat'i nazar (register OTP / login / reset / /link): shu raqamli foydalanuvchi
      // bazada bo'lsa, telegramChatId ni o'rnatamiz. Aks holda telegramChatId faqat /link
      // (aktiv sessiya YO'Q) holatida yozilardi — natijada ko'p hisob bog'lanmay qolib, Stars
      // to'lovi 400 ("Telegram bot bilan ulanmagan") berardi. Raqam Telegram tomonidan
      // tasdiqlangan (yuqorida user_id === from.id), shuning uchun bog'lash xavfsiz.
      try {
        const u = await prisma.user.findUnique({
          where: { phone: incomingPhone },
          select: { id: true, telegramChatId: true },
        });
        if (u && u.telegramChatId !== chatId) {
          await prisma.user.update({ where: { id: u.id }, data: { telegramChatId: chatId } });
          logger.info(`telegramChatId bog'landi: userId=${u.id}`);
        }
      } catch (err) {
        logger.warn('telegramChatId bog\'lashda xato:', err.message);
      }

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
          { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
        );
        logger.info(`Bot OTP yuborildi: chatId=${chatId}`);
        return;
      }

      // (Karta /obuna oqimi olib tashlandi — pastdagi /link oqimi hisobni baribir bog'laydi.)

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
            `✅ @${existing.username}, akkauntingiz Telegram ga ulandi!\n\nEndi GeoRush ilovasidan Premium sotib olishingiz mumkin (Telegram Stars).`,
            { reply_markup: mainMenuKeyboard() }
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
