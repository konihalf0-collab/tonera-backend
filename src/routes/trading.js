import { Router } from 'express'
import pool from '../db/index.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/trading/info
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('trading_enabled','trading_multiplier','trading_bank','trading_profit_fee')"
    )
    const d = { trading_enabled:'1', trading_multiplier:'90', trading_bank:'0', trading_profit_fee:'10' }
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
      "SELECT key, value FROM settings WHERE key IN ('trading_multiplier','trading_bank','trading_profit_fee')"
    )
    const pct = parseFloat(settings.find(s => s.key === 'trading_multiplier')?.value || 90)
    const multiplier = pct > 10 ? 1 + pct / 100 : pct
    const bank = parseFloat(settings.find(s => s.key === 'trading_bank')?.value || 0)
    const profitFeePct = parseFloat(settings.find(s => s.key === 'trading_profit_fee')?.value || 10) / 100

    // Списываем ставку
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [betAmount, user.id])

    let profit = 0

    if (won === null) {
      // Возврат — банк не меняется
      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [betAmount, user.id])
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, betAmount, `🔄 refund:${betAmount.toFixed(4)}`])
      profit = betAmount
    } else if (won) {
      // Выигрыш — выплачиваем из банка
      profit = betAmount * multiplier
      const profitOnly = profit - betAmount
      // Процент прибыли проекту
      const projectCut = profitOnly * profitFeePct
      const userPayout = profit - projectCut

      await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [userPayout, user.id])
      // Уменьшаем банк на выплату
      await client.query("UPDATE settings SET value=CAST(GREATEST(CAST(value AS DECIMAL)-$1,0) AS TEXT) WHERE key='trading_bank'", [profitOnly])
      // Прибыль проекту
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin && projectCut > 0) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [projectCut, admin.id])
        await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading_profit',$2,'Прибыль трейдинг')", [admin.id, projectCut])
      }
      await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading',$2,$3)",
        [user.id, userPayout, `📈 win:${userPayout.toFixed(4)}:bet:${betAmount.toFixed(4)}`])

      // Проверяем банк — если стал 0, отключаем трейдинг и уведомляем
      const { rows: [bankRow] } = await client.query("SELECT value FROM settings WHERE key='trading_bank'")
      const newBank = parseFloat(bankRow?.value || 0)
      if (newBank <= 0) {
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
      // Проигрыш — пополняем банк
      const profitFee = betAmount * profitFeePct
      const toBank = betAmount - profitFee
      await client.query("UPDATE settings SET value=CAST(CAST(value AS DECIMAL)+$1 AS TEXT) WHERE key='trading_bank'", [toBank])
      // Прибыль проекту сразу
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [ADMIN_TG_ID])
      if (admin && profitFee > 0) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [profitFee, admin.id])
        await client.query("INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'trading_profit',$2,'Прибыль трейдинг')", [admin.id, profitFee])
      }
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
