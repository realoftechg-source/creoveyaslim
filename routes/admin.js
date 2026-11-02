const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { sendApprovalEmail, sendTopUpEmail, sendRejectionEmail } = require('../utils/email');

const router = express.Router();
router.use(requireAdmin);

function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isAdmin: Boolean(u.is_admin),
    isSuspended: Boolean(u.is_suspended),
    hasActiveAccess: Boolean(u.has_active_access),
    isTrialPlan: Boolean(u.is_trial_plan),
    creditsBalance: u.credits_balance,
    secondsBalance: u.seconds_balance,
    createdAt: u.created_at,
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res, next) => {
  try {
    const totalUsers = Number((await db.get('SELECT COUNT(*) c FROM users WHERE is_deleted = 0')).c);
    const activeUsers = Number((await db.get('SELECT COUNT(*) c FROM users WHERE is_deleted = 0 AND has_active_access = 1')).c);
    const pendingPayments = Number((await db.get(`SELECT COUNT(*) c FROM payment_submissions WHERE status = 'pending'`)).c);
    const liveNow = Number((await db.get(`SELECT COUNT(*) c FROM stream_sessions WHERE status = 'live'`)).c);
    const recentSubmissions = await db.all(`
      SELECT ps.*, u.username, cp.name AS plan_name
      FROM payment_submissions ps
      JOIN users u ON u.id = ps.user_id
      LEFT JOIN credit_plans cp ON cp.id = ps.plan_id
      ORDER BY ps.created_at DESC LIMIT 8
    `);

    res.json({ ok: true, totalUsers, activeUsers, pendingPayments, liveNow, recentSubmissions });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
router.get('/users', async (req, res, next) => {
  try {
    const users = await db.all('SELECT * FROM users WHERE is_deleted = 0 ORDER BY created_at DESC');
    res.json({ ok: true, users: users.map(serializeUser) });
  } catch (err) { next(err); }
});

router.post('/users', async (req, res, next) => {
  try {
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    if (!username || !email || password.length < 8) {
      return res.status(400).json({ error: 'Username, email, and an 8+ character password are required.' });
    }
    const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) return res.status(400).json({ error: 'Username already taken.' });

    const hash = bcrypt.hashSync(password, 12);
    const hasAccess = req.body.grantAccess ? 1 : 0;
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, has_active_access, credits_balance, seconds_balance)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [username, req.body.email || '', hash, hasAccess, Number(req.body.credits) || 0, Math.round((Number(req.body.minutes) || 0) * 60)]
    );

    const user = await db.get('SELECT * FROM users WHERE id = ?', [result.id]);
    res.json({ ok: true, user: serializeUser(user) });
  } catch (err) { next(err); }
});

/**
 * Full profile edit for any user, by an admin — username, email, and
 * optionally a forced password reset. Unlike the self-service endpoints
 * (POST /api/me/update and POST /api/admin/my-account), this does NOT
 * require the target user's current password, since an admin editing
 * someone else's account is exactly the elevated-privilege case that
 * justifies skipping that check — the admin's OWN session/login is
 * already what's being trusted here.
 */
