require('dotenv').config();

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const fs = require('fs');
const path = require('path');

const db = require('./db'); // exposes .pool, used below for the session store too
const bcrypt = require('bcryptjs');
const { loadUser, requireLogin, requireAdmin } = require('./middleware/auth');

async function renderTopUpPlansHtml() {
  const plans = [
    { name: 'Quick Top-Up', badge: 'Starter', price: 10, credits: 500, minutes: 5, description: 'Perfect for a quick extra session.', features: ['Fast top-up', 'Instant credit add-on'] },
    { name: 'Standard Top-Up', badge: 'Best Value', price: 30, credits: 1500, minutes: 15, description: 'A balanced choice for regular creators.', features: ['Extra broadcasting time', 'Great for daily use'] },
    { name: 'Pro Top-Up', badge: 'Popular', price: 60, credits: 3500, minutes: 30, description: 'More room for longer sessions and live tutorials.', features: ['Longer sessions', 'Feels like a full extra plan'] },
    { name: 'Plus Top-Up', badge: 'Flex', price: 100, credits: 6000, minutes: 50, description: 'Designed for extended usage and heavy streaming.', features: ['High-value bundle', 'Best for frequent creators'] },
  ];

  return plans.map((p, i) => `
    <div class="card" style="animation: fadeInUp .5s ease-out ${i * 0.1}s backwards; border: 1px solid rgba(31, 78, 170, 0.12);">
      <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
        <h3 style="margin:0;">${p.name}</h3>
      </div>
      ${p.badge ? `<span class="badge badge-warning">${p.badge}</span>` : ''}
      <div style="font-size:2rem; font-weight:800; color:var(--blue-900); margin:12px 0 8px;">$${p.price}</div>
      <p><strong>${p.credits.toLocaleString()} credits</strong> · ${p.minutes} minutes</p>
      <p class="text-muted" style="font-size:.9rem; min-height: 42px;">${p.description}</p>
      ${p.features && p.features.length ? `<ul style="margin:8px 0 16px; padding-left:16px; font-size:.9rem; color:var(--text-muted);">${p.features.map(f => `<li>${f}</li>`).join('')}</ul>` : ''}
      <a href="/payment.html" class="btn btn-outline btn-block">Buy Now</a>
    </div>
  `).join('');
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  // Sessions live in the same Neon database, in their own "session" table
  // (auto-created by connect-pg-simple on first run).
  store: new pgSession({ pool: db.pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
  },
}));

app.use(loadUser);

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/auth', require('./routes/auth'));
app.use('/api/pages', require('./routes/pages'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/studio', require('./routes/studio'));
app.use('/api/admin', requireLogin, require('./routes/admin'));

// Current logged-in user's own profile/balance snapshot (used by the
// dashboard header, profile menu, and usage widgets across the site).
app.get('/api/me', requireLogin, (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email || '',
      isAdmin: Boolean(req.user.is_admin),
      hasActiveAccess: Boolean(req.user.has_active_access),
      isSuspended: Boolean(req.user.is_suspended),
      isTrialPlan: Boolean(req.user.is_trial_plan),
      creditsBalance: req.user.credits_balance,
      secondsBalance: req.user.seconds_balance,
    },
  });
});

/**
 * Lets ANY logged-in user (not just admins) edit their own profile —
 * username, email, and password — from their own dashboard. Always
 * scoped to req.user.id and requires the current password to be
 * confirmed first, same as the admin's equivalent endpoint
 * (POST /api/admin/my-account), which is the admin-only counterpart of
 * this for changing the admin's own login.
 */
app.post('/api/me/update', requireLogin, async (req, res, next) => {
  try {
    const { currentPassword, newUsername, newEmail, newPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required.' });

    const me = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!bcrypt.compareSync(currentPassword, me.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const cleanUsername = (newUsername || '').trim();
    if (cleanUsername && cleanUsername !== me.username) {
      const clash = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [cleanUsername, me.id]);
      if (clash) return res.status(400).json({ error: 'That username is already taken.' });
    }

    if (newPassword && newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const finalUsername = cleanUsername || me.username;
    const finalEmail = newEmail != null ? newEmail.trim() : me.email;
    const finalHash = newPassword ? bcrypt.hashSync(newPassword, 12) : me.password_hash;

    await db.run('UPDATE users SET username = ?, email = ?, password_hash = ? WHERE id = ?',
      [finalUsername, finalEmail, finalHash, me.id]);

    res.json({ ok: true, username: finalUsername, email: finalEmail });
  } catch (err) { next(err); }
});

app.get('/', async (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  const html = await fs.promises.readFile(indexPath, 'utf8');
  const rendered = html.replace('__TOPUP_PLANS_HTML__', await renderTopUpPlansHtml());
  res.send(rendered);
});

app.get('/downloads/CreoveyaSetup.exe', (req, res) => {
  const installerPath = path.join(__dirname, 'public', 'downloads', 'CreoveyaSetup.exe');
  if (!fs.existsSync(installerPath)) {
    return res.status(404).send('Desktop installer not found. Please build the Windows installer first.');
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="CreoveyaSetup.exe"');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(installerPath);
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Guard the dashboard/studio HTML shells themselves (the API underneath
// is independently protected too, but this stops a logged-out or
// unpaid visitor from even loading the page shell). HTML routes redirect
// rather than return JSON, since a browser navigation expects a page.
function pageGuard({ needsAccess } = {}) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login.html');
    if (req.user.is_suspended) return res.redirect('/login.html?suspended=1');
    if (needsAccess && !req.user.is_admin && !req.user.has_active_access) return res.redirect('/payment');
    next();
  };
}

app.get(['/dashboard', '/dashboard/*'], pageGuard({ needsAccess: true }), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get(['/studio', '/studio/*'], pageGuard({ needsAccess: true }), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'studio.html'));
});
app.get('/obs', pageGuard({ needsAccess: true }), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'obs.html'));
});
app.get(['/admin_dashboard', '/admin_dashboard/'], (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  if (!req.user.is_admin) return res.status(403).sendFile(path.join(__dirname, 'public', '404.html'));
  res.sendFile(path.join(__dirname, 'admin_assets', 'index.html'));
});
app.get('/admin_dashboard/admin.js', (req, res) => {
  if (!req.user || !req.user.is_admin) return res.status(403).end();
  res.type('application/javascript').sendFile(path.join(__dirname, 'admin_assets', 'admin.js'));
});
app.get('/payment', pageGuard(), (req, res) => {
  if (req.user.is_admin) return res.redirect('/admin_dashboard');
  if (req.user.has_active_access && !req.user.is_trial_plan) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});
app.get('/payment-topup.html', pageGuard(), (req, res) => {
  if (req.user.is_admin) return res.redirect('/admin_dashboard');
  if (!req.user.has_active_access || req.user.is_trial_plan) return res.redirect('/payment');
  res.sendFile(path.join(__dirname, 'public', 'payment-topup.html'));
});

app.use((req, res) => {
  // API/auth callers get JSON; browsers get the branded 404 page.
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Centralized error handler — any route that calls next(err) (e.g. a
// dropped Neon connection) lands here instead of crashing the process.
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

async function start() {
  await db.initDb();
  app.listen(PORT, () => {
    console.log(`Creoveya AI Live Studio running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
