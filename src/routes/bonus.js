import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

const WELCOME_BONUS = 0.1

// GET /api/bonus/status — проверить получил ли юзер бонус
router.get('/status', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows: [user] } = await pool.query(
      'SELECT welcome_bonus_claimed FROM users WHERE telegram_id=$1', [tgId]
    )
    res.json({ claimed: user?.welcome_bonus_claimed || false, amount: WELCOME_BONUS })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/bonus/claim — забрать бонус
router.post('/claim', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id

    await client.query('BEGIN')

    const { rows: [user] } = await client.query(
      'SELECT * FROM users WHERE telegram_id=$1', [tgId]
    )
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (user.welcome_bonus_claimed) return res.status(400).json({ error: 'Already claimed' })

    // Начисляем бонус на bonus_balance (нельзя вывести)
    await client.query(
      'UPDATE users SET bonus_balance=bonus_balance+$1, welcome_bonus_claimed=true WHERE id=$2',
      [WELCOME_BONUS, user.id]
    )

    // Логируем транзакцию
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1,'bonus',$2,'Приветственный бонус на стейкинг')`,
      [user.id, WELCOME_BONUS]
    )

    await client.query('COMMIT')
    res.json({ ok: true, amount: WELCOME_BONUS })
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router
