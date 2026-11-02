const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy your Neon connection string into .env as DATABASE_URL.');
}

const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (and most managed Postgres) require SSL. Local/self-hosted
  // Postgres during development usually doesn't have it configured, so
  // we skip it automatically when the host is localhost.
  ssl: isLocalDb ? false : { require: true },
});

pool.on('error', (err) => {
  console.error('[db] Unexpected Postgres pool error:', err);
});

/** Converts `?` placeholders (used throughout the route files) into Postgres's $1, $2... */
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function all(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows;
}

async function get(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows[0] || null;
}

/**
 * Runs an INSERT/UPDATE/DELETE. For inserts where the caller needs the new
 * row's id, append `RETURNING id` to the SQL — result.id will then be set.
 */
async function run(sql, params = []) {
  const res = await pool.query(toPgSql(sql), params);
  return { changes: res.rowCount, id: res.rows[0]?.id };
}

// ---------------------------------------------------------------------------
// Schema (idempotent — safe to run on every boot)
// ---------------------------------------------------------------------------
// See README "Credit & Usage Model" for why credits_balance and
// seconds_balance are tracked as two separate, always-together-updated
// numbers, and why platform_settings.credits_per_minute is the single
// global conversion rate used everywhere.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS credit_plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  badge_text TEXT DEFAULT '',
  tagline TEXT DEFAULT '',
  price NUMERIC NOT NULL,
  credits INTEGER NOT NULL,
  minutes NUMERIC NOT NULL,
  description TEXT DEFAULT '',
  features TEXT DEFAULT '',
  is_trial INTEGER NOT NULL DEFAULT 0,
  allow_top_up INTEGER NOT NULL DEFAULT 1,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_suspended INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  has_active_access INTEGER NOT NULL DEFAULT 0,
  credits_balance INTEGER NOT NULL DEFAULT 0,
  seconds_balance INTEGER NOT NULL DEFAULT 0,
  current_plan_id INTEGER REFERENCES credit_plans(id) ON DELETE SET NULL,
  is_trial_plan INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topup_plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  badge_text TEXT DEFAULT '',
  tagline TEXT DEFAULT '',
  price NUMERIC NOT NULL,
  credits INTEGER NOT NULL,
  minutes NUMERIC NOT NULL,
  description TEXT DEFAULT '',
  features TEXT DEFAULT '',
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  method_type TEXT NOT NULL CHECK(method_type IN ('bank','crypto')),
  label TEXT DEFAULT '',
  bank_name TEXT DEFAULT '',
  account_name TEXT DEFAULT '',
  account_number TEXT DEFAULT '',
  routing_swift TEXT DEFAULT '',
  crypto_currency TEXT DEFAULT '',
  wallet_address TEXT DEFAULT '',
  network_note TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_submissions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES credit_plans(id) ON DELETE SET NULL,
  topup_plan_id INTEGER REFERENCES topup_plans(id) ON DELETE SET NULL,
  plan_type TEXT NOT NULL DEFAULT 'activation' CHECK(plan_type IN ('activation','topup')),
  method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  receipt_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  admin_note TEXT DEFAULT '',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  decart_api_key_override TEXT DEFAULT '',
  support_telegram_username TEXT DEFAULT '',
  credits_per_minute NUMERIC NOT NULL DEFAULT 50,
  site_name TEXT NOT NULL DEFAULT 'Creoveya'
);

CREATE TABLE IF NOT EXISTS looks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  image_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stream_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'live' CHECK(status IN ('live','ended')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  seconds_used INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_activity (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function initDb() {
  await pool.query(SCHEMA_SQL);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS current_plan_id INTEGER REFERENCES credit_plans(id) ON DELETE SET NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx ON users(google_id) WHERE google_id IS NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trial_plan INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS badge_text TEXT DEFAULT '';
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS tagline TEXT DEFAULT '';
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS features TEXT DEFAULT '';
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS is_trial INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS allow_top_up INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS is_featured INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES credit_plans(id) ON DELETE SET NULL;
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS topup_plan_id INTEGER REFERENCES topup_plans(id) ON DELETE SET NULL;
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'activation';
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL;
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS amount NUMERIC;
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS receipt_path TEXT DEFAULT '';
    ALTER TABLE payment_submissions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
  `);

  const settingsRow = await get('SELECT * FROM platform_settings WHERE id = 1');
  if (!settingsRow) {
    await run(`INSERT INTO platform_settings (id, decart_api_key_override, support_telegram_username, credits_per_minute, site_name)
                VALUES (1, '', '', 50, 'Creoveya')`);
  }

  const planCount = (await get('SELECT COUNT(*) AS c FROM credit_plans')).c;
  if (Number(planCount) === 0) {
    await run(`INSERT INTO credit_plans (name, badge_text, tagline, price, credits, minutes, description, features, is_trial, allow_top_up, is_featured, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['Trial', 'Most Popular', 'Best for first-time creators', 10, 300, 6, 'Entry activation for a first-time user.', 'Access to all AI engines|Full dashboard & session history|Simple pay-as-you-go activation', 1, 0, 1, 1, 1]);
    await run(`INSERT INTO credit_plans (name, badge_text, tagline, price, credits, minutes, description, features, is_trial, allow_top_up, is_featured, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ['Full Access', 'Best Value', 'For regular streamers who need more runtime', 65, 5000, 25, 'Unlimited access to the full AI studio.', 'Access to all AI engines|Full dashboard & session history|Priority support', 0, 1, 1, 1, 2]);
  }

  const topupCount = (await get('SELECT COUNT(*) AS c FROM topup_plans')).c;
  if (Number(topupCount) === 0) {
    await run(`INSERT INTO topup_plans (name, badge_text, price, credits, minutes, description, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['Quick Top-Up', '', 10, 500, 5, '5 minutes of instant streaming time', 1, 1]);
    await run(`INSERT INTO topup_plans (name, badge_text, price, credits, minutes, description, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['Standard Top-Up', 'Best Value', 30, 1500, 15, '15 minutes of streaming time', 1, 2]);
    await run(`INSERT INTO topup_plans (name, badge_text, price, credits, minutes, description, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['Pro Top-Up', '', 60, 3500, 30, '30 minutes of streaming time', 1, 3]);
    await run(`INSERT INTO topup_plans (name, badge_text, price, credits, minutes, description, is_active, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['Plus Top-Up', '', 100, 6000, 50, '50 minutes of extended streaming', 1, 4]);
  }

  const adminCount = (await get('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1')).c;
  if (Number(adminCount) === 0) {
    const username = process.env.INITIAL_ADMIN_USERNAME || 'admin';
    const password = process.env.INITIAL_ADMIN_PASSWORD || 'change-this-immediately';
    const hash = bcrypt.hashSync(password, 12);
    await run(`INSERT INTO users (username, email, password_hash, is_admin, has_active_access, credits_balance, seconds_balance)
                VALUES (?, '', ?, 1, 1, 0, 0)`, [username, hash]);
    console.log(`[seed] Created initial admin user "${username}". Log in and change this password immediately.`);
  }
}

module.exports = { pool, get, all, run, initDb };
