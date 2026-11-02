const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { rateLimit, hit, clientIp, captchaConfig, issueCheckboxToken, requireCaptcha } = require('../utils/security');
const { sendWelcomeEmail, sendPasswordResetEmail, sendPasswordChangedEmail } = require('../utils/email');

const router = express.Router();

const RESET_TTL_MINUTES = 30;
const REMEMBER_ME_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_SESSION_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    isAdmin: Boolean(user.is_admin),
    hasActiveAccess: Boolean(user.has_active_access),
    isSuspended: Boolean(user.is_suspended),
    isTrialPlan: Boolean(user.is_trial_plan),
    creditsBalance: user.credits_balance,
    secondsBalance: user.seconds_balance,
  };
}

/**
 * Logs the user in on this browser. "Remember me" keeps them signed in for
 * 30 days; without it the cookie is a browser-session cookie that disappears
 * when the browser/app is closed.
 */
function startSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.cookie.maxAge = remember === 'default' ? DEFAULT_SESSION_MS : (remember ? REMEMBER_ME_MS : null);
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

function baseUrl(req) {
  const configured = (process.env.APP_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

// ---------------------------------------------------------------- public config
router.get('/config', (req, res) => {
  res.json({
    captcha: captchaConfig(),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  });
});

// Built-in "I'm not a robot" checkbox: issues a signed, single-use token once
// the widget has seen real human interaction (see public/js/auth.js).
router.post('/captcha', rateLimit({ name: 'captcha', windowMs: 10 * 60 * 1000, max: 60 }), (req, res) => {
  if (captchaConfig().provider !== 'checkbox') return res.status(400).json({ error: 'Not available.' });
  const token = issueCheckboxToken({ elapsedMs: req.body.elapsedMs, interactions: req.body.interactions });
  if (!token) return res.status(400).json({ error: 'Verification failed. Please try again.' });
  res.json({ ok: true, token });
});

// --------------------------------------------------------------------- register
router.post('/register',
  rateLimit({ name: 'register', windowMs: 60 * 60 * 1000, max: 10, message: 'Too many sign-ups from this network. Please try again later.' }),
  requireCaptcha,
  async (req, res, next) => {
    try {
      const username = (req.body.username || '').trim();
      const email = (req.body.email || '').trim();
      const password = req.body.password || '';

      if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, and password are required.' });
      if (username.length > 40) return res.status(400).json({ error: 'Username is too long.' });
      if (!looksLikeEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

      const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) return res.status(400).json({ error: 'That username is already taken.' });

      const hash = bcrypt.hashSync(password, 12);
      const result = await db.run(
        `INSERT INTO users (username, email, password_hash, has_active_access, credits_balance, seconds_balance)
         VALUES (?, ?, ?, 0, 0, 0) RETURNING id`,
        [username, email, hash]
      );

      const user = await db.get('SELECT * FROM users WHERE id = ?', [result.id]);
      await startSession(req, user, 'default');
      await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'registered', JSON.stringify({ email: user.email })]);
      // Email is a nice-to-have, never a requirement to finish signing up.
      try {
        await sendWelcomeEmail(user);
      } catch (emailErr) {
        console.error('[auth/register] Welcome email failed (non-fatal):', emailErr.message);
      }
      res.json({ ok: true, user: publicUser(user) });
    } catch (err) { next(err); }
  });

// ------------------------------------------------------------------------ login
router.post('/login',
  rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: 30, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' }),
  requireCaptcha,
  async (req, res, next) => {
    try {
      const username = (req.body.username || '').trim();
      const password = req.body.password || '';
      const remember = Boolean(req.body.remember);

      // Extra brute-force guard per account name (shared across IPs).
      const acct = hit(`login-user:${username.toLowerCase()}`, 15 * 60 * 1000, 12);
      if (acct.limited) return res.status(429).json({ error: 'Too many attempts for this account. Please wait a few minutes or reset your password.' });

      // Accept either the username or the email address.
      const user = await db.get(
        'SELECT * FROM users WHERE (username = ? OR (email <> \'\' AND LOWER(email) = LOWER(?))) AND is_deleted = 0 ORDER BY (username = ?) DESC LIMIT 1',
        [username, username, username]
      );
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password.' });
      }
      if (user.is_suspended) {
        return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
      }

      await startSession(req, user, remember);
      await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'login', JSON.stringify({ username: user.username, remember })]);
      res.json({ ok: true, user: publicUser(user) });
    } catch (err) { next(err); }
  });

// ----------------------------------------------------------------- Google login
async function verifyGoogleIdToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw Object.assign(new Error('Google sign-in is not configured.'), { status: 503 });
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw Object.assign(new Error('Google sign-in could not be verified. Please try again.'), { status: 401 });
  const info = await r.json();
  const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !issuerOk || !(Number(info.exp) * 1000 > Date.now())) {
    throw Object.assign(new Error('Google sign-in could not be verified. Please try again.'), { status: 401 });
  }
  if (!(info.email_verified === true || info.email_verified === 'true') || !info.email || !info.sub) {
    throw Object.assign(new Error('Your Google email address is not verified.'), { status: 401 });
  }
  return info;
}

