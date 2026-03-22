import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

// GET /api/tasks
router.get('/', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.*,
         CASE WHEN ut.id IS NOT NULL THEN true ELSE false END as completed
       FROM tasks t
       LEFT JOIN users u ON u.telegram_id = $1
       LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = u.id
       WHERE t.active = true
       ORDER BY t.id ASC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/tasks/:id/complete
router.post('/:id/complete', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const taskId = parseInt(req.params.id)

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id = $1 AND active = true', [taskId])
    if (!task) return res.status(404).json({ error: 'Task not found' })

    const { rows: [existing] } = await client.query(
      'SELECT id FROM user_tasks WHERE user_id = $1 AND task_id = $2', [user.id, taskId]
    )
    if (existing) return res.status(400).json({ error: 'Already completed' })

    // Mark complete
    await client.query('INSERT INTO user_tasks (user_id, task_id) VALUES ($1, $2)', [user.id, taskId])

    // Add reward to user
    await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [task.reward, user.id])

    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'task', $2, $3)`,
      [user.id, task.reward, task.title]
    )

    // Referral bonus — % от награды задания
    if (user.referred_by) {
      const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key = 'ref_task_percent'")
      const percent = parseFloat(setting?.value || 10) / 100
      const refBonus = parseFloat(task.reward) * percent

      if (refBonus > 0) {
        const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [user.referred_by])
        if (referrer) {
          await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [refBonus, referrer.id])
          await client.query(
            `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'ref_task', $2, $3)`,
            [referrer.id, refBonus, `Реф. бонус за задание (${user.username || user.first_name})`]
          )
        }
      }
    }

    await client.query('COMMIT')
    res.json({ success: true, reward: task.reward })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
