import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// Секторы барабана — берутся из настроек
const DEFAULT_SECTORS = [
  { label: '😢 Ничего', type: 'nothing', value: 0, chance: 35 },
  { label: '🎁 0.01 бонус', type: 'bonus', value: 0.01, chance: 25 },
  { label: '🎁 0.05 бонус', type: 'bonus', value: 0.05, chance: 15 },
  { label: '💎 0.01 TON', type: 'ton', value: 0.01, chance: 12 },
  { label: '🎁 0.1 бонус', type: 'bonus', value: 0.1, chance: 8 },
  { label: '💎 0.05 TON', type: 'ton', value: 0.05, chance: 4 },
  { label: '💎 0.1 TON', type: 'ton', value: 0.1, chance: 1 },
]

// GET /api/spin/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('spin_price', 'spin_enabled')"
    )
    const data = { spin_price: 0.1, spin_enabled: '1', sectors: DEFAULT_SECTORS }
    rows.forEach(r => {
      if (r.key === 'spin_price') data.spin_price = parseFloat(r.value)
      if (r.key === 'spin_enabled') data.spin_enabled = r.value
    })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/spin/play
router.post('/play', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Проверяем настройки
    const { rows: settings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('spin_price', 'spin_enabled')"
    )
    const spinPrice = parseFloat(settings.find(s => s.key === 'spin_price')?.value || 0.1)
    const spinEnabled = settings.find(s => s.key === 'spin_enabled')?.value !== '0'

    if (!spinEnabled) return res.status(400).json({ error: 'Спин временно недоступен' })
    if (parseFloat(user.balance_ton) < spinPrice) {
      return res.status(400).json({ error: `Недостаточно средств. Нужно ${spinPrice} TON` })
    }

    // Списываем стоимость спина
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [spinPrice, user.id])
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'spin',$2,'Спин')",
      [user.id, -spinPrice]
    )

    // Определяем выигрыш
    const rand = Math.random() * 100
    let cumulative = 0
    let result = DEFAULT_SECTORS[0]
    for (const sector of DEFAULT_SECTORS) {
      cumulative += sector.chance
      if (rand <= cumulative) { result = sector; break }
    }

    // Начисляем приз
    if (result.type === 'ton' && result.value > 0) {
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [result.value, user.id])
      await client.query(
        "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'reward',$2,$3)",
        [user.id, result.value, `Выигрыш спина: ${result.label}`]
      )
    } else if (result.type === 'bonus' && result.value > 0) {
      await client.query('UPDATE users SET bonus_balance=bonus_balance+$1 WHERE id=$2', [result.value, user.id])
      await client.query(
        "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'bonus',$2,$3)",
        [user.id, result.value, `Бонус спина: ${result.label}`]
      )
    }

    // Комиссия проекту
    const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
    if (admin) {
      const fee = spinPrice - (result.type !== 'nothing' ? result.value : 0)
      if (fee > 0) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [fee, admin.id])
      }
    }

    await client.query('COMMIT')
    res.json({ ok: true, result, sectorIndex: DEFAULT_SECTORS.indexOf(result) })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router
