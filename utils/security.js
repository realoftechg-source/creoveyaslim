/**
 * Bot / abuse protection helpers.
 *
 *  - rateLimit(): small in-memory limiter for sensitive endpoints.
 *  - captcha: "I'm not a robot" verification. Two providers:
 *      1. Cloudflare Turnstile — used automatically when BOTH
 *         TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set (free, invisible
 *         or checkbox, strongest option).
 *      2. Built-in checkbox challenge — works with ZERO setup. The browser must
 *         show real human interaction (pointer/keyboard/touch), wait a minimum
 *         time, and pass a signed, single-use, expiring token to the server.
 *    Every protected form also carries a hidden honeypot field that real people
 *    never fill in but bots usually do.
 */
const crypto = require('crypto');

const SECRET = () => process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';

// ----------------------------------------------------------------- rate limit
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
}, 5 * 60 * 1000).unref();

function hit(key, windowMs, max) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return { limited: b.count > max, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

function clientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function rateLimit({ name, windowMs, max, message }) {
  return (req, res, next) => {
    const r = hit(`${name}:${clientIp(req)}`, windowMs, max);
    if (r.limited) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: message || 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

// -------------------------------------------------------------------- captcha
const usedNonces = new Map(); // nonce -> expiry
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
}, 5 * 60 * 1000).unref();

const TOKEN_TTL_MS = 20 * 60 * 1000;
const MIN_HUMAN_MS = 900;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET()).update(payload).digest('hex');
}

function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

function captchaConfig() {
  return turnstileEnabled()
    ? { provider: 'turnstile', siteKey: process.env.TURNSTILE_SITE_KEY }
    : { provider: 'checkbox' };
}

/** Issues a signed token after the checkbox widget saw real interaction. */
function issueCheckboxToken({ elapsedMs, interactions }) {
  if (!(Number(elapsedMs) >= MIN_HUMAN_MS) || !(Number(interactions) >= 1)) return null;
  const nonce = crypto.randomBytes(12).toString('hex');
  const ts = Date.now();
  const payload = `${ts}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

async function verifyCaptcha(req) {
  // Honeypot — hidden field named "website" must stay empty.
  if (req.body && req.body.website) return false;

  const token = req.body && req.body.captchaToken;
  if (!token || typeof token !== 'string') return false;

  if (turnstileEnabled()) {
    try {
      const params = new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: clientIp(req) });
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: params });
      const data = await r.json();
      return Boolean(data.success);
    } catch (err) {
      console.error('[captcha] Turnstile verification failed:', err.message);
      return false;
    }
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [ts, nonce, sig] = parts;
  const payload = `${ts}.${nonce}`;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = Date.now() - Number(ts);
  if (!(age >= 0 && age <= TOKEN_TTL_MS)) return false;
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, Date.now() + TOKEN_TTL_MS);
  return true;
}

/** Express middleware: rejects the request unless the captcha passes. */
function requireCaptcha(req, res, next) {
  verifyCaptcha(req).then((ok) => {
    if (!ok) return res.status(400).json({ error: 'Please confirm you are not a robot and try again.', captcha: true });
    next();
  }).catch(next);
}

module.exports = { rateLimit, hit, clientIp, captchaConfig, issueCheckboxToken, requireCaptcha, verifyCaptcha };
