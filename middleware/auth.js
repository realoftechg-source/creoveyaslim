const db = require('../db');

/** Attaches req.user (fresh from DB) if a session exists. Always runs. */
async function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    try {
      const user = await db.get('SELECT * FROM users WHERE id = ? AND is_deleted = 0', [req.session.userId]);
      if (user) {
        req.user = user;
      } else {
        req.session.destroy(() => {});
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

/**
 * Blocks suspended users and users without an approved payment from any
 * route that needs real platform access — checked fresh on every request
 * (not just at login), so a suspension or exhausted access takes effect
 * immediately, even on an already-open session/tab.
 */
function requireActiveAccess(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  if (req.user.is_suspended) return res.status(403).json({ error: 'Your account has been suspended.', code: 'suspended' });
  if (!req.user.is_admin && !req.user.has_active_access) {
    return res.status(402).json({ error: 'Payment approval required.', code: 'payment_required' });
  }
  next();
}

module.exports = { loadUser, requireLogin, requireAdmin, requireActiveAccess };
