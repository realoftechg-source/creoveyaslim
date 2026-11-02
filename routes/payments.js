const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { sendAdminPaymentNotification } = require('../utils/email');

const router = express.Router();

function isCreatorPlan(plan) {
  const name = String(plan?.name || '').trim().toLowerCase();
  return name === 'creator' || name === 'creator plan' || name === 'full access';
}

function isStarterPlan(plan) {
  const name = String(plan?.name || '').trim().toLowerCase();
  return name === 'starter' || name === 'trial' || name === 'starter plan';
}

const RECEIPTS_DIR = path.join(__dirname, '..', 'uploads', 'receipts');
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECEIPTS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${req.user.id}_${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Broadened beyond jpeg/png/webp: iPhones commonly save screenshots as
    // HEIC/HEIF, and some banks issue PDF receipts. Previously anything
    // outside jpeg/png/webp threw a raw multer error that bypassed this
    // route's own error handling entirely and surfaced as a generic
    // "Something went wrong" 500 — see the wrapped middleware below for
    // the actual fix to that bug.
    const ok = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
    ].includes(file.mimetype);
    cb(ok ? null : new Error('UNSUPPORTED_FILE_TYPE'), ok);
  },
});

/**
 * Wraps upload.single('receipt') so multer's own errors (bad file type,
 * file too large, malformed multipart body, etc.) are converted into a
 * normal, specific JSON error response — instead of bypassing this
 * route's try/catch and falling through to the server's generic 500
 * "Something went wrong" handler, which is what a user hitting any of
 * these cases (e.g. uploading a HEIC screenshot or a PDF receipt) saw.
 */
function uploadReceipt(req, res, next) {
  upload.single('receipt')(req, res, (err) => {
    if (!err) return next();
    if (err.message === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(400).json({ error: 'Please upload your receipt as a JPEG, PNG, WEBP, HEIC, or PDF file.' });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'That file is too large. Please upload a receipt under 8MB.' });
    }
    console.error('[payments/submit] Upload error:', err.message);
    return res.status(400).json({ error: 'Could not process the uploaded file. Please try a different image.' });
  });
}

// Public: active plans shown on the payment page.
router.get('/plans', async (req, res, next) => {
  try {
    const settings = await db.get('SELECT credits_per_minute FROM platform_settings WHERE id = 1');
    let plans = await db.all('SELECT * FROM credit_plans WHERE is_active = 1 ORDER BY sort_order, price');

    // The public catalogue and every payment page expose only the two
    // customer-facing activation tiers. Keep this server-side so extra
    // admin-created plans cannot leak into customer purchase flows.
    plans = plans.filter((plan) => isStarterPlan(plan) || isCreatorPlan(plan));

    // Starter accounts may upgrade only to Creator.
    if (req.user?.is_trial_plan) plans = plans.filter(isCreatorPlan);
    res.json({
      ok: true,
      creditsPerMinute: Number(settings.credits_per_minute),
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        badgeText: p.badge_text || '',
        tagline: p.tagline || '',
        price: Number(p.price),
        credits: p.credits,
        minutes: Number(p.minutes),
        description: p.description,
        features: p.features ? p.features.split('|').filter(Boolean) : [],
        isTrial: Boolean(p.is_trial),
        allowTopUp: Boolean(p.allow_top_up),
        isFeatured: Boolean(p.is_featured),
      })),
    });
  } catch (err) { next(err); }
});

// Public: active payment methods shown on the payment page.
router.get('/methods', async (req, res, next) => {
  try {
    const methods = await db.all('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY sort_order, id');
    res.json({
      ok: true,
      methods: methods.map((m) => ({
        id: m.id,
        type: m.method_type,
        label: m.label,
        bankName: m.bank_name,
        accountName: m.account_name,
        accountNumber: m.account_number,
        routingSwift: m.routing_swift,
        cryptoCurrency: m.crypto_currency,
        walletAddress: m.wallet_address,
        networkNote: m.network_note,
      })),
    });
  } catch (err) { next(err); }
});

// Public: active top-up plans shown on the homepage/payment page.
router.get('/topup-plans', async (req, res, next) => {
  try {
    // Top-ups are a Creator-only benefit. Anonymous visitors and Starter
    // users must not receive the catalogue.
    if (!req.user || !req.user.has_active_access || req.user.is_trial_plan) {
      return res.json({ ok: true, plans: [] });
    }
    const plans = await db.all('SELECT * FROM topup_plans WHERE is_active = 1 ORDER BY sort_order, price');
    console.log('[payments/topup-plans] Found', plans.length, 'active top-up plans');
    res.json({
      ok: true,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        badgeText: p.badge_text || '',
        tagline: p.tagline || '',
        price: Number(p.price),
        credits: p.credits,
        minutes: Number(p.minutes),
        description: p.description,
        features: p.features ? p.features.split('|').filter(Boolean) : [],
        isFeatured: Boolean(p.is_featured),
      })),
    });
  } catch (err) { 
    console.error('[payments/topup-plans] Error:', err.message);
    next(err); 
  }
});