async function uniqueUsername(base) {
  const clean = (base || 'user').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 24) || 'user';
  let candidate = clean;
  for (let i = 0; i < 50; i++) {
    const clash = await db.get('SELECT id FROM users WHERE username = ?', [candidate]);
    if (!clash) return candidate;
    candidate = `${clean}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return `${clean}${Date.now()}`;
}

router.post('/google',
  rateLimit({ name: 'google', windowMs: 15 * 60 * 1000, max: 30 }),
  async (req, res, next) => {
    try {
      const credential = req.body.credential;
      if (!credential || typeof credential !== 'string') return res.status(400).json({ error: 'Missing Google credential.' });
      const info = await verifyGoogleIdToken(credential);

      let user = await db.get('SELECT * FROM users WHERE google_id = ? AND is_deleted = 0', [info.sub]);
      let isNew = false;
      if (!user) {
        user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND is_deleted = 0 ORDER BY id LIMIT 1', [info.email]);
        if (user) {
          await db.run('UPDATE users SET google_id = ? WHERE id = ?', [info.sub, user.id]);
        } else {
          const username = await uniqueUsername(info.email.split('@')[0]);
          const randomHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
          const created = await db.run(
            `INSERT INTO users (username, email, password_hash, google_id, has_active_access, credits_balance, seconds_balance)
             VALUES (?, ?, ?, ?, 0, 0, 0) RETURNING id`,
            [username, info.email, randomHash, info.sub]
          );
          user = await db.get('SELECT * FROM users WHERE id = ?', [created.id]);
          isNew = true;
        }
      }
      if (user.is_suspended) return res.status(403).json({ error: 'This account has been suspended. Contact support.' });

      await startSession(req, user, req.body.remember === false ? false : true);
      await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, isNew ? 'registered' : 'login', JSON.stringify({ via: 'google' })]);
      if (isNew) sendWelcomeEmail(user).catch((e) => console.error('[auth/google] Welcome email failed (non-fatal):', e.message));
      res.json({ ok: true, user: publicUser(user), isNew });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

// -------------------------------------------------------------- password reset
// Works for everyone, admins included. The response is always the same whether
// or not the account exists, so this can't be used to discover usernames/emails.
router.post('/forgot',
  rateLimit({ name: 'forgot-ip', windowMs: 60 * 60 * 1000, max: 8, message: 'Too many reset requests. Please try again in a while.' }),
  requireCaptcha,
  async (req, res, next) => {
    const generic = { ok: true, message: 'If an account matches, a password reset link has been sent to its email address. The link expires in ' + RESET_TTL_MINUTES + ' minutes.' };
    try {
      const identifier = (req.body.identifier || '').trim();
      if (!identifier) return res.status(400).json({ error: 'Enter your username or email address.' });

      const user = await db.get(
        'SELECT * FROM users WHERE (LOWER(username) = LOWER(?) OR (email <> \'\' AND LOWER(email) = LOWER(?))) AND is_deleted = 0 ORDER BY (LOWER(username) = LOWER(?)) DESC LIMIT 1',
        [identifier, identifier, identifier]
      );
      if (!user || user.is_suspended) return res.json(generic);

      // Per-account throttle so one inbox can't be spammed.
      if (hit(`forgot-user:${user.id}`, 60 * 60 * 1000, 4).limited) return res.json(generic);

      // Admin accounts created without an email fall back to the notification inbox.
      const toEmail = user.email || (user.is_admin ? (process.env.ADMIN_NOTIFICATION_EMAIL || '') : '');
      if (!toEmail) {
        console.warn(`[auth/forgot] "${user.username}" has no email on file — cannot send a reset link.`);
        return res.json(generic);
      }

      // Only one live link at a time: invalidate any older unused ones.
      await db.run('UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.id]);
      const token = crypto.randomBytes(32).toString('hex');
      await db.run(
        `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
        [user.id, sha256(token), new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000)]
      );
      const link = `${baseUrl(req)}/reset-password.html?token=${token}`;
      try {
        await sendPasswordResetEmail(user, toEmail, link, RESET_TTL_MINUTES);
      } catch (mailErr) {
        console.error('[auth/forgot] Reset email failed:', mailErr.message);
      }
      await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'password_reset_requested', JSON.stringify({ ip: clientIp(req) })]);
      res.json(generic);
    } catch (err) { next(err); }
  });

async function findValidReset(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  return db.get(
    `SELECT pr.*, u.username FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW() AND u.is_deleted = 0`,
    [sha256(token)]
  );
}

router.get('/reset/validate', rateLimit({ name: 'reset-validate', windowMs: 15 * 60 * 1000, max: 40 }), async (req, res, next) => {
  try {
    const row = await findValidReset(req.query.token);
    if (!row) return res.status(410).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    res.json({ ok: true, username: row.username });
  } catch (err) { next(err); }
});

router.post('/reset', rateLimit({ name: 'reset', windowMs: 15 * 60 * 1000, max: 15 }), async (req, res, next) => {
  try {
    const password = req.body.password || '';
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const row = await findValidReset(req.body.token);
    if (!row) return res.status(410).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });

    // Mark used first (single-use), guarded so two parallel requests can't both win.
    const claimed = await db.run('UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [row.id]);
    if (!claimed.changes) return res.status(410).json({ error: 'This reset link has already been used. Please request a new one.' });

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 12), row.user_id]);
    await db.run('UPDATE password_resets SET used_at = COALESCE(used_at, NOW()) WHERE user_id = ?', [row.user_id]);
    // Sign the account out everywhere (in case someone else had access).
    try {
      await db.run(`DELETE FROM session WHERE (sess->>'userId') = ?`, [String(row.user_id)]);
    } catch (e) { console.warn('[auth/reset] Could not clear old sessions:', e.message); }
    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [row.user_id, 'password_reset_completed', JSON.stringify({ ip: clientIp(req) })]);

    const user = await db.get('SELECT * FROM users WHERE id = ?', [row.user_id]);
    const toEmail = user.email || (user.is_admin ? (process.env.ADMIN_NOTIFICATION_EMAIL || '') : '');
    sendPasswordChangedEmail(user, toEmail).catch((e) => console.error('[auth/reset] Notice email failed (non-fatal):', e.message));

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  res.json({ loggedIn: Boolean(req.user), user: publicUser(req.user) });
});

module.exports = router;
