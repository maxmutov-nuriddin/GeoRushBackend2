// Strukturaviy (JSON) xavfsizlik-hodisa logi. Bir xil sxema bo'yicha yoziladi —
// log-aggregator (Render logs, Datadog, Grafana Loki) yoki Sentry'da qidirish/alert oson.
// Parol/token kabi maxfiy maydonlar HECH QACHON yozilmaydi.
//   'info'  — odatiy audit; 'warn' — e'tibor (401/403); 'error' — shubhali → Sentry'ga ham.

const logger = require('./logger');
const { getIp } = require('../middleware/ipBlocker');

let Sentry = null;
try { Sentry = require('../../instrument'); } catch { /* Sentry ixtiyoriy */ }

function logSecurityEvent(event, { req = null, severity = 'warn', userId = null, ...extra } = {}) {
  const entry = {
    kind: 'security',
    event,
    severity,
    ts: new Date().toISOString(),
    ip: req ? getIp(req) : (extra.ip || null),
    method: req ? req.method : null,
    path: req ? (req.originalUrl || req.url) : null,
    userId: userId || (req && req.user && req.user.id) || null,
    ua: req && req.headers ? req.headers['user-agent'] : null,
    ...extra,
  };

  const line = JSON.stringify(entry);
  if (severity === 'error') logger.error(line);
  else if (severity === 'info') logger.info(line);
  else logger.warn(line);

  if (severity === 'error' && Sentry && typeof Sentry.captureMessage === 'function') {
    try { Sentry.captureMessage(`[security] ${event}`, { level: 'warning', extra: entry }); } catch { /* best-effort */ }
  }
}

module.exports = { logSecurityEvent };
