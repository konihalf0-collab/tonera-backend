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

    // Get user
    const { rows: [user] } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1', [tgId]
    )
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Get task
    const { rows: [task] } = await client.query(
      'SELECT * FROM tasks WHERE id = $1 AND active = true', [taskId]
    )
    if (!task) return res.status(404).json({ error: 'Task not found' })

    // Check if already done
    const { rows: [existing] } = await client.query(
      'SELECT id FROM user_tasks WHERE user_id = $1 AND task_id = $2',
      [user.id, taskId]
    )
    if (existing) return res.status(400).json({ error: 'Already completed' })

    // Mark complete
    await client.query(
      'INSERT INTO user_tasks (user_id, task_id) VALUES ($1, $2)',
      [user.id, taskId]
    )

    // Add reward
    await client.query(
      'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
      [task.reward, user.id]
    )

    // Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label)
       VALUES ($1, 'task', $2, $3)`,
      [user.id, task.reward, task.title]
    )

    await client.query('COMMIT')
    res.json({ success: true, reward: task.reward })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
