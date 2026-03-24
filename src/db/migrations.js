import pool from '../db/index.js'

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              SERIAL PRIMARY KEY,
      telegram_id     BIGINT UNIQUE NOT NULL,
      username        TEXT,
      first_name      TEXT,
      last_name       TEXT,
      balance_ton     NUMERIC(18, 8) DEFAULT 0,
      ref_code        TEXT UNIQUE,
      referred_by     BIGINT REFERENCES users(telegram_id),
      referral_count  INT DEFAULT 0,
      ton_address     TEXT,
      is_blocked      BOOLEAN DEFAULT false,
      pending_ref     TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS stakes (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      pool_id     INT DEFAULT NULL,
      amount      NUMERIC(18, 8) NOT NULL,
      earned      NUMERIC(18, 8) DEFAULT 0,
      started_at  TIMESTAMPTZ DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,
      status      TEXT DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id              SERIAL PRIMARY KEY,
      creator_id      INT REFERENCES users(id) DEFAULT NULL,
      type            TEXT NOT NULL DEFAULT 'subscribe',
      title           TEXT NOT NULL,
      description     TEXT,
      reward          NUMERIC(18, 8) NOT NULL DEFAULT 0.001,
      price_per_exec  NUMERIC(18, 8) NOT NULL DEFAULT 0.002,
      ref_bonus       NUMERIC(18, 8) NOT NULL DEFAULT 0.0005,
      project_fee     NUMERIC(18, 8) NOT NULL DEFAULT 0.0005,
      icon            TEXT DEFAULT '✈️',
      link            TEXT,
      channel_title   TEXT,
      channel_photo   TEXT,
      max_executions  INT DEFAULT 100,
      executions      INT DEFAULT 0,
      budget          NUMERIC(18, 8) DEFAULT 0,
      active          BOOLEAN DEFAULT true,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_tasks (
      id           SERIAL PRIMARY KEY,
      user_id      INT REFERENCES users(id),
      task_id      INT REFERENCES tasks(id),
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      type        TEXT NOT NULL,
      amount      NUMERIC(18, 8) NOT NULL,
      label       TEXT,
      status      TEXT DEFAULT 'completed',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS referrals (
      id           SERIAL PRIMARY KEY,
      referrer_id  INT REFERENCES users(id),
      referred_id  INT REFERENCES users(id),
      bonus_paid   BOOLEAN DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked  BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_ref TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(18,8) DEFAULT 0`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_bonus_claimed BOOLEAN DEFAULT false`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_ref TEXT`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS creator_id     INT REFERENCES users(id) DEFAULT NULL`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS price_per_exec NUMERIC(18,8) DEFAULT 0.002`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ref_bonus      NUMERIC(18,8) DEFAULT 0.0005`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_fee    NUMERIC(18,8) DEFAULT 0.0005`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_executions INT DEFAULT 100`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS executions     INT DEFAULT 0`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget         NUMERIC(18,8) DEFAULT 0`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel_title  TEXT`)
  await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS channel_photo  TEXT`)

  await pool.query(`
    INSERT INTO settings (key, value) VALUES
      ('ref_register_bonus',  '0.5'),
      ('ref_task_percent',    '10'),
      ('ref_deposit_percent', '5'),
      ('task_reward',         '0.001'),
      ('task_price',          '0.002'),
      ('task_ref_bonus',      '0.0005'),
      ('task_project_fee',    '0.0005'),
      ('project_wallet',      process.env.PROJECT_WALLET || ''),
      ('min_deposit_ton',     '0.5'),
      ('min_deposit',          '0.01'),
      ('min_withdraw',         '0.01'),
      ('min_reinvest',         '0.001')
    ON CONFLICT (key) DO NOTHING;
  `)

  console.log('✅ Migrations done')
}