import { Router } from 'express'
import pool from '../db/index.js'
import crypto from 'crypto'

const router = Router()

router.post('/login', async (req, res) => {
  try {
    const tg = req.telegramUser
    if (!tg?.id) return res.status(401).json({ error: 'No user' })

    // Generate ref code
    const refCode = crypto.randomBytes(4).toString('hex')

    // Upsert user
    const { rows } = await pool.query(
      `INSERT INTO users (telegram_id, username, first_name, last_name, ref_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name
       RETURNING *`,
      [tg.id, tg.username, tg.first_name, tg.last_name, refCode]
    )

    res.json({ user: rows[0] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
