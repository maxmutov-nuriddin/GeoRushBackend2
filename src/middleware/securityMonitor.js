// Anomaliyalarni IP bo'yicha kuzatuvchi middleware (MVP, in-memory).
//   1) Ko'p 401/403 bitta IP'dan — auth brute-force / scanning belgisi.
//   2) Bitta IP'dan so'rovlar keskin ko'pligi — request spike / DoS belgisi.
// Aniqlanganda bir marta (har oyna ichida) strukturaviy 'error' hodisa yoziladi
// (Sentry'ga ham eskalatsiya). Oddiy 4xx/5xx allaqachon morgan orqali loglanadi.
// Chegaralar env orqali. Scale-out bo'lsa Redis'ga ko'chiriladi.

const { logSecurityEvent } = require('../utils/securityLog');
const { getIp } = require('./ipBlocker');

const WINDOW_MS = 5 * 60 * 1000;
const AUTH_FAIL_THRESHOLD = Number(process.env.SUSPICIOUS_AUTHFAIL_THRESHOLD || 20);
const REQ_SPIKE_THRESHOLD = Number(process.env.SUSPICIOUS_REQ_THRESHOLD || 600);

const ipStats = new Map(); // ip -> { authFails, reqs, windowStart, alertedAuth, alertedSpike }

setInterval(() => {
  const now = Date.now();
  for (const [ip, s] of ipStats) {
    if (now - s.windowStart > WINDOW_MS) ipStats.delete(ip);
  }
}, WINDOW_MS).unref();

function securityMonitor(req, res, next) {
  const ip = getIp(req);
  const now = Date.now();

  let s = ipStats.get(ip);
  if (!s || now - s.windowStart > WINDOW_MS) {
    s = { authFails: 0, reqs: 0, windowStart: now, alertedAuth: false, alertedSpike: false };
    ipStats.set(ip, s);
  }

  s.reqs += 1;
  if (!s.alertedSpike && s.reqs > REQ_SPIKE_THRESHOLD) {
    s.alertedSpike = true;
    logSecurityEvent('request_spike', { req, severity: 'error', requests: s.reqs, windowMs: WINDOW_MS });
  }

  res.on('finish', () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      s.authFails += 1;
      if (!s.alertedAuth && s.authFails >= AUTH_FAIL_THRESHOLD) {
        s.alertedAuth = true;
        logSecurityEvent('suspicious_auth_failures', {
          req, severity: 'error', authFails: s.authFails, status: res.statusCode, windowMs: WINDOW_MS,
        });
      }
    }
  });

  next();
}

module.exports = { securityMonitor };
