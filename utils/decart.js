const { createDecartClient } = require('@decartai/sdk');
const db = require('../db');

/**
 * Resolves the active Decart API key: an admin-set override from
 * /admin_dashboard/settings takes priority over the DECART_API_KEY
 * environment variable, so the admin can rotate keys without a redeploy.
 */
async function getDecartApiKey() {
  const settings = await db.get('SELECT decart_api_key_override FROM platform_settings WHERE id = 1');
  if (settings && settings.decart_api_key_override) return settings.decart_api_key_override;
  return process.env.DECART_API_KEY || '';
}

async function isDecartConfigured() {
  return Boolean(await getDecartApiKey());
}

/**
 * Exchanges the permanent server-side API key for a short-lived client
 * token. This is the piece confirmed working in the original Node.js
 * prototype — preserved as-is, just made key-rotatable via admin settings.
 */
async function createRealtimeClientToken() {
  const apiKey = await getDecartApiKey();
  if (!apiKey) {
    return { token: null, error: 'DECART_API_KEY is not configured. Set it in .env or from /admin_dashboard/settings.' };
  }
  try {
    const client = createDecartClient({ apiKey });
    const tokenData = await client.tokens.create();
    return { token: tokenData, error: null };
  } catch (err) {
    console.error('[decart] Token exchange failed:', err.message || err);
    return { token: null, error: 'Failed to generate a realtime streaming token. Check your Decart API key.' };
  }
}

module.exports = { getDecartApiKey, isDecartConfigured, createRealtimeClientToken };
