// Sentry init — boshqa hamma narsadan OLDIN yuklanishi kerak (server.js'ning 1-qatorida).
// MUHIM: SENTRY_DSN o'rnatilmagan bo'lsa Sentry BUTUNLAY o'chiq (enabled: false) —
// hech narsa yubormaydi, hech narsani patch qilmaydi, ishlab turgan kodga 0 ta ta'sir.
// Faqat siz Render env'iga SENTRY_DSN qo'shganingizda faollashadi.
const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN || '';

Sentry.init({
  dsn: dsn || undefined,
  enabled: !!dsn,                              // DSN yo'q → to'liq o'chiq
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 0,                         // performance tracing yo'q — faqat crash/xato
  sendDefaultPii: false,                       // shaxsiy ma'lumot yuborilmaydi
});

if (dsn) {
  // eslint-disable-next-line no-console
  console.log('[Sentry] crash reporting yoqildi');
}

module.exports = Sentry;
