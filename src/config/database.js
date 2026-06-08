const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

const prisma = new PrismaClient({
  log: ['warn', 'error'],
});

async function initializeDatabase() {
  try {
    await prisma.$connect();
    // PostGIS kengaytmasini faollashtirish (geografik so'rovlar uchun)
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis;');
    logger.info('PostgreSQL (Prisma) connected & PostGIS enabled');
  } catch (err) {
    logger.error('PostgreSQL connection error:', err);
    process.exit(1);
  }
}

module.exports = { initializeDatabase, prisma };
