const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/database');

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9) return '998' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '998' + digits.slice(1);
  return digits;
}

// Birinchi admin mavjudmi tekshirish
router.get('/status', async (req, res) => {
  try {
    const exists = await prisma.user.findFirst({ where: { isAdmin: true } });
    res.json({ available: !exists });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// Birinchi adminni yaratish (faqat hech qanday admin yo'q bo'lganda ishlaydi)
router.post('/', async (req, res) => {
  try {
    const exists = await prisma.user.findFirst({ where: { isAdmin: true } });
    if (exists) {
      return res.status(403).json({ error: 'Admin allaqachon mavjud. Ro\'yxatdan o\'tish yopiq.' });
    }

    const { username, phone, password } = req.body;
    if (!username || !phone || !password) {
      return res.status(400).json({ error: 'username, phone va password majburiy' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Parol kamida 6 ta belgi bo\'lishi kerak' });
    }

    const normalized = normalizePhone(phone);
    const taken = await prisma.user.findFirst({
      where: { OR: [{ username }, { phone: normalized }] }
    });
    
    if (taken) {
      return res.status(409).json({ error: 'Username yoki telefon allaqachon band' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        username,
        phone: normalized,
        passwordHash,
        isAdmin: true,
        termsAccepted: true,
        color: '#00ff88',
      }
    });

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Server xatosi' });
  }
});

module.exports = router;
