import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()
const DAILY_RATE = 0.01

function calcEarned(amount, startedAt) {
  const msPerDay = 1000 * 60 * 60 * 24
  const days = (Date.now() - new Date(startedAt).getTime()) / msPerDay
  return parseFloat(amount) * DAILY_RATE * days
}

router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('min_deposit','min_withdraw','min_reinvest','task_price','task_reward','task_ref_bonus','task_project_fee')"
    )
    const mins = {}
    const prices = {}
    rows.forEach(r => {
      if (r.key.startsWith('min_')) mins[r.key.replace('min_', '')] = parseFloat(r.value)
      else prices[r.key] = parseFloat(r.value)
    })
    res.json({ daily_rate: DAILY_RATE, daily_percent: 1, mins, prices })
  } catch {
    res.json({ daily_rate: DAILY_RATE, daily_percent: 1, mins: { deposit: 0.01, withdraw: 0.01, reinvest: 0.001 }, prices: {} })
  }
})

router.get('/my', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT s.* FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE u.telegram_id = $1 AND s.status = 'active' ORDER BY s.created_at DESC`,
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

router.post('/stake', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    // Проверяем минимальный депозит
    const { rows: [minDep] } = await client.query("SELECT value FROM settings WHERE key='min_deposit'")
    const minDepositVal = parseFloat(minDep?.value || 0.01)
    if (parseFloat(amount) < minDepositVal) {
      return res.status(400).json({ error: `Минимальный депозит: ${minDepositVal} TON` })
    }

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (parseFloat(user.balance_ton) < parseFloat(amount)) return res.status(400).json({ error: 'Insufficient balance' })

    await client.query('UPDATE users SET balance_ton = balance_ton - $1 WHERE id = $2', [amount, user.id])

    const { rows: [stake] } = await client.query(
      `INSERT INTO stakes (user_id, amount, started_at, status) VALUES ($1, $2, NOW(), 'active') RETURNING *`,
      [user.id, amount]
    )

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'stake', $2, 'Стейкинг')`,
      [user.id, -parseFloat(amount)]
    )

    // Реферальный бонус за депозит
    if (user.referred_by) {
      const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key = 'ref_deposit_percent'")
      const percent = parseFloat(setting?.value || 5) / 100
      const refBonus = parseFloat(amount) * percent

      if (refBonus > 0) {
        const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [user.referred_by])
        if (referrer) {
          await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [refBonus, referrer.id])
          await client.query(
            `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'ref_deposit', $2, $3)`,
            [referrer.id, refBonus, `Реф. бонус за депозит (${user.username || user.first_name})`]
          )
        }
      }
    }

    await client.query('COMMIT')
    res.json({ stake: { ...stake, earned: 0, daily_reward: parseFloat(amount) * DAILY_RATE } })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

router.post('/unstake/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    const earned = calcEarned(stake.amount, stake.started_at)
    const returnAmount = parseFloat(stake.amount) + earned

    await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [returnAmount, stake.uid])
    await client.query(`UPDATE stakes SET status = 'completed', earned = $1 WHERE id = $2`, [earned, stakeId])
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'reward', $2, 'Вывод стейка + доход')`,
      [stake.uid, returnAmount]
    )

    await client.query('COMMIT')
    res.json({ success: true, returned: returnAmount, principal: parseFloat(stake.amount), earned })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
