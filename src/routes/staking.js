import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

const DAILY_RATE = 0.01 // 1% per day

function calcEarned(amount, startedAt) {
  const msPerDay = 1000 * 60 * 60 * 24
  const days = (Date.now() - new Date(startedAt).getTime()) / msPerDay
  return parseFloat(amount) * DAILY_RATE * days
}

// GET /api/staking/info
router.get('/info', async (req, res) => {
  res.json({
    daily_rate: DAILY_RATE,
    daily_percent: 1,
    description: '1% в день от суммы стейка',
  })
})

// GET /api/staking/my
router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT s.*
       FROM stakes s
       JOIN users u ON s.user_id = u.id
       WHERE u.telegram_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC`,
      [tgId]
    )

    const result = rows.map(s => ({
      ...s,
      earned: calcEarned(s.amount, s.started_at),
      daily_reward: parseFloat(s.amount) * DAILY_RATE,
    }))

    res.json(result)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/staking/stake
router.post('/stake', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount } = req.body

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' })
    }

    await client.query('BEGIN')

    const { rows: [user] } = await client.query(
      'SELECT * FROM users WHERE telegram_id = $1', [tgId]
    )
    if (!user) return res.status(404).json({ error: 'User not found' })

    if (parseFloat(user.balance_ton) < parseFloat(amount)) {
      return res.status(400).json({ error: 'Insufficient balance' })
    }

    await client.query(
      'UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2',
      [amount, user.id]
    )

    const { rows: [stake] } = await client.query(
      `INSERT INTO stakes (user_id, amount, started_at, status)
       VALUES ($1, $2, NOW(), 'active') RETURNING *`,
      [user.id, amount]
    )

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label)
       VALUES ($1, 'stake', $2, 'Стейкинг')`,
      [user.id, -parseFloat(amount)]
    )

    await client.query('COMMIT')

    res.json({
      stake: {
        ...stake,
        earned: 0,
        daily_reward: parseFloat(amount) * DAILY_RATE,
      }
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/unstake/:stakeId
router.post('/unstake/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid
       FROM stakes s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    const earned = calcEarned(stake.amount, stake.started_at)
    const returnAmount = parseFloat(stake.amount) + earned

    await client.query(
      'UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2',
      [returnAmount, stake.uid]
    )

    await client.query(
      `UPDATE stakes SET status = 'completed', earned = $1 WHERE id = $2`,
      [earned, stakeId]
    )

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label)
       VALUES ($1, 'reward', $2, 'Вывод стейка + доход')`,
      [stake.uid, returnAmount]
    )

    await client.query('COMMIT')
    res.json({
      success: true,
      returned: returnAmount,
      principal: parseFloat(stake.amount),
      earned,
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
