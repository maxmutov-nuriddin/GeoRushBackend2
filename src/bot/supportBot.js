const TelegramBot = require('node-telegram-bot-api');
const logger = require('../utils/logger');
const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { escapeHtml } = require('../utils/telegram');

let supportBot = null;
let botUsername = null; // init'da bir marta olinadi (har xabarda getMe chaqirmaymiz)

// Til bo'yicha "yordamга yozish" tugma matni
function supportButtonText(lang) {
  if (lang && lang.startsWith('ru')) return '✍️ Написать в поддержку';
  if (lang && lang.startsWith('en')) return '✍️ Message Support';
  return '✍️ Yordam xizmatiga yozish';
}
// DOIM ko'rinib turadigan (persistent) tugma — bosgandан keyin ham yo'qolmaydi.
function supportKeyboard(lang) {
  return {
    keyboard: [[{ text: supportButtonText(lang) }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function initSupportBot() {
  const token = process.env.SUPPORT_BOT_TOKEN;
  const adminChatId = process.env.SUPPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    logger.info('SUPPORT_BOT_TOKEN yo\'q, Yordamchi bot (Support Bot) o\'chiq holatda.');
    return;
  }

  try {
    // Scale-out himoyasi (OTP botdagi bilan bir xil): Telegram bitta tokenга faqat BITTA
    // polling iste'molchiga ruxsat beradi. Ko'p instance ishlatilsa, faqat bittasida polling
    // qolsin — qolganlarida BOT_POLLING=false. Polling o'chiq instance ham xabar YUBORA oladi
    // (sendReplyFromWeb/sendMessage polling talab qilmaydi), faqat KELGAN xabarni tinglamaydi.
    // Default (BOT_POLLING o'rnatilmagan) → polling YOQIQ — bitta instance uchun hech nima o'zgarmaydi.
    const pollingEnabled = process.env.BOT_POLLING !== 'false';
    supportBot = new TelegramBot(token, { polling: pollingEnabled });
    botUsername = (await supportBot.getMe()).username; // bir marta keshlaymiz
    logger.info(`Support Bot started successfully (@${botUsername})${pollingEnabled ? '' : ' (faqat yuborish — polling o\'chiq)'}.`);

    // Har qanday kelgan xabarni tinglash
    supportBot.on('message', async (msg) => {
      // Tizim xabarlari (masalan guruhga qo'shilgandagi) kerak emas
      if (!msg.text && !msg.photo && !msg.document) return;

      const chatId = String(msg.chat.id);
      const isFromAdminGroup = (chatId === String(adminChatId));

      try {
        if (isFromAdminGroup) {
          // Admin /start — xush kelibsiz xabari
          if (msg.text === '/start') {
            await supportBot.sendMessage(msg.chat.id,
              '👋 Xush kelibsiz, admin!\n\nFoydalanuvchilar murojaatlari shu yerga keladi. Javob berish uchun xabarга <b>Reply</b> qiling yoki admin paneldan yozing.',
              { parse_mode: 'HTML' });
            return;
          }
          // Reply — bot jo'natgan xabarга javob (keshlangan username bilan, getMe'siz)
          if (msg.reply_to_message && botUsername && msg.reply_to_message.from?.username === botUsername) {
            await handleAdminReply(msg);
          }
          return;
        }

        // Foydalanuvchining shaxsiy (private) xabari
        if (msg.chat.type === 'private') {
          // /start komandasi uchun
          if (msg.text === '/start') {
            await handleStartCommand(msg);
            return;
          }

          // Tugmalarni bosganda (xabar yozishni so'rash)
          const buttonTexts = ['✍️ Написать в поддержку', '✍️ Message Support', '✍️ Yordam xizmatiga yozish'];
          if (msg.text && buttonTexts.includes(msg.text)) {
            const lang = msg.from?.language_code || 'uz';
            let promptText = '';

            if (lang.startsWith('ru')) {
              promptText = 'Пожалуйста, напишите ваше сообщение здесь. Мы передадим его администратору:';
            } else if (lang.startsWith('en')) {
              promptText = 'Please write your message here. We will deliver it to the admin:';
            } else {
              promptText = 'Iltimos, xabaringizni shu yerga yozing. Biz uni adminga yetkazamiz:';
            }

            await supportBot.sendMessage(msg.chat.id, promptText, {
              reply_markup: supportKeyboard(lang) // Tugma DOIM ko'rinib turadi (yo'qolmaydi)
            });
            return;
          }
          
          // Qolgan barcha oddiy xabarlarni adminga yuborish
          await handleUserMessage(msg, adminChatId);
        }
      } catch (err) {
        logger.error('Support Bot xabarni ishlashda xatolik:', err);
      }
    });

    // "✍️ Javob berish" tugmasi bosilганда — force-reply prompt chiqaramiz.
    // Prompt ichида ID bo'lgani uchun admin shunга javob yozса handleAdminReply o'qiydi.
    supportBot.on('callback_query', async (q) => {
      try {
        const data = q.data || '';
        if (data.startsWith('reply:')) {
          const targetId = data.slice(6);
          await supportBot.answerCallbackQuery(q.id).catch(() => {});
          await supportBot.sendMessage(q.message.chat.id,
            `💬 Javob yozing:\n🆔 ID: ${targetId}`,
            { reply_markup: { force_reply: true } });
        }
      } catch (err) {
        logger.error('Support Bot callback xatosi:', err.message);
      }
    });

  } catch (err) {
    logger.error('Support Bot ishga tushishda xatolik:', err);
  }
}

// /start komandasi
async function handleStartCommand(msg) {
  const chatId = msg.chat.id;
  const lang = msg.from.language_code || 'uz';
  
  let welcomeText = '';
  let buttonText = '';

  if (lang.startsWith('ru')) {
    welcomeText = 'Здравствуйте! Напишите ваш вопрос, и наша команда поддержки ответит вам в ближайшее время.';
    buttonText = '✍️ Написать в поддержку';
  } else if (lang.startsWith('en')) {
    welcomeText = 'Hello! Write your question and our support team will answer you shortly.';
    buttonText = '✍️ Message Support';
  } else {
    // Default: uz
    welcomeText = 'Assalomu alaykum! Savolingizni yozib qoldiring, qo\'llab-quvvatlash jamoamiz tez orada javob beradi.';
    buttonText = '✍️ Yordam xizmatiga yozish';
  }

  await supportBot.sendMessage(chatId, welcomeText, {
    reply_markup: supportKeyboard(lang) // DOIM ko'rinadigan tugma
  });
}

// Foydalanuvchidan kelgan xabar
async function handleUserMessage(msg, adminChatId) {
  const tgChatId = String(msg.chat.id);
  // Rasm bormi? Telegram bir nechta o'lchamni beradi — eng kattasini olamiz.
  const photoFileId = (msg.photo && msg.photo.length)
    ? msg.photo[msg.photo.length - 1].file_id
    : null;
  // "Fayl sifatida" yuborilgan rasm/hujjat — msg.document'da keladi (photo emas).
  const documentFileId = msg.document ? msg.document.file_id : null;
  // Caption matni (yoki media turига qarab belgи); aks holda oddiy matn.
  const text = msg.text || msg.caption
    || (photoFileId ? '[📷 Rasm]' : documentFileId ? `[📎 Fayl: ${msg.document.file_name || 'hujjat'}]` : '[Media/Fayl xabari]');
  const tgName = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi';
  const tgUsername = msg.chat.username ? `@${msg.chat.username}` : null;

  // DB ga saqlaymiz yoki yangilaymiz
  const supportChat = await prisma.supportChat.upsert({
    where: { tgChatId },
    update: {
      tgName,
      tgUsername,
      status: 'open',
      unreadCount: { increment: 1 },
      lastMessageAt: new Date(),
    },
    create: {
      tgChatId,
      tgName,
      tgUsername,
      status: 'open',
      unreadCount: 1,
    }
  });

  const supportMsg = await prisma.supportMessage.create({
    data: {
      chatId: supportChat.id,
      sender: 'user',
      text,
      messageId: String(msg.message_id),
    }
  });

  // Admin panelga (Web) real-time xabar jo'natamiz — FAQAT adminlarга ('admin' xonasi),
  // io.emit BARCHA o'yinchilarга tarqatardi (maxfiylik buzilishi).
  const io = getIo();
  if (io) {
    io.to('admin').emit('new_support_message', {
      chat: supportChat,
      message: supportMsg
    });
  }

  // Admin guruhiga yuboramiz — xabar TAGIDA "Javob berish" tugmasi (bosib javob yoziladi).
  // Rasm bo'lsa sendPhoto (file_id orqali — bizning serverga/DBга saqlanmaydi, faqat
  // Telegram serveri orqali to'g'ridan-to'g'ri uzatiladi). Caption ichida ham ID bor —
  // shu sababli admin rasmga reply qilса handleAdminReply ID ni o'qiy oladi.
  if (adminChatId) {
    const caption = msg.caption ? `\n\n💬 <b>Xabar:</b>\n${escapeHtml(msg.caption)}` : '';
    const adminText = `🚨 <b>Yangi murojaat</b>\n\n👤 <b>Kimdan:</b> ${escapeHtml(tgName)} ${tgUsername ? `(${tgUsername})` : ''}\n🆔 <b>ID:</b> <code>${tgChatId}</code>`;
    const replyMarkup = {
      inline_keyboard: [[{ text: '✍️ Javob berish', callback_data: `reply:${tgChatId}` }]],
    };

    if (photoFileId) {
      await supportBot.sendPhoto(adminChatId, photoFileId, {
        caption: `${adminText}${caption}`,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } else if (documentFileId) {
      // Fayl sifatида yuborilган rasm/hujjat — sendDocument (file_id orqali, saqlanmaydi).
      await supportBot.sendDocument(adminChatId, documentFileId, {
        caption: `${adminText}${caption}`,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } else {
      const fullText = `${adminText}\n\n💬 <b>Xabar:</b>\n${escapeHtml(text)}`;
      await supportBot.sendMessage(adminChatId, fullText, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    }
  }

  // Foydalanuvchiga avtomatik javob qaytaramiz
  const lang = msg.from?.language_code || 'uz';
  let autoReply = '';

  if (lang.startsWith('ru')) {
    autoReply = '✅ Спасибо за ваше сообщение! Наша команда ответит вам в ближайшее время.';
  } else if (lang.startsWith('en')) {
    autoReply = '✅ Thank you for your message! Our team will reply to you shortly.';
  } else {
    // Default: uz
    autoReply = '✅ Xabaringiz uchun rahmat! Tez orada javob beramiz.';
  }

  // Tugma DOIM ko'rinib tursin (xabardan keyin ham)
  await supportBot.sendMessage(tgChatId, autoReply, { reply_markup: supportKeyboard(lang) });
}

// Admindan (guruhdan) kelgan javob (Reply)
async function handleAdminReply(msg) {
  // Admin rasm bilan javob berса — eng katta o'lchamli rasmning file_id'sini olamiz.
  const photoFileId = (msg.photo && msg.photo.length)
    ? msg.photo[msg.photo.length - 1].file_id
    : null;
  // Admin "fayl sifatида" rasm/hujjat yuborса — msg.document'да keladi.
  const documentFileId = msg.document ? msg.document.file_id : null;
  const replyText = msg.text || msg.caption
    || (photoFileId ? '[📷 Rasm]' : documentFileId ? `[📎 Fayl: ${msg.document.file_name || 'hujjat'}]` : '[Media/Fayl javobi]');

  // Asl xabardagi "ID: 12345678" qismini qidiramiz.
  // Rasmli murojaatда matn .caption'да bo'ladi (.text emas) — ikkalasini ham tekshiramiz.
  const originalText = msg.reply_to_message.text || msg.reply_to_message.caption || '';
  const idMatch = originalText.match(/🆔 ID:\s*(\d+)/);
  if (!idMatch) return; // ID topilmadi, xabar foydalanuvchiniki emas

  const targetTgChatId = idMatch[1];

  // Foydalanuvchiga yuboramiz — rasm bo'lsa sendPhoto (file_id orqali, hech qayerga
  // saqlanmaydi), aks holda oddiy matn.
  if (photoFileId) {
    const cap = msg.caption ? `\n\n${escapeHtml(msg.caption)}` : '';
    await supportBot.sendPhoto(targetTgChatId, photoFileId, {
      caption: `💬 <b>Yordam xizmati:</b>${cap}`,
      parse_mode: 'HTML',
    });
  } else if (documentFileId) {
    const cap = msg.caption ? `\n\n${escapeHtml(msg.caption)}` : '';
    await supportBot.sendDocument(targetTgChatId, documentFileId, {
      caption: `💬 <b>Yordam xizmati:</b>${cap}`,
      parse_mode: 'HTML',
    });
  } else {
    await supportBot.sendMessage(targetTgChatId, `💬 <b>Yordam xizmati:</b>\n\n${escapeHtml(replyText)}`, { parse_mode: 'HTML' });
  }

  // Adminга tasdiq — "Xabaringiz jo'natildi"
  await supportBot.sendMessage(msg.chat.id, '✅ Xabaringiz foydalanuvchiga jo\'natildi.', {
    reply_to_message_id: msg.message_id,
  }).catch(() => {});

  // DB da xatni saqlaymiz
  const supportChat = await prisma.supportChat.findUnique({ where: { tgChatId: targetTgChatId } });
  if (supportChat) {
    const supportMsg = await prisma.supportMessage.create({
      data: {
        chatId: supportChat.id,
        sender: 'admin',
        text: replyText,
      }
    });

    // Chatni yangilaymiz (yopildi deb emas, prosta lastMessage)
    const updatedChat = await prisma.supportChat.update({
      where: { id: supportChat.id },
      data: { lastMessageAt: new Date(), unreadCount: 0 } // Admin javob berdi, demak o'qildi
    });

    // Web Admin paneliga ham sinxronizatsiya — FAQAT adminlarга ('admin' xonasi)
    const io = getIo();
    if (io) {
      io.to('admin').emit('new_support_message', {
        chat: updatedChat,
        message: supportMsg
      });
    }
  }
}

// Web Admin Paneldan javob yozish (REST API orqali chaqiriladi)
async function sendReplyFromWeb(tgChatId, text) {
  if (!supportBot) throw new Error('Support Bot ishlamayapti');
  
  await supportBot.sendMessage(tgChatId, `💬 <b>Yordam xizmati:</b>\n\n${escapeHtml(text)}`, { parse_mode: 'HTML' });
}

module.exports = {
  initSupportBot,
  sendReplyFromWeb
};
