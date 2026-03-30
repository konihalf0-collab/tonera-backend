import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/trading/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_multiplier','trading_bank','trading_profit_fee','trading_commission')"
    )
    const d = { trading_enabled:'1', trading_multiplier:'90', trading_bank:'0', trading_profit_fee:'10', trading_commission:'5' }
    rows.forEach(r => { d[r.key] = r.value })
    res.json(d)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// POST /api/trading/result
router.post('/result', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, won } = req.body
    if (!amount) return res.status(400).json({ error: 'Invalid params' })

    const betAmount = parseFloat(amount)
    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { rows: settings } = await client.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_multiplier','trading_bank','trading_profit_fee','trading_commission')"
    )
    const pct = parseFloat(settings.find(s => s.key === 'trading_multiplier')?.value || 90)
    const multiplier = pct > 10 ? 1 + pct / 100 : pct
    const profitFeePct = parseFloat(settings.find(s => s.key === 'trading_profit_fee')?.value || 10) / 100
    const commissionPct = parseFloat(settings.find(s => s.key === 'trading_commission')?.value || 5) / 100

    // Списываем ставку
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [betAmount, user.id])

    // Комиссия с каждой ставки
    const commission = betAmount * commissionPct
    const betNet = betAmount - commission // ставка после комиссии

    // Комиссия делится: % прибыли — тебе, остаток — в банк
    const commissionProfit = commission * profitFeePct
    const commissionToBank = commission - commissionProfit

    const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])

    // Комиссия в банк
    await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='trading_bank'", [commissionToBank])
    // Прибыль с комиссии — тебе
    if (admin && commissionProfit > 0) {
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [commissionProfit, admin.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading_profit',$2,'Комиссия трейдинг')", [admin.id, commissionProfit])
    }

    let profit = 0

    if (won === null) {
      // Возврат — возвращаем betNet (без комиссии)
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betNet, user.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, betNet, `🔄 refund:${betNet.toFixed(4)}`])
      profit = betNet
    } else if (won) {
      // Выигрыш — выплата из банка
      profit = betAmount * multiplier
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [profit, user.id])
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='trading_bank'", [profit])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, profit, `📈 win:${profit.toFixed(4)}:bet:${betAmount.toFixed(4)}`])

      // Проверяем банк
      const { rows: [bankRow] } = await client.query("SELECT value FROM settings WHERE key='trading_bank'")
      if (parseFloat(bankRow?.value || 0) <= 0) {
        await client.query("UPDATE settings SET value='0' WHERE key='trading_enabled'")
        try {
          const { getBot } = await import('../bot.js')
          const bot = getBot()
          if (bot) await bot.sendMessage(ADMIN_TG_ID,
            `⚠️ *БАНК ТРЕЙДИНГА ПУСТОЙ*\n\nТрейдинг автоматически отключён.\nПополните банк и включите вручную в настройках.`,
            { parse_mode: 'Markdown' }
          )
        } catch {}
      }
    } else {
      // Проигрыш — betNet идёт в банк
      await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='trading_bank'", [betNet])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, -betAmount, `📉 lose:${betAmount.toFixed(4)}`])
    }

    await client.query('COMMIT')
    res.json({ ok: true, won, profit })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally { client.release() }
})

// GET /api/trading/history
router.get('/history', async (req, res) => {
  try {
    const tgId = req.telegramUser.id
    const { rows } = await pool.query(
      `SELECT t.* FROM transactions t JOIN users u ON t.user_id=u.id
       WHERE u.telegram_id=$1 AND t.type='trading'
       ORDER BY t.created_at DESC LIMIT 20`,
      [tgId]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