router.put('/users/:id', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const { username, email, newPassword } = req.body;
    const cleanUsername = (username || '').trim();
    if (cleanUsername && cleanUsername !== user.username) {
      const clash = await db.get('SELECT id FROM users WHERE username = ? AND id != ?', [cleanUsername, user.id]);
      if (clash) return res.status(400).json({ error: 'That username is already taken.' });
    }
    if (newPassword && newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const finalUsername = cleanUsername || user.username;
    const finalEmail = email != null ? email.trim() : user.email;
    const finalHash = newPassword ? bcrypt.hashSync(newPassword, 12) : user.password_hash;

    await db.run('UPDATE users SET username = ?, email = ?, password_hash = ? WHERE id = ?',
      [finalUsername, finalEmail, finalHash, user.id]);
    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`,
      [user.id, 'admin_edited_profile', JSON.stringify({ usernameChanged: cleanUsername !== user.username, emailChanged: finalEmail !== user.email, passwordReset: Boolean(newPassword) })]);

    const updated = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    res.json({ ok: true, user: serializeUser(updated) });
  } catch (err) { next(err); }
});

router.post('/users/:id/credits', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const addCredits = Math.round(Number(req.body.addCredits) || 0);
    const addMinutes = Number(req.body.addMinutes) || 0;
    const addSeconds = Math.round(addMinutes * 60);

    await db.run('UPDATE users SET credits_balance = credits_balance + ?, seconds_balance = seconds_balance + ?, has_active_access = 1 WHERE id = ?',
      [addCredits, addSeconds, user.id]);
    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'admin_top_up', JSON.stringify({ addCredits, addMinutes: addMinutes })]);

    const updated = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    res.json({ ok: true, user: serializeUser(updated) });
  } catch (err) { next(err); }
});

router.post('/users/:id/suspend', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.is_admin) return res.status(400).json({ error: 'Cannot suspend an admin account.' });

    const newValue = user.is_suspended ? 0 : 1;
    await db.run('UPDATE users SET is_suspended = ? WHERE id = ?', [newValue, user.id]);
    res.json({ ok: true, isSuspended: Boolean(newValue) });
  } catch (err) { next(err); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.is_admin) return res.status(400).json({ error: 'Cannot delete an admin account.' });

    await db.run('UPDATE users SET is_deleted = 1 WHERE id = ?', [user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Credit plans
// ---------------------------------------------------------------------------
router.get('/plans', async (req, res, next) => {
  try {
    const plans = await db.all('SELECT * FROM credit_plans ORDER BY sort_order, price');
    res.json({ ok: true, plans: plans.map((p) => ({
      ...p,
      badge_text: p.badge_text || '',
      tagline: p.tagline || '',
      features: p.features ? p.features.split('|').filter(Boolean) : [],
      is_trial: Boolean(p.is_trial),
      allow_top_up: Boolean(p.allow_top_up),
      is_featured: Boolean(p.is_featured),
      is_active: Boolean(p.is_active),
    })) });
  } catch (err) { next(err); }
});

router.post('/plans', async (req, res, next) => {
  try {
    const { name, price, credits, minutes, description, sortOrder, isTrial, allowTopUp, isActive, badgeText, tagline, features, isFeatured } = req.body;
    if (!name || price == null || credits == null || minutes == null) {
      return res.status(400).json({ error: 'Name, price, credits, and minutes are all required.' });
    }
    const result = await db.run(
      `INSERT INTO credit_plans (name, badge_text, tagline, price, credits, minutes, description, features, is_trial, allow_top_up, is_featured, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [name, badgeText || '', tagline || '', Number(price), Number(credits), Number(minutes), description || '', Array.isArray(features) ? features.join('|') : (features || ''), isTrial ? 1 : 0, allowTopUp === false ? 0 : 1, isFeatured ? 1 : 0, isActive === false ? 0 : 1, Number(sortOrder) || 0]
    );
    res.json({ ok: true, id: result.id });
  } catch (err) { next(err); }
});

