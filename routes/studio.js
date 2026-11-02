const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireActiveAccess, requireLogin } = require('../middleware/auth');
const { isDecartConfigured, createRealtimeClientToken } = require('../utils/decart');

const router = express.Router();

const LOOKS_DIR = path.join(__dirname, '..', 'uploads', 'looks');
fs.mkdirSync(LOOKS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOOKS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${req.user.id}_${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});

async function getSettings() {
  return db.get('SELECT * FROM platform_settings WHERE id = 1');
}

/**
 * Deducts elapsed real time from a user's seconds_balance, based on the
 * SERVER's own clock comparison between now and the session's
 * last_heartbeat_at (a TIMESTAMPTZ column — node-postgres already gives
 * us this back as a real JS Date, so no string parsing is needed) —
 * never trusting anything the client claims about elapsed time. Also
 * derives a matching credits deduction using the global, admin-editable
 * credits_per_minute rate, so the two numbers never drift apart.
 */
async function reconcileSession(session) {
  const settings = await getSettings();
  const now = new Date();
  const last = new Date(session.last_heartbeat_at);
  let elapsedSeconds = Math.max(0, Math.floor((now - last) / 1000));

  const user = await db.get('SELECT * FROM users WHERE id = ?', [session.user_id]);

  // Cap elapsed time to whatever balance the user actually has left —
  // this is the server-side enforcement point: usage cannot exceed the
  // remaining balance no matter how long the client keeps the tab open.
  const cappedSeconds = Math.min(elapsedSeconds, user.seconds_balance);
  const creditsToDeduct = Math.round((cappedSeconds / 60) * Number(settings.credits_per_minute));
  const cappedCredits = Math.min(creditsToDeduct, user.credits_balance);

  await db.run('UPDATE users SET seconds_balance = seconds_balance - ?, credits_balance = credits_balance - ? WHERE id = ?',
    [cappedSeconds, cappedCredits, user.id]);

  await db.run(`UPDATE stream_sessions
              SET seconds_used = seconds_used + ?, credits_used = credits_used + ?, last_heartbeat_at = NOW()
              WHERE id = ?`,
    [cappedSeconds, cappedCredits, session.id]);

  const updatedUser = await db.get('SELECT * FROM users WHERE id = ?', [user.id]);
  const updatedSession = await db.get('SELECT * FROM stream_sessions WHERE id = ?', [session.id]);
  return { user: updatedUser, session: updatedSession, exhausted: updatedUser.seconds_balance <= 0 };
}

async function getActiveSession(userId) {
  return db.get(`SELECT * FROM stream_sessions WHERE user_id = ? AND status = 'live' ORDER BY id DESC LIMIT 1`, [userId]);
}

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

router.post('/stream/start', requireActiveAccess, async (req, res, next) => {
  try {
    const existing = await getActiveSession(req.user.id);
    if (existing) return res.status(400).json({ error: 'A stream is already live.' });

    if (req.user.seconds_balance <= 0) {
      return res.status(402).json({ error: 'You are out of usage time. Please purchase another plan.', code: 'no_balance' });
    }

    const result = await db.run(
      `INSERT INTO stream_sessions (user_id, status, started_at, last_heartbeat_at)
       VALUES (?, 'live', NOW(), NOW()) RETURNING id`,
      [req.user.id]
    );

    res.json({ ok: true, sessionId: result.id, secondsRemaining: req.user.seconds_balance });
  } catch (err) { next(err); }
});

/**
 * The frontend calls this every ~10 seconds while live. It's the sole
 * mechanism that actually deducts usage — a client-side timer alone is
 * never trusted. If the user runs out mid-stream, this responds with
 * exhausted: true so the frontend can force-stop the Decart connection
 * immediately rather than waiting for the user to click Stop.
 */
router.post('/stream/heartbeat', requireLogin, async (req, res, next) => {
  try {
    const session = await getActiveSession(req.user.id);
    if (!session) return res.status(404).json({ error: 'No active stream.' });

    const { user, exhausted } = await reconcileSession(session);

    if (exhausted) {
      await db.run(`UPDATE stream_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'exhausted' WHERE id = ?`, [session.id]);
    }

    res.json({
      ok: true,
      secondsRemaining: user.seconds_balance,
      creditsRemaining: user.credits_balance,
      exhausted,
    });
  } catch (err) { next(err); }
});

