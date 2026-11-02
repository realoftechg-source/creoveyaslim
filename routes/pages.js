const express = require('express');
const db = require('../db');
const { rateLimit, requireCaptcha } = require('../utils/security');

const router = express.Router();

// Public: returns the admin's configured support Telegram link, so the
// frontend can show "message us on Telegram" without hardcoding it.
router.get('/telegram-link', async (req, res, next) => {
  try {
    const settings = await db.get('SELECT support_telegram_username FROM platform_settings WHERE id = 1');
    const username = (settings.support_telegram_username || '').trim().replace(/^@/, '');
    res.json({ ok: true, username, url: username ? `https://t.me/${username}` : null });
  } catch (err) { next(err); }
});

router.post('/contact', rateLimit({ name: 'contact', windowMs: 60 * 60 * 1000, max: 10, message: 'Too many messages sent. Please try again later.' }), requireCaptcha, async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const message = (req.body.message || '').trim();
    if (!name || !message) return res.status(400).json({ error: 'Name and message are required.' });
    if (message.length > 4000) return res.status(400).json({ error: 'Message is too long.' });

    await db.run('INSERT INTO contact_messages (name, message) VALUES (?, ?)', [name, message]);

    // Forwarding to Telegram itself requires a bot token + chat id, which
    // is beyond a simple form POST — this stores every submission so the
    // admin can always see it, and forwards it to Telegram automatically
    // if TELEGRAM_BOT_TOKEN is set in .env (see README).
    forwardToTelegramIfConfigured(name, message).catch((err) => {
      console.warn('[contact] Telegram forward skipped/failed:', err.message);
    });

    res.json({ ok: true, message: 'Thanks — your message has been sent.' });
  } catch (err) { next(err); }
});

async function forwardToTelegramIfConfigured(name, message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const settings = await db.get('SELECT support_telegram_username FROM platform_settings WHERE id = 1');
  const chatUsername = (settings.support_telegram_username || '').trim();
  if (!chatUsername) return;

  const text = `New Contact Us message from Creoveya\n\nFrom: ${name}\n\n${message}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: `@${chatUsername.replace(/^@/, '')}`, text }),
  });
}

module.exports = router;
