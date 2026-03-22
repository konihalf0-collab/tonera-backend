import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT u2.username, u2.first_name, r.created_at
       FROM referrals r
       JOIN users u1 ON r.referrer_id = u1.id
       JOIN users u2 ON r.referred_id = u2.id
       WHERE u1.telegram_id = $1
       ORDER BY r.created_at DESC`,
      [tgId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/apply', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { ref_code } = req.body
    if (!ref_code) return res.status(400).json({ error: 'No ref code' })

    await client.query('BEGIN')

    const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE ref_code = $1', [ref_code])
    if (!referrer) return res.status(404).json({ error: 'Invalid ref code' })

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id = $1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (referrer.telegram_id === user.telegram_id) return res.status(400).json({ error: 'Cannot refer yourself' })

    const { rows: [existing] } = await client.query('SELECT id FROM referrals WHERE referred_id = $1', [user.id])
    if (existing) return res.status(400).json({ error: 'Already referred' })

    // Create referral
    await client.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)', [referrer.id, user.id])
    await client.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrer.telegram_id, user.id])
    await client.query('UPDATE users SET referral_count = referral_count + 1 WHERE id = $1', [referrer.id])

    // Register bonus
    const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key = 'ref_register_bonus'")
    const bonus = parseFloat(setting?.value || 0.5)

    if (bonus > 0) {
      await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [bonus, referrer.id])
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'reward', $2, $3)`,
        [referrer.id, bonus, `Реф. бонус за регистрацию (${user.username || user.first_name})`]
      )
    }

    await client.query('COMMIT')
    res.json({ success: true })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
