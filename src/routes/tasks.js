import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'

const router = Router()

// GET /api/tasks — задания для исполнителя
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
         AND (t.max_executions = 0 OR t.executions < t.max_executions)
       ORDER BY t.created_at DESC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/tasks/create — создать задание (заказчик)
router.post('/create', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { type, title, link, channel_title, channel_photo, max_executions } = req.body

    const ALLOWED_COUNTS = [50, 100, 200, 500, 1000]
    if (!ALLOWED_COUNTS.includes(Number(max_executions))) {
      return res.status(400).json({ error: 'Invalid max_executions. Choose: 50,100,200,500,1000' })
    }

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Получаем цены из настроек
    const { rows: settings } = await client.query("SELECT key, value FROM settings WHERE key IN ('task_price','task_reward','task_ref_bonus','task_project_fee')")
    const s = {}
    settings.forEach(r => s[r.key] = parseFloat(r.value))

    const pricePerExec = s.task_price    || 0.002
    const reward       = s.task_reward   || 0.001
    const refBonus     = s.task_ref_bonus  || 0.0005
    const projectFee   = s.task_project_fee || 0.0005
    const budget       = pricePerExec * Number(max_executions)

    // Проверяем баланс
    if (parseFloat(user.balance_ton) < budget) {
      return res.status(400).json({
        error: 'Insufficient balance',
        required: budget,
        available: user.balance_ton
      })
    }

    // Списываем бюджет
    await client.query('UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2', [budget, user.id])

    // Создаём задание
    const { rows: [task] } = await client.query(
      `INSERT INTO tasks
         (creator_id, type, title, link, channel_title, channel_photo, icon,
          max_executions, executions, budget, reward, price_per_exec, ref_bonus, project_fee, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,true) RETURNING *`,
      [
        user.id, type || 'subscribe', title, link || null,
        channel_title || null, channel_photo || null,
        type === 'bot' ? '🤖' : '✈️',
        Number(max_executions), budget,
        reward, pricePerExec, refBonus, projectFee
      ]
    )

    // Лог транзакции
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'task_budget',$2,$3)`,
      [user.id, -budget, `Бюджет задания: ${title}`]
    )

    await client.query('COMMIT')
    res.json({ task })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// GET /api/tasks/my — мои задания как заказчика
router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.* FROM tasks t
       JOIN users u ON t.creator_id = u.id
       WHERE u.telegram_id = $1
       ORDER BY t.created_at DESC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/tasks/:id/complete — выполнить задание
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

    // Проверка лимита
    if (task.max_executions > 0 && task.executions >= task.max_executions) {
      return res.status(400).json({ error: 'Task limit reached' })
    }

    // Не выполнять своё задание
    if (task.creator_id === user.id) {
      return res.status(400).json({ error: 'Cannot complete your own task' })
    }

    const { rows: [existing] } = await client.query(
      'SELECT id FROM user_tasks WHERE user_id = $1 AND task_id = $2', [user.id, taskId]
    )
    if (existing) return res.status(400).json({ error: 'Already completed' })

    // Проверка подписки
    if (task.type === 'subscribe' && task.link) {
      const bot = getBot()
      if (bot) {
        try {
          const match = task.link.match(/t\.me\/([^/?]+)/)
          if (match) {
            const member = await bot.getChatMember('@' + match[1], tgId)
            if (!['member','administrator','creator'].includes(member.status)) {
              await client.query('ROLLBACK')
              return res.status(400).json({ error: 'Not subscribed', message: 'Подпишись на канал сначала' })
            }
          }
        } catch {}
      }
    }

    const reward    = parseFloat(task.reward)
    const refBonus  = parseFloat(task.ref_bonus)
    const projFee   = parseFloat(task.project_fee)

    // 1. Начислить исполнителю
    await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [reward, user.id])
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'task',$2,$3)`,
      [user.id, reward, task.title]
    )

    // 2. Реферальный бонус исполнителя
    if (user.referred_by && refBonus > 0) {
      const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [user.referred_by])
      if (referrer) {
        await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [refBonus, referrer.id])
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'ref_task',$2,$3)`,
          [referrer.id, refBonus, `Реф. бонус за задание`]
        )
      }
    }

    // 3. Комиссия проекта — на аккаунт админа
    if (projFee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id = 5651190404')
      if (admin) {
        await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [projFee, admin.id])
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'fee',$2,$3)`,
          [admin.id, projFee, `Комиссия: ${task.title}`]
        )
      }
    }

    // 4. Обновить счётчик задания
    await client.query('UPDATE tasks SET executions = executions + 1 WHERE id = $1', [taskId])

    // 5. Деактивировать если лимит достигнут
    if (task.executions + 1 >= task.max_executions) {
      await client.query('UPDATE tasks SET active = false WHERE id = $1', [taskId])
    }

    // 6. Отметить выполнение
    await client.query('INSERT INTO user_tasks (user_id, task_id) VALUES ($1, $2)', [user.id, taskId])

    await client.query('COMMIT')
    res.json({ success: true, reward })
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('TASK COMPLETE ERROR:', e.message, e.stack)
    res.status(500).json({ error: e.message || 'Server error' })
  } finally {
    client.release()
  }
})

export default router