router.put('/plans/:id', async (req, res, next) => {
  try {
    const plan = await db.get('SELECT * FROM credit_plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found.' });
    const { name, price, credits, minutes, description, sortOrder, isActive, isTrial, allowTopUp, badgeText, tagline, features, isFeatured } = req.body;
    await db.run(
      `UPDATE credit_plans SET name = ?, badge_text = ?, tagline = ?, price = ?, credits = ?, minutes = ?, description = ?, features = ?, is_trial = ?, allow_top_up = ?, is_featured = ?, sort_order = ?, is_active = ? WHERE id = ?`,
      [
        name ?? plan.name,
        badgeText ?? plan.badge_text ?? '',
        tagline ?? plan.tagline ?? '',
        price != null ? Number(price) : plan.price,
        credits != null ? Number(credits) : plan.credits,
        minutes != null ? Number(minutes) : plan.minutes,
        description ?? plan.description,
        Array.isArray(features) ? features.join('|') : (features ?? plan.features ?? ''),
        isTrial != null ? (isTrial ? 1 : 0) : plan.is_trial,
        allowTopUp != null ? (allowTopUp ? 1 : 0) : plan.allow_top_up,
        isFeatured != null ? (isFeatured ? 1 : 0) : plan.is_featured,
        sortOrder != null ? Number(sortOrder) : plan.sort_order,
        isActive != null ? (isActive ? 1 : 0) : plan.is_active,
        plan.id,
      ]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/plans/:id', async (req, res, next) => {
  try {
    await db.run('DELETE FROM credit_plans WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Payment methods (bank + crypto)
// ---------------------------------------------------------------------------
router.get('/payment-methods', async (req, res, next) => {
  try {
    const methods = await db.all('SELECT * FROM payment_methods ORDER BY sort_order, id');
    res.json({ ok: true, methods });
  } catch (err) { next(err); }
});

router.post('/payment-methods', async (req, res, next) => {
  try {
    const b = req.body;
    if (!b.methodType || !['bank', 'crypto'].includes(b.methodType)) {
      return res.status(400).json({ error: 'methodType must be "bank" or "crypto".' });
    }
    if (b.methodType === 'bank') {
      const count = Number((await db.get(`SELECT COUNT(*) c FROM payment_methods WHERE method_type = 'bank'`)).c);
      if (count >= 3) return res.status(400).json({ error: 'Maximum of 3 bank accounts allowed.' });
    } else {
      const count = Number((await db.get(`SELECT COUNT(*) c FROM payment_methods WHERE method_type = 'crypto'`)).c);
      if (count >= 4) return res.status(400).json({ error: 'Maximum of 4 crypto methods allowed.' });
    }

    const result = await db.run(`
      INSERT INTO payment_methods
        (method_type, label, bank_name, account_name, account_number, routing_swift, crypto_currency, wallet_address, network_note, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [
      b.methodType, b.label || '', b.bankName || '', b.accountName || '', b.accountNumber || '',
      b.routingSwift || '', b.cryptoCurrency || '', b.walletAddress || '', b.networkNote || '', Number(b.sortOrder) || 0,
    ]);
    res.json({ ok: true, id: result.id });
  } catch (err) { next(err); }
});

router.put('/payment-methods/:id', async (req, res, next) => {
  try {
    const method = await db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
    if (!method) return res.status(404).json({ error: 'Method not found.' });
    const b = req.body;
    await db.run(`
      UPDATE payment_methods SET
        label = ?, bank_name = ?, account_name = ?, account_number = ?, routing_swift = ?,
        crypto_currency = ?, wallet_address = ?, network_note = ?, sort_order = ?, is_active = ?
      WHERE id = ?
    `, [
      b.label ?? method.label, b.bankName ?? method.bank_name, b.accountName ?? method.account_name,
      b.accountNumber ?? method.account_number, b.routingSwift ?? method.routing_swift,
      b.cryptoCurrency ?? method.crypto_currency, b.walletAddress ?? method.wallet_address,
      b.networkNote ?? method.network_note, b.sortOrder != null ? Number(b.sortOrder) : method.sort_order,
      b.isActive != null ? (b.isActive ? 1 : 0) : method.is_active,
      method.id,
    ]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/payment-methods/:id', async (req, res, next) => {
  try {
    await db.run('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Payment submissions (approve / reject)
// ---------------------------------------------------------------------------
router.get('/payments', async (req, res, next) => {
  try {
    const status = req.query.status;
    const rows = status
      ? await db.all(`
          SELECT ps.*, u.username, cp.name AS plan_name, cp.credits AS plan_credits, cp.minutes AS plan_minutes
          FROM payment_submissions ps JOIN users u ON u.id = ps.user_id
          LEFT JOIN credit_plans cp ON cp.id = ps.plan_id
          WHERE ps.status = ? ORDER BY ps.created_at DESC
        `, [status])
      : await db.all(`
          SELECT ps.*, u.username, cp.name AS plan_name, cp.credits AS plan_credits, cp.minutes AS plan_minutes
          FROM payment_submissions ps JOIN users u ON u.id = ps.user_id
          LEFT JOIN credit_plans cp ON cp.id = ps.plan_id
          ORDER BY ps.created_at DESC
        `);
    res.json({ ok: true, submissions: rows });
  } catch (err) { next(err); }
});

router.get('/payments/:id/receipt', async (req, res, next) => {
  try {
    const submission = await db.get('SELECT * FROM payment_submissions WHERE id = ?', [req.params.id]);
    if (!submission) return res.status(404).end();
    const filePath = path.join(__dirname, '..', 'uploads', 'receipts', submission.receipt_path);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  } catch (err) { next(err); }
});

router.post('/payments/:id/approve', async (req, res, next) => {
  try {
    const submission = await db.get('SELECT * FROM payment_submissions WHERE id = ?', [req.params.id]);
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    if (submission.status !== 'pending') return res.status(400).json({ error: 'Already reviewed.' });

    let plan, planName;
    if (submission.plan_type === 'topup') {
      plan = await db.get('SELECT * FROM topup_plans WHERE id = ?', [submission.topup_plan_id]);
      if (!plan) return res.status(400).json({ error: 'The top-up plan for this submission no longer exists.' });
      planName = plan.name;
      const addSeconds = Math.round(Number(plan.minutes) * 60);
      await db.run(
        'UPDATE users SET credits_balance = credits_balance + ?, seconds_balance = seconds_balance + ? WHERE id = ?',
        [plan.credits, addSeconds, submission.user_id]
      );
    } else {
      plan = await db.get('SELECT * FROM credit_plans WHERE id = ?', [submission.plan_id]);
      if (!plan) return res.status(400).json({ error: 'The plan for this submission no longer exists.' });
      planName = plan.name;
      const addSeconds = Math.round(Number(plan.minutes) * 60);
      await db.run(
        'UPDATE users SET credits_balance = credits_balance + ?, seconds_balance = seconds_balance + ?, has_active_access = 1, current_plan_id = ?, is_trial_plan = ? WHERE id = ?',
        [plan.credits, addSeconds, plan.id, plan.is_trial ? 1 : 0, submission.user_id]
      );
    }

    await db.run(`UPDATE payment_submissions SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [req.user.id, submission.id]);

    const user = await db.get('SELECT * FROM users WHERE id = ?', [submission.user_id]);
    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'payment_approved', JSON.stringify({ planId: plan.id, planName, amount: submission.amount, planType: submission.plan_type })]);
    // Email is a nice-to-have here, not a requirement for the approval
    // itself — a misconfigured SMTP setup must never leave a payment
    // "stuck" or throw a 500 back at the admin who's trying to approve it.
    try {
      if (submission.plan_type === 'topup') await sendTopUpEmail(user, plan);
      else await sendApprovalEmail(user, plan);
    } catch (emailErr) {
      console.error('[admin/payments/approve] Notification email failed (non-fatal):', emailErr.message);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/payments/:id/reject', async (req, res, next) => {
  try {
    const submission = await db.get('SELECT * FROM payment_submissions WHERE id = ?', [req.params.id]);
    if (!submission) return res.status(404).json({ error: 'Submission not found.' });
    if (submission.status !== 'pending') return res.status(400).json({ error: 'Already reviewed.' });

    await db.run(`UPDATE payment_submissions SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?`,
      [req.body.note || '', req.user.id, submission.id]);

    const user = await db.get('SELECT * FROM users WHERE id = ?', [submission.user_id]);
    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [user.id, 'payment_rejected', JSON.stringify({ reason: req.body.note || 'No note provided' })]);

    // Same non-fatal pattern as approval: a broken SMTP setup must never
    // block the admin from completing the rejection itself.
    try {
      const plan = submission.plan_type === 'topup'
        ? await db.get('SELECT * FROM topup_plans WHERE id = ?', [submission.topup_plan_id])
        : await db.get('SELECT * FROM credit_plans WHERE id = ?', [submission.plan_id]);
      await sendRejectionEmail(user, plan, req.body.note || '');
    } catch (emailErr) {
      console.error('[admin/payments/reject] Notification email failed (non-fatal):', emailErr.message);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Platform settings (Decart API key, Telegram username, global credit rate)
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await db.get('SELECT * FROM platform_settings WHERE id = 1');
    const masked = settings.decart_api_key_override
      ? `${'•'.repeat(Math.max(0, settings.decart_api_key_override.length - 4))}${settings.decart_api_key_override.slice(-4)}`
      : '';
    res.json({ ok: true, settings: { ...settings, decart_api_key_masked: masked, decart_api_key_override: undefined } });
  } catch (err) { next(err); }
});

router.post('/settings', async (req, res, next) => {
  try {
    const b = req.body;
    const current = await db.get('SELECT * FROM platform_settings WHERE id = 1');
    await db.run(`
      UPDATE platform_settings SET
        decart_api_key_override = ?,
        support_telegram_username = ?,
        credits_per_minute = ?,
        site_name = ?
      WHERE id = 1
    `, [
      b.decartApiKey && !b.decartApiKey.includes('•') ? b.decartApiKey : current.decart_api_key_override,
      b.supportTelegramUsername ?? current.support_telegram_username,
      b.creditsPerMinute != null ? Number(b.creditsPerMinute) : current.credits_per_minute,
      b.siteName ?? current.site_name,
    ]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Lets the currently logged-in admin change their OWN username and/or
 * password. Always scoped to req.user.id (never an id from the request
 * body), and requires the current password to be confirmed first —
 * same as any real account-security page. Without this, changing the
 * admin login required a direct database edit.
 */
router.post('/my-account', async (req, res, next) => {
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

// ---------------------------------------------------------------------------
// Top-Up Plans
// ---------------------------------------------------------------------------
router.get('/topup-plans', async (req, res, next) => {
  try {
    const plans = await db.all('SELECT * FROM topup_plans ORDER BY sort_order, price');
    console.log('[admin/topup-plans] Retrieved', plans.length, 'topup plans');
    res.json({ ok: true, plans: plans.map((p) => ({
      ...p,
      badge_text: p.badge_text || '',
      tagline: p.tagline || '',
      features: p.features ? p.features.split('|').filter(Boolean) : [],
      is_featured: Boolean(p.is_featured),
      is_active: Boolean(p.is_active),
    })) });
  } catch (err) { 
    console.error('[admin/topup-plans GET] Error:', err.message);
    next(err); 
  }
});

router.post('/topup-plans', async (req, res, next) => {
  try {
    const { name, price, credits, minutes, description, sortOrder, isActive, badgeText, tagline, features, isFeatured } = req.body;
    if (!name || price == null || credits == null || minutes == null) {
      return res.status(400).json({ error: 'Name, price, credits, and minutes are all required.' });
    }
    const result = await db.run(
      `INSERT INTO topup_plans (name, badge_text, tagline, price, credits, minutes, description, features, is_featured, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [name, badgeText || '', tagline || '', Number(price), Number(credits), Number(minutes), description || '', Array.isArray(features) ? features.join('|') : (features || ''), isFeatured ? 1 : 0, isActive === false ? 0 : 1, Number(sortOrder) || 0]
    );
    console.log('[admin/topup-plans POST] Created plan:', name, 'with ID:', result.id);
    res.json({ ok: true, id: result.id });
  } catch (err) { 
    console.error('[admin/topup-plans POST] Error:', err.message);
    next(err); 
  }
});

router.put('/topup-plans/:id', async (req, res, next) => {
  try {
    const plan = await db.get('SELECT * FROM topup_plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found.' });
    const { name, price, credits, minutes, description, sortOrder, isActive, badgeText, tagline, features, isFeatured } = req.body;
    await db.run(
      `UPDATE topup_plans SET name = ?, badge_text = ?, tagline = ?, price = ?, credits = ?, minutes = ?, description = ?, features = ?, is_featured = ?, sort_order = ?, is_active = ? WHERE id = ?`,
      [
        name ?? plan.name,
        badgeText ?? plan.badge_text ?? '',
        tagline ?? plan.tagline ?? '',
        price != null ? Number(price) : plan.price,
        credits != null ? Number(credits) : plan.credits,
        minutes != null ? Number(minutes) : plan.minutes,
        description ?? plan.description,
        Array.isArray(features) ? features.join('|') : (features ?? plan.features ?? ''),
        isFeatured != null ? (isFeatured ? 1 : 0) : plan.is_featured,
        sortOrder != null ? Number(sortOrder) : plan.sort_order,
        isActive != null ? (isActive ? 1 : 0) : plan.is_active,
        plan.id,
      ]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/topup-plans/:id', async (req, res, next) => {
  try {
    await db.run('DELETE FROM topup_plans WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Broadcast Message (send email to all users)
// ---------------------------------------------------------------------------
router.post('/broadcast', async (req, res, next) => {
  try {
    const { subject, message } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required.' });
    }

    const users = await db.all('SELECT id, email FROM users WHERE is_deleted = 0 AND email IS NOT NULL');
    const { sendMail } = require('../utils/email');
    
    let sent = 0;
    for (const user of users) {
      try {
        await sendMail({
          to: user.email,
          subject,
          text: message,
          html: `<div style="font-family:Arial,sans-serif; color:#10193a; line-height:1.6;"><p>${message.replace(/\n/g, '<br>')}</p><hr style="border:none; border-top:1px solid #e3e9f5; margin:24px 0;"><p style="font-size:.85rem; color:#8794ac;">Sent from Creoveya</p></div>`,
        });
        sent++;
      } catch (err) {
        console.error(`[broadcast] Failed to send to ${user.email}:`, err.message);
      }
    }

    await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`, [req.user.id, 'broadcast_sent', JSON.stringify({ recipientCount: sent, subject })]);

    res.json({ ok: true, sent, total: users.length });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// User Activity History
// ---------------------------------------------------------------------------
router.get('/activity', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const rows = await db.all(`
      SELECT ua.id, ua.user_id, ua.action, ua.details, ua.created_at, u.username
      FROM user_activity ua
      JOIN users u ON u.id = ua.user_id
      ORDER BY ua.created_at DESC
      LIMIT ?
    `, [limit]);
    res.json({ ok: true, activity: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// User Uploaded Images (Looks Gallery)
// ---------------------------------------------------------------------------
router.get('/images', async (req, res, next) => {
  try {
    const rows = await db.all(`
      SELECT l.id, l.user_id, l.name, l.prompt, l.image_path, l.created_at, u.username
      FROM looks l
      JOIN users u ON u.id = l.user_id
      WHERE l.image_path IS NOT NULL
      ORDER BY l.created_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, images: rows });
  } catch (err) { next(err); }
});

module.exports = router;
