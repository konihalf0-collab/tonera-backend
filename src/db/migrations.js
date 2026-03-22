import pool from '../db/index.js'

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      telegram_id   BIGINT UNIQUE NOT NULL,
      username      TEXT,
      first_name    TEXT,
      last_name     TEXT,
      balance_ton   NUMERIC(18, 8) DEFAULT 0,
      ref_code      TEXT UNIQUE,
      referred_by   BIGINT REFERENCES users(telegram_id),
      referral_count INT DEFAULT 0,
      ton_address   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staking_pools (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      apy         NUMERIC(5, 2) NOT NULL,
      min_amount  NUMERIC(18, 8) DEFAULT 1,
      lock_days   INT DEFAULT 0,
      risk        TEXT DEFAULT 'Низкий',
      active      BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS stakes (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      pool_id     INT REFERENCES staking_pools(id),
      amount      NUMERIC(18, 8) NOT NULL,
      earned      NUMERIC(18, 8) DEFAULT 0,
      started_at  TIMESTAMPTZ DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,
      status      TEXT DEFAULT 'active',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id          SERIAL PRIMARY KEY,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      reward      NUMERIC(18, 8) NOT NULL,
      icon        TEXT DEFAULT '✅',
      link        TEXT,
      active      BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_tasks (
      id          SERIAL PRIMARY KEY,
      user_id     INT REFERENCES users(id),
      task_id     INT REFERENCES tasks(id),
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
      id            SERIAL PRIMARY KEY,
      referrer_id   INT REFERENCES users(id),
      referred_id   INT REFERENCES users(id),
      bonus_paid    BOOLEAN DEFAULT false,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `)

  // Seed default pools
  await pool.query(`
    INSERT INTO staking_pools (name, apy, min_amount, lock_days, risk)
    VALUES
      ('Flexible', 8,  1,   0,  'Низкий'),
      ('Standard', 15, 10,  30, 'Средний'),
      ('Premium',  28, 100, 90, 'Высокий')
    ON CONFLICT DO NOTHING;
  `)

  // Seed default tasks
  await pool.query(`
    INSERT INTO tasks (type, title, reward, icon)
    VALUES
      ('subscribe', 'Подписаться на канал',   0.5, '📢'),
      ('checkin',   'Ежедневный чекин',       0.1, '📅'),
      ('referral',  'Пригласить 1 друга',     1.0, '👥'),
      ('twitter',   'Подписаться на Twitter', 0.3, '🐦'),
      ('stake',     'Сделать первый стейк',   0.5, '💰')
    ON CONFLICT DO NOTHING;
  `)

  console.log('✅ Migrations done')
}
