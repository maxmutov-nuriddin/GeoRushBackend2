const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

async function initializeDatabase() {
  try {
    await prisma.$connect();
    logger.info('PostgreSQL (Prisma) connected');
  } catch (err) {
    logger.error('PostgreSQL connection error:', err);
    process.exit(1);
  }
  // PostGIS kengaytmasini faollashtirish (geografik so'rovlar uchun).
  // Agar PostGIS hali o'rnatilmagan bo'lsa — serverni yiqitmaymiz, faqat ogohlantiramiz.
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis;');
    logger.info('PostGIS enabled');
  } catch (err) {
    logger.warn('PostGIS not available yet — geo features disabled until installed:', err.message);
  }
}

module.exports = { initializeDatabase, prisma };