router.post('/stream/stop', requireLogin, async (req, res, next) => {
  try {
    const session = await getActiveSession(req.user.id);
    if (!session) return res.status(404).json({ error: 'No active stream.' });

    const { user } = await reconcileSession(session);
    await db.run(`UPDATE stream_sessions SET status = 'ended', ended_at = NOW(), end_reason = 'user_stopped' WHERE id = ?`, [session.id]);

    res.json({ ok: true, secondsRemaining: user.seconds_balance, creditsRemaining: user.credits_balance });
  } catch (err) { next(err); }
});

router.get('/stream/status', requireLogin, async (req, res, next) => {
  try {
    const session = await getActiveSession(req.user.id);
    res.json({
      ok: true,
      live: Boolean(session),
      secondsRemaining: req.user.seconds_balance,
      creditsRemaining: req.user.credits_balance,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Looks (target faces)
// ---------------------------------------------------------------------------

router.get('/looks', requireLogin, async (req, res, next) => {
  try {
    const looks = await db.all('SELECT id, name, created_at FROM looks WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ ok: true, looks });
  } catch (err) { next(err); }
});

router.post('/looks', requireActiveAccess, upload.single('image'), async (req, res, next) => {
  try {
    const name = (req.body.name || 'My Look').trim();
    if (!req.file) return res.status(400).json({ error: 'An image is required.' });

    // Duplicate-submit guard: if this same user just saved a look with the same
    // name in the last 30 seconds (double click / retry), return that one and
    // discard the extra upload instead of creating a second copy.
    const dup = await db.get(
      `SELECT id FROM looks WHERE user_id = ? AND name = ? AND created_at > NOW() - INTERVAL '30 seconds' ORDER BY id DESC LIMIT 1`,
      [req.user.id, name]
    );
    if (dup) {
      fs.unlink(req.file.path, () => {});
      return res.json({ ok: true, lookId: dup.id, duplicate: true });
    }

    const result = await db.run(
      `INSERT INTO looks (user_id, name, prompt, image_path) VALUES (?, ?, ?, ?) RETURNING id`,
      [req.user.id, name, req.body.prompt || '', path.basename(req.file.path)]
    );

    res.json({ ok: true, lookId: result.id });
  } catch (err) { next(err); }
});

router.delete('/looks/:id', requireLogin, async (req, res, next) => {
  try {
    const look = await db.get('SELECT * FROM looks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!look) return res.status(404).json({ error: 'Look not found.' });
    if (look.image_path) fs.unlink(path.join(LOOKS_DIR, look.image_path), () => {});
    await db.run('DELETE FROM looks WHERE id = ?', [look.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/looks/:id/image', requireLogin, async (req, res, next) => {
  try {
    const look = await db.get('SELECT * FROM looks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!look) return res.status(404).end();
    res.sendFile(path.join(LOOKS_DIR, look.image_path));
  } catch (err) { next(err); }
});

// Switching a look mid-session requires remaining balance, same as
// starting a stream — this is what actually locks the "choose your look"
// UI once a user's usage is exhausted.
router.post('/looks/:id/select', requireActiveAccess, async (req, res, next) => {
  try {
    if (req.user.seconds_balance <= 0) {
      return res.status(402).json({ error: 'Out of usage time. Purchase a plan to switch looks.', code: 'no_balance' });
    }
    const look = await db.get('SELECT * FROM looks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!look) return res.status(404).json({ error: 'Look not found.' });
    res.json({ ok: true, look: { id: look.id, name: look.name, prompt: look.prompt } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Decart realtime token
// ---------------------------------------------------------------------------

router.post('/realtime-token', requireActiveAccess, async (req, res, next) => {
  try {
    if (req.user.seconds_balance <= 0) {
      return res.status(402).json({ error: 'Out of usage time. Purchase a plan to go live.', code: 'no_balance' });
    }
    if (!(await isDecartConfigured())) {
      return res.status(503).json({ error: 'AI engine not configured yet. Contact the site admin.' });
    }
    const { token, error } = await createRealtimeClientToken();
    if (!token) return res.status(502).json({ error });
    res.json({ ok: true, ...token });
  } catch (err) { next(err); }
});

module.exports = router;
