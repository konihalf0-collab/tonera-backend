import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/trading/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_timer','trading_multiplier','trading_min_bet','trading_win_chance')"
    )
    const d = { trading_enabled:'1', trading_timer:30, trading_multiplier:1.9, trading_min_bet:0.01, trading_win_chance:50 }
    rows.forEach(r => { d[r.key] = r.value })
    res.json(d)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/trading/bet — сделать ставку
router.post('/bet', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, direction } = req.body // direction: 'up' | 'down'
    if (!amount || !['up','down'].includes(direction)) return res.status(400).json({ error: 'Invalid params' })

    const { rows: settings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_multiplier','trading_win_chance','trading_min_bet')"
    )
    const enabled = settings.find(s => s.key === 'trading_enabled')?.value !== '0'
    const multiplier = parseFloat(settings.find(s => s.key === 'trading_multiplier')?.value || 1.9)
    const winChance = parseFloat(settings.find(s => s.key === 'trading_win_chance')?.value || 50)
    const minBet = parseFloat(settings.find(s => s.key === 'trading_min_bet')?.value || 0.01)

    if (!enabled) return res.status(400).json({ error: 'Трейдинг временно недоступен' })
    if (parseFloat(amount) < minBet) return res.status(400).json({ error: `Мин. ставка: ${minBet} TON` })

    await client.query('BEGIN')
    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (parseFloat(user.balance_ton) < parseFloat(amount)) return res.status(400).json({ error: 'Недостаточно средств' })

    // Случайный результат
    const rand = Math.random() * 100
    const win = rand <= winChance
    const finalPrice = win ? (direction === 'up' ? 1 : -1) : (direction === 'up' ? -1 : 1)
    // finalPrice > 0 означает рост, < 0 — падение
    const userWon = (direction === 'up' && finalPrice > 0) || (direction === 'down' && finalPrice < 0)

    const betAmount = parseFloat(amount)
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [betAmount, user.id])

    let profit = 0
    if (userWon) {
      profit = betAmount * multiplier
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [profit, user.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, profit - betAmount, `📈 Трейдинг: +${(profit-betAmount).toFixed(4)} TON`])
    } else {
      // Комиссия проекту
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin) await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betAmount, admin.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, -betAmount, `📉 Трейдинг: -${betAmount.toFixed(4)} TON`])
    }

    await client.query('COMMIT')

    // Генерируем свечной график для анимации
    const candles = generateCandles(20, finalPrice > 0)

    res.json({ ok: true, won: userWon, profit, finalPrice, candles, multiplier })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

function generateCandles(count, goingUp) {
  const candles = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const trend = goingUp ? 0.6 : 0.4
    const isGreen = Math.random() < (i < count - 3 ? 0.5 : trend)
    const change = (Math.random() * 3 + 0.5) * (isGreen ? 1 : -1)
    const open = price
    const close = price + change
    const high = Math.max(open, close) + Math.random() * 1.5
    const low = Math.min(open, close) - Math.random() * 1.5
    candles.push({ open, close, high, low, isGreen: close > open })
    price = close
  }
  return candles
}

export default router
