import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

function adminOnly(req, res, next) {
  if (Number(req.telegramUser?.id) !== ADMIN_TG_ID) return res.status(403).json({ error: 'Forbidden' })
  next()
}

router.get('/settings', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings ORDER BY key')
    const s = {}
    rows.forEach(r => s[r.key] = r.value)
    res.json(s)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/settings', adminOnly, async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' })
    await pool.query('INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/stats', adminOnly, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM users WHERE is_blocked=true) as blocked_users,
        (SELECT COUNT(*) FROM stakes WHERE status='active') as active_stakes,
        (SELECT COALESCE(SUM(amount),0) FROM stakes WHERE status='active') - (SELECT COALESCE(SUM(bonus_balance),0) FROM users) as total_staked,
        (SELECT COUNT(*) FROM referrals) as total_referrals,
        (SELECT COUNT(*) FROM user_tasks) as tasks_completed,
        (SELECT COUNT(*) FROM tasks WHERE active=true) as active_tasks,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='fee' AND label LIKE '%стейк%') as staking_fee_earned,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='fee' AND label LIKE '%задани%') as task_fee_earned,
        (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='deposit') as total_deposited,
        (SELECT ABS(COALESCE(SUM(amount),0)) FROM transactions WHERE type='withdraw') as total_withdrawn
    `)
    res.json(stats)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/tasks', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/tasks', adminOnly, async (req, res) => {
  try {
    const { type, title, reward, icon, link, channel_title, channel_photo } = req.body
    if (!title) return res.status(400).json({ error: 'title required' })
    const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key='task_reward'")
    const taskReward = reward || parseFloat(s?.value || 0.001)
    const { rows: [task] } = await pool.query(
      `INSERT INTO tasks (type,title,reward,icon,link,channel_title,channel_photo,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [type || 'subscribe', title, taskReward, icon || '✈️', link || null, channel_title || null, channel_photo || null]
    )
    res.json(task)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/tasks/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_tasks WHERE task_id=$1', [req.params.id])
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/users
router.get('/users', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,telegram_id,username,first_name,balance_ton,referral_count,is_blocked,created_at FROM users ORDER BY created_at DESC LIMIT 100'
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/users/:id/block — заблокировать
router.post('/users/:id/block', adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_blocked=true WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/users/:id/unblock — разблокировать
router.post('/users/:id/unblock', adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_blocked=false WHERE id=$1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// DELETE /api/admin/users/:id — удалить
router.delete('/users/:id', adminOnly, async (req, res) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM user_tasks WHERE user_id=$1', [req.params.id])
    await client.query('DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1', [req.params.id])
    await client.query('DELETE FROM transactions WHERE user_id=$1', [req.params.id])
    await client.query('DELETE FROM stakes WHERE user_id=$1', [req.params.id])
    await client.query('UPDATE tasks SET creator_id=NULL WHERE creator_id=$1', [req.params.id])
    await client.query('DELETE FROM users WHERE id=$1', [req.params.id])
    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router

// GET /api/admin/withdrawals
router.get('/withdrawals', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, u.username, u.first_name FROM transactions t
       JOIN users u ON t.user_id = u.id
       WHERE t.type = 'withdraw'
       ORDER BY t.created_at DESC LIMIT 100`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/withdrawals/:id/complete
router.post('/withdrawals/:id/complete', adminOnly, async (req, res) => {
  try {
    const { rows: [tx] } = await pool.query(
      "UPDATE transactions SET status='completed' WHERE id=$1 RETURNING *",
      [req.params.id]
    )
    if (tx) {
      // Уведомляем юзера
      const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id=$1', [tx.user_id])
      if (user) {
        try {
          const { getBot } = await import('../bot.js')
          const bot = getBot()
          if (bot) {
            const labelParts = (tx.label || '').split('|net:')
            const netAmt = labelParts[1] ? parseFloat(labelParts[1]).toFixed(4) : Math.abs(parseFloat(tx.amount)).toFixed(4)
            const totalAmt = Math.abs(parseFloat(tx.amount)).toFixed(4)
            const feeAmt = (Math.abs(parseFloat(tx.amount)) - parseFloat(netAmt)).toFixed(4)
            const msg = parseFloat(feeAmt) > 0
              ? `✅ *Вывод выполнен*\n\nЗапрошено: *${totalAmt} TON*\nКомиссия: *${feeAmt} TON*\nПолучите: *${netAmt} TON*`
              : `✅ *Вывод выполнен*\n\nСумма: *${netAmt} TON* отправлена на ваш кошелёк.`
            await bot.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' })
          }
        } catch (e) { console.error('Notify error:', e.message) }
      }
    }
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/users/:id/stats — детальная статистика юзера
router.get('/users/:id/stats', adminOnly, async (req, res) => {
  try {
    const { rows: [user] } = await pool.query(
      'SELECT * FROM users WHERE id=$1', [req.params.id]
    )
    if (!user) return res.status(404).json({ error: 'Not found' })

    const { rows: txs } = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    )
    const { rows: stakes } = await pool.query(
      'SELECT * FROM stakes WHERE user_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    )
    const { rows: tasks } = await pool.query(
      `SELECT t.title, ut.completed_at FROM user_tasks ut
       JOIN tasks t ON ut.task_id=t.id
       WHERE ut.user_id=$1 ORDER BY ut.completed_at DESC`,
      [req.params.id]
    )

    const totalDeposit = txs.filter(t => t.type === 'deposit').reduce((s, t) => s + parseFloat(t.amount), 0)
    const totalWithdraw = txs.filter(t => t.type === 'withdraw').reduce((s, t) => s + Math.abs(parseFloat(t.amount)), 0)
    const totalStaked = stakes.filter(s => s.status === 'active').reduce((s, t) => s + parseFloat(t.amount), 0)

    res.json({ user, txs, stakes, tasks, stats: { totalDeposit, totalWithdraw, totalStaked, tasksCount: tasks.length } })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/maintenance
router.get('/maintenance', adminOnly, async (req, res) => {
  try {
    const { rows: [r] } = await pool.query("SELECT value FROM settings WHERE key='maintenance'")
    res.json({ maintenance: r?.value || '0' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/admin/maintenance
router.post('/maintenance', adminOnly, async (req, res) => {
  try {
    await pool.query("UPDATE settings SET value=$1 WHERE key='maintenance'", [req.body.value])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// GET /api/admin/backup
router.get('/backup', adminOnly, async (req, res) => {
  try {
    const [users, stakes, tasks, transactions, settings] = await Promise.all([
      pool.query('SELECT * FROM users'),
      pool.query('SELECT * FROM stakes'),
      pool.query('SELECT * FROM tasks'),
      pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10000'),
      pool.query('SELECT * FROM settings'),
    ])
    const backup = {
      date: new Date().toISOString(),
      users: users.rows,
      stakes: stakes.rows,
      tasks: tasks.rows,
      transactions: transactions.rows,
      settings: settings.rows,
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', `attachment; filename=tonera-backup-${new Date().toISOString().slice(0,10)}.json`)
    res.json(backup)
  } catch (e) { res.status(500).json({ error: e.message }) }
})
