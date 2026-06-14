const express = require('express');
const router = express.Router();
const { prisma } = require('../config/database');
const { sendReplyFromWeb } = require('../bot/supportBot');

// Barcha support chatlarni olish (oxirgi xabar vaqtiga qarab)
router.get('/', async (req, res, next) => {
  try {
    const chats = await prisma.supportChat.findMany({
      orderBy: { lastMessageAt: 'desc' },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1, // faqat oxirgi xabarni ko'rsatish uchun
        }
      }
    });
    res.json(chats);
  } catch (err) {
    next(err);
  }
});

// Bitta chatning barcha xabarlarini olish
router.get('/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Chatni topamiz
    const chat = await prisma.supportChat.findUnique({ where: { id } });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Agar o'qilmagan xabarlar bo'lsa, nolga tushiramiz (Admin o'qidi)
    if (chat.unreadCount > 0) {
      await prisma.supportChat.update({
        where: { id },
        data: { unreadCount: 0 }
      });
    }

    const messages = await prisma.supportMessage.findMany({
      where: { chatId: id },
      orderBy: { createdAt: 'asc' },
    });
    
    res.json({ chat, messages });
  } catch (err) {
    next(err);
  }
});

// Admindan javob yuborish
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) return res.status(400).json({ error: 'Text required' });

    const chat = await prisma.supportChat.findUnique({ where: { id } });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    // Bot orqali foydalanuvchiga yuborish
    await sendReplyFromWeb(chat.tgChatId, text);

    // DB ga saqlash
    const supportMsg = await prisma.supportMessage.create({
      data: {
        chatId: id,
        sender: 'admin',
        text,
      }
    });

    // Chat yangilanishi
    const updatedChat = await prisma.supportChat.update({
      where: { id },
      data: { lastMessageAt: new Date(), unreadCount: 0 }
    });

    // Web Admin paneliga ham sinxronizatsiya qilamiz
    const { getIo } = require('../socket/ioInstance');
    const io = getIo();
    if (io) {
      io.to('admin').emit('new_support_message', {
        chat: updatedChat,
        message: supportMsg
      });
    }

    res.json({ success: true, message: supportMsg, chat: updatedChat });
  } catch (err) {
    next(err);
  }
});

// Chatni o'chirish
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const chat = await prisma.supportChat.findUnique({ where: { id } });
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    await prisma.supportChat.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
