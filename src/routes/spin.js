import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

const DEFAULT_SECTORS = [
  { label: '😢 Ничего',    type: 'nothing', value: 0,    chance: 35 },
  { label: '💎 0.01 TON',  type: 'ton',     value: 0.01, chance: 25 },
  { label: '💎 0.05 TON',  type: 'ton',     value: 0.05, chance: 20 },
  { label: '💎 0.1 TON',   type: 'ton',     value: 0.1,  chance: 12 },
  { label: '💎 0.5 TON',   type: 'ton',     value: 0.5,  chance: 5  },
  { label: '💎 1 TON',     type: 'ton',     value: 1,    chance: 2  },
  { label: '🎰 ДЖЕКПОТ',   type: 'jackpot', value: 0,    chance: 1  },
]

async function getSectors(client) {
  const { rows: [r] } = await client.query("SELECT value FROM settings WHERE key='spin_sectors'")
  try { return JSON.parse(r?.value || '[]') || DEFAULT_SECTORS } catch { return DEFAULT_SECTORS }
}

// GET /api/spin/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('spin_price','spin_enabled','spin_jackpot','spin_jackpot_fee','spin_sectors','spin_pool')"
    )
    const data = { spin_price: 0.1, spin_enabled: '1', spin_jackpot: 0, spin_jackpot_fee: 10, sectors: DEFAULT_SECTORS }
    rows.forEach(r => {
      if (r.key === 'spin_price') data.spin_price = parseFloat(r.value)
      if (r.key === 'spin_enabled') data.spin_enabled = r.value
      if (r.key === 'spin_jackpot') data.spin_jackpot = parseFloat(r.value || 0)
      if (r.key === 'spin_jackpot_fee') data.spin_jackpot_fee = parseFloat(r.value || 10)
      if (r.key === 'spin_sectors') { try { data.sectors = JSON.parse(r.value) } catch {} }
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

    const { rows: settings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('spin_price','spin_enabled','spin_jackpot','spin_jackpot_fee','spin_sectors','spin_pool')"
    )
    const spinPrice = parseFloat(settings.find(s => s.key === 'spin_price')?.value || 0.1)
    const spinEnabled = settings.find(s => s.key === 'spin_enabled')?.value !== '0'
    const jackpot = parseFloat(settings.find(s => s.key === 'spin_jackpot')?.value || 0)
    const spinPool = parseFloat(settings.find(s => s.key === 'spin_pool')?.value || 0)
    const jackpotFeePercent = parseFloat(settings.find(s => s.key === 'spin_jackpot_fee')?.value || 10) / 100

    const spinBank = parseFloat(settings.find(s => s.key === 'spin_bank')?.value || 0)
    if (!spinEnabled) return res.status(400).json({ error: 'Спин временно недоступен' })
    if (parseFloat(user.balance_ton) < spinPrice) {
      return res.status(400).json({ error: `Недостаточно средств. Нужно ${spinPrice} TON` })
    }

    let sectors = DEFAULT_SECTORS
    try { sectors = JSON.parse(settings.find(s => s.key === 'spin_sectors')?.value || '[]') || DEFAULT_SECTORS } catch {}

    // Списываем стоимость
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [spinPrice, user.id])
    // Пополняем банк спинов
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='spin_bank'", [spinPrice])

    // Весь spinPrice идёт в пул, из пула % в джекпот
    const jackpotFee = spinPrice * jackpotFeePercent
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='spin_pool'", [spinPrice - jackpotFee])
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='spin_jackpot'", [jackpotFee])

    // Определяем выигрыш — пул после пополнения
    const currentPool = spinPool + (spinPrice - jackpotFee)
    const rand = Math.random() * 100
    let cumulative = 0
    let result = sectors[0]
    let sectorIndex = 0
    for (let i = 0; i < sectors.length; i++) {
      cumulative += sectors[i].chance
      if (rand <= cumulative) { result = sectors[i]; sectorIndex = i; break }
    }
    // Если приз больше пула — не выплачиваем (крутим на сектор но засчитываем как ничего)
    if (result.type === 'ton' && result.value > currentPool) {
      result = { ...result, type: 'nothing', _blocked: true }
    }

    // Начисляем приз и пишем одну запись в историю
    if (result.type === 'jackpot') {
      const prize = jackpot + jackpotFee
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [prize, user.id])
      await client.query("UPDATE settings SET value='0' WHERE key='spin_jackpot'")
      await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)-$1 AS TEXT) WHERE key='spin_bank'", [prize])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'spin_result',$2,$3)", [user.id, prize - spinPrice, `🎰 Спин: ДЖЕКПОТ +${prize.toFixed(4)} TON (ставка -${spinPrice} TON)`])
      result = { ...result, value: prize }
      // Уведомление админу
      try {
        const { getBot } = await import('../bot.js')
        const bot = getBot()
        if (bot) await bot.sendMessage(ADMIN_TG_ID,
          `🎰 *ДЖЕКПОТ!*\n\n👤 ${user.username ? '@'+user.username : user.first_name}\n💰 Сумма: *${prize.toFixed(4)} TON*`,
          { parse_mode: 'Markdown' }
        )
      } catch {}
    } else if (result.type === 'ton' && result.value > 0) {
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [result.value, user.id])
      // Вычитаем приз из пула — пул уменьшается на приз, остаток остаётся в пуле
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='spin_pool'", [result.value])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'spin_result',$2,$3)", [user.id, result.value - spinPrice, `🎰 Спин: +${result.value} TON (ставка -${spinPrice} TON)`])
    } else {
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'spin_result',$2,$3)", [user.id, -spinPrice, `🎰 Спин: Ничего (ставка -${spinPrice} TON)`])
    }

    await client.query('COMMIT')
    res.json({ ok: true, result, sectorIndex })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router

// GET /api/spin/history — последние 20 выигрышей
router.get('/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.amount, t.label, t.created_at, t.type, u.username, u.first_name
       FROM transactions t JOIN users u ON t.user_id=u.id
       WHERE t.type='spin_result'
       ORDER BY t.created_at DESC LIMIT 20`
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})