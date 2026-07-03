// ─── Piyoda trafik hisoboti (admin, read-only) ────────────────────────────────
// TrafficCell anonim agregatidan B2B/B2G ko'rinishidagi hisobot:
// xarita kataklari, soat/hafta-kuni taqsimoti, eng gavjum nuqtalar.
// Filtr: ?dow=0..6 (hafta kuni), ?hour=0..23 — ikkalasi ixtiyoriy.
const { prisma } = require('../config/database');

async function getTrafficAnalytics(req, res) {
  try {
    const dow = req.query.dow !== undefined ? parseInt(req.query.dow) : null;
    const hour = req.query.hour !== undefined ? parseInt(req.query.hour) : null;
    const dowOk = Number.isInteger(dow) && dow >= 0 && dow <= 6;
    const hourOk = Number.isInteger(hour) && hour >= 0 && hour <= 23;

    // Filtr shartlari — faqat tekshirilgan raqamlar qo'shiladi
    const conds = [];
    if (dowOk) conds.push(`"dow" = ${dow}`);
    if (hourOk) conds.push(`"hour" = ${hour}`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const TZ_OFFSET_MIN = parseInt(process.env.TRAFFIC_TZ_OFFSET_MIN || '300');
    const todayStr = new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

    const [totals, hourly, daily, cells, todayRow] = await Promise.all([
      // Umumiy: nechta katak qamrab olingan, jami o'tishlar
      prisma.$queryRawUnsafe(`
        SELECT COUNT(DISTINCT ("cellLat", "cellLng"))::int AS "cellCount",
               COALESCE(SUM("count"), 0)::int AS "totalVisits",
               MAX("updatedAt") AS "lastUpdate"
        FROM "TrafficCell" ${where}
      `),
      // Soat taqsimoti (0-23) — "eng gavjum vaqt" grafigi
      prisma.$queryRawUnsafe(`
        SELECT "hour", COALESCE(SUM("count"), 0)::int AS "visits"
        FROM "TrafficCell" ${dowOk ? `WHERE "dow" = ${dow}` : ''}
        GROUP BY "hour" ORDER BY "hour"
      `),
      // Hafta kuni taqsimoti (0=yak ... 6=shan)
      prisma.$queryRawUnsafe(`
        SELECT "dow", COALESCE(SUM("count"), 0)::int AS "visits"
        FROM "TrafficCell" ${hourOk ? `WHERE "hour" = ${hour}` : ''}
        GROUP BY "dow" ORDER BY "dow"
      `),
      // Xarita kataklari — filtr bo'yicha jamlangan, eng gavjum 3000 tasi
      prisma.$queryRawUnsafe(`
        SELECT COALESCE("snapLat", "cellLat") AS lat,
               COALESCE("snapLng", "cellLng") AS lng,
               SUM("count")::int AS "visits"
        FROM "TrafficCell" ${where}
        GROUP BY 1, 2
        ORDER BY "visits" DESC
        LIMIT 3000
      `),
      // Bugungi REAL yuruvchilar soni (TrafficDaily — faqat raqam, userId yo'q)
      prisma.$queryRawUnsafe(`SELECT "walkers" FROM "TrafficDaily" WHERE "date" = $1`, todayStr),
    ]);

    res.json({
      todayWalkers: todayRow[0]?.walkers || 0,
      totalVisits: totals[0]?.totalVisits || 0,
      cellCount: totals[0]?.cellCount || 0,
      lastUpdate: totals[0]?.lastUpdate || null,
      hourly,       // [{hour, visits}]
      daily,        // [{dow, visits}]
      cells,        // [{lat, lng, visits}] — xarita + top nuqtalar ro'yxati shu
      filter: { dow: dowOk ? dow : null, hour: hourOk ? hour : null },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getTrafficAnalytics };
