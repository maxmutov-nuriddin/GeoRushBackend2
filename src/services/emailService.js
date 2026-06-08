const dns = require('dns');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Gmail SMTP ko'pincha IPv6 orqali ulanishga harakat qiladi, lekin ko'p tarmoqlarda
// IPv6 ishlamaydi — IPv4 ni birinchi ishlatishga majburlaymiz
dns.setDefaultResultOrder('ipv4first');

// SMTP sozlanmagan bo'lsa graceful fallback — production'da .env ga qo'shish kerak:
// EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
const isConfigured = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);

let transporter = null;

if (isConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true',
    family: 4, // IPv6 o'rniga IPv4 majburlash
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

async function sendPasswordResetEmail(email, resetUrl) {
  if (!isConfigured) {
    // Development rejimida link'ni log'ga chiqarish
    logger.warn(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `GeoRush <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'GeoRush — Parolni tiklash',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0a0a0f;color:#f0f0f8;padding:32px;border-radius:16px">
          <h2 style="color:#00ff88;margin-top:0">GeoRush</h2>
          <h3 style="color:#f0f0f8">Parolni tiklash</h3>
          <p style="color:#888;line-height:1.6">
            Parolni tiklash uchun quyidagi tugmani bosing. Link 15 daqiqa davomida amal qiladi.
          </p>
          <a href="${resetUrl}"
            style="display:inline-block;background:#00ff88;color:#0a0a0f;font-weight:bold;
                   padding:12px 28px;border-radius:12px;text-decoration:none;margin:16px 0">
            Parolni tiklash
          </a>
          <p style="color:#555;font-size:12px;margin-top:24px">
            Agar siz bu so'rovni yubormagan bo'lsangiz, ushbu xatni e'tiborsiz qoldiring.
          </p>
        </div>
      `,
    });
    logger.info(`Password reset email sent to ${email}`);
  } catch (err) {
    logger.error(`Failed to send password reset email to ${email}`, err);
    throw new Error('Email yuborishda xato yuz berdi');
  }
}

module.exports = { sendPasswordResetEmail };