// Authenticated: submit a payment (plan + method + receipt upload).
router.post('/submit', requireLogin, uploadReceipt, async (req, res, next) => {
  try {
    console.log('[payments/submit] User', req.user.id, 'submitting payment');
    console.log('[payments/submit] Body:', { planId: req.body.planId, planType: req.body.planType, methodId: req.body.methodId });
    console.log('[payments/submit] File:', req.file ? { filename: req.file.filename, size: req.file.size } : 'NO FILE');

    const planId = parseInt(req.body.planId, 10);
    const planType = req.body.planType || 'activation';
    const methodId = parseInt(req.body.methodId, 10);

    if (!['activation', 'topup'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid payment plan type.' });
    }

    if (!planId || !methodId) {
      console.warn('[payments/submit] Missing required fields');
      return res.status(400).json({ error: 'Plan ID and method ID are required.' });
    }

    let plan;
    if (planType === 'topup') {
      plan = await db.get('SELECT * FROM topup_plans WHERE id = ? AND is_active = 1', [planId]);
      if (!plan) {
        console.warn('[payments/submit] Topup plan', planId, 'not found or inactive');
        return res.status(400).json({ error: 'Invalid top-up plan selected.' });
      }
      if (!req.user.has_active_access) {
        console.warn('[payments/submit] User', req.user.id, 'lacks active access for topup');
        return res.status(400).json({ error: 'You must have an active account to purchase a top-up plan.' });
      }
      if (req.user.is_trial_plan) {
        console.warn('[payments/submit] Starter user', req.user.id, 'attempted topup');
        return res.status(403).json({ error: 'Top-ups are available after upgrading to the Creator plan.', code: 'creator_required' });
      }
    } else {
      plan = await db.get('SELECT * FROM credit_plans WHERE id = ? AND is_active = 1', [planId]);
      if (!plan) {
        console.warn('[payments/submit] Activation plan', planId, 'not found or inactive');
        return res.status(400).json({ error: 'Invalid plan selected.' });
      }
      if (req.user.is_trial_plan && !isCreatorPlan(plan)) {
        console.warn('[payments/submit] Starter user', req.user.id, 'attempted non-Creator upgrade');
        return res.status(403).json({ error: 'Starter accounts may upgrade only to the Creator plan.', code: 'creator_required' });
      }
      if (plan.is_trial && req.user.is_trial_plan) {
        console.warn('[payments/submit] User', req.user.id, 'already on trial');
        return res.status(400).json({ error: 'You are already on the trial activation plan.' });
      }
    }

    const method = await db.get('SELECT * FROM payment_methods WHERE id = ? AND is_active = 1', [methodId]);
    if (!method) {
      console.warn('[payments/submit] Payment method', methodId, 'not found or inactive');
      return res.status(400).json({ error: 'Invalid payment method selected.' });
    }

    if (!req.file) {
      console.warn('[payments/submit] No receipt file uploaded');
      return res.status(400).json({ error: 'A payment receipt/screenshot is required.' });
    }

    const receiptPath = path.basename(req.file.path);
    const amount = Number(plan.price);
    let submissionId;

    if (planType === 'topup') {
      const result = await db.run(
        `INSERT INTO payment_submissions (user_id, topup_plan_id, plan_type, method_id, amount, receipt_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [req.user.id, plan.id, 'topup', method.id, amount, receiptPath, 'pending']
      );
      submissionId = result.id;
      console.log('[payments/submit] ✓ Created topup submission for user', req.user.id);
    } else {
      const result = await db.run(
        `INSERT INTO payment_submissions (user_id, plan_id, plan_type, method_id, amount, receipt_path, status)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [req.user.id, plan.id, 'activation', method.id, amount, receiptPath, 'pending']
      );
      submissionId = result.id;
      console.log('[payments/submit] ✓ Created activation submission for user', req.user.id);
    }

    try {
      await db.run(`INSERT INTO user_activity (user_id, action, details) VALUES (?, ?, ?)`,
        [req.user.id, 'submitted_payment', JSON.stringify({ planId: plan.id, planType, amount, methodId: method.id })]
      );
    } catch (activityErr) {
      console.error('[payments/submit] Activity log failed after payment was saved:', activityErr.message);
    }

    // Notify the admin by email right away — they won't be watching the
    // dashboard every minute, so this is what actually prompts them to
    // go review and approve/reject it. Never allowed to fail the
    // submission itself (e.g. if SMTP isn't configured yet).
    try {
      await sendAdminPaymentNotification({
        user: req.user,
        plan,
        planType,
        amount,
        methodLabel: method.label || method.bank_name || method.crypto_currency || method.method_type,
        submissionId,
      });
    } catch (emailErr) {
      console.error('[payments/submit] Admin notification email failed (non-fatal):', emailErr.message);
    }

    res.json({ ok: true, message: 'Payment submitted. An admin will review it shortly.' });
  } catch (err) { 
    console.error('[payments/submit] Error:', err.message, err.stack);
    next(err); 
  }
});

// Authenticated: serves a receipt image, but only to the user who
// submitted it (admin access to any receipt is handled separately in
// routes/admin.js). Receipts are never served as plain static files.
router.get('/receipt/:submissionId', requireLogin, async (req, res, next) => {
  try {
    const submission = await db.get('SELECT * FROM payment_submissions WHERE id = ?', [req.params.submissionId]);
    if (!submission || submission.user_id !== req.user.id) return res.status(404).end();
    const filePath = path.join(RECEIPTS_DIR, submission.receipt_path);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.sendFile(filePath);
  } catch (err) { next(err); }
});

// Authenticated: a user's own submission history + current balances.
router.get('/my-submissions', requireLogin, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT ps.*, COALESCE(cp.name, tp.name) AS plan_name FROM payment_submissions ps
       LEFT JOIN credit_plans cp ON cp.id = ps.plan_id
       LEFT JOIN topup_plans tp ON tp.id = ps.topup_plan_id
       WHERE ps.user_id = ? ORDER BY ps.created_at DESC`,
      [req.user.id]
    );
    res.json({ ok: true, submissions: rows });
  } catch (err) { next(err); }
});

module.exports = router;
