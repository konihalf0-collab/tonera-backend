import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()
const ADMIN_ID = 5651190404

function adminOnly(req, res, next) {
  if (Number(req.telegramUser?.id) !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' })
  next()
}

router.get('/settings', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings ORDER BY key')
    const settings = {}
    rows.forEach(r => settings[r.key] = r.value)
    res.json(settings)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/settings', adminOnly, async (req, res) => {
  try {
    const { key, value } = req.body
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' })
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, String(value)]
    )
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/stats', adminOnly, async (req, res) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM stakes WHERE status='active') as active_stakes,
        (SELECT COALESCE(SUM(amount),0) FROM stakes WHERE status='active') as total_staked,
        (SELECT COUNT(*) FROM referrals) as total_referrals,
        (SELECT COUNT(*) FROM user_tasks) as tasks_completed
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

    // Получаем фиксированную награду из настроек
    const { rows: [setting] } = await pool.query("SELECT value FROM settings WHERE key = 'task_reward'")
    const taskReward = reward || parseFloat(setting?.value || 0.5)

    const { rows: [task] } = await pool.query(
      `INSERT INTO tasks (type, title, reward, icon, link, channel_title, channel_photo, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [type || 'subscribe', title, taskReward, icon || '✈️', link || null, channel_title || null, channel_photo || null]
    )
    res.json(task)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/tasks/:id', adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_tasks WHERE task_id = $1', [req.params.id])
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/users', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, telegram_id, username, first_name, balance_ton, referral_count, created_at FROM users ORDER BY created_at DESC LIMIT 50'
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
