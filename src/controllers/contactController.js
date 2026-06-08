// Landing sahifasidagi "Bog'lanish" formasi uchun server-side endpoint.
// Telegram bot tokeni HECH QACHON client bundle'ga chiqmasligi kerak — shuning uchun
// xabar serverdan yuboriladi (TELEGRAM_BOT_TOKEN faqat backend env'da turadi).
async function sendContact(req, res, next) {
  try {
    const { name, phone, telegram, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return res.status(503).json({ error: 'Support not configured' });

    const tg  = telegram && telegram.trim() ? `@${telegram.trim().replace(/^@/, '')}` : '—';
    const ph  = phone && phone.trim() ? phone.trim() : '—';
    const nm  = name && name.trim() ? name.trim() : '—';
    const now = new Date().toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    const text = [
      `🎮 *GeoRush — Yordam so\'rovi*`,
      ``,
      `👤 *Ism:* ${nm}`,
      `📱 *Telefon:* ${ph}`,
      `✈️ *Telegram:* ${tg}`,
      `🕐 *Vaqt:* ${now}`,
      ``,
      `💬 *Xabar:*`,
      message.trim().slice(0, 4000), // Telegram xabar uzunligi chegarasi
    ].join('\n');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Failed to send' });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { sendContact };
