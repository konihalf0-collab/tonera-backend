import { Router } from 'express'
import pool from '../db/index.js'
import { getBot } from '../bot.js'
import { ADMIN_TG_ID } from '../config.js'

const router = Router()

// GET /api/deposit/info — адрес кошелька проекта
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM settings WHERE key IN ('project_wallet','min_deposit_ton','withdraw_fee','min_withdraw_ton')"
    )
    const data = {}
    rows.forEach(r => {
      if (r.key === 'project_wallet') data.wallet = r.value || process.env.PROJECT_WALLET || ''
      if (r.key === 'min_deposit_ton') data.min_amount = parseFloat(r.value || 0.5)
      if (r.key === 'withdraw_fee') data.withdraw_fee = parseFloat(r.value || 0)
      if (r.key === 'min_withdraw_ton') data.min_withdraw = parseFloat(r.value || 1)
    })
    // Fallback to env
    if (!data.wallet) data.wallet = process.env.PROJECT_WALLET || ''
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/deposit/confirm — подтвердить депозит (после транзакции)
// Юзер отправляет hash транзакции, бэкенд проверяет через TON API
router.post('/confirm', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, tx_hash } = req.body

    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    // Проверяем что этот hash не использовался раньше
    if (tx_hash) {
      const { rows: [existing] } = await client.query(
        "SELECT id FROM transactions WHERE label=$1", [`tx:${tx_hash}`]
      )
      if (existing) return res.status(400).json({ error: 'Transaction already used' })
    }

    const depositAmount = parseFloat(amount)

    // Начисляем баланс
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [depositAmount, user.id])

    // Реф бонус за депозит
    if (user.referred_by) {
      const { rows: [setting] } = await client.query("SELECT value FROM settings WHERE key='ref_deposit_percent'")
      const percent = parseFloat(setting?.value || 5) / 100
      const refBonus = depositAmount * percent
      if (refBonus > 0) {
        const { rows: [referrer] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [user.referred_by])
        if (referrer) {
          await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [refBonus, referrer.id])
          await client.query(
            `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'ref_deposit',$2,$3)`,
            [referrer.id, refBonus, `Реф. бонус за депозит (${user.username || user.first_name})`]
          )
        }
      }
    }

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'deposit',$2,$3)`,
      [user.id, depositAmount, 'Пополнение через TON']
    )

    await client.query('COMMIT')

    // Уведомление админу о пополнении
    try {
      const bot = getBot()
      if (bot) {
        await bot.sendMessage(ADMIN_TG_ID,
          `⬇️ *Пополнение баланса*\n\n` +
          `👤 ${user.username ? '@' + user.username : user.first_name}\n` +
          `💰 Сумма: *${depositAmount} TON*`,
          { parse_mode: 'Markdown' }
        )
      }
    } catch (e) { console.error('Notify error:', e.message) }

    res.json({ ok: true, amount: depositAmount })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

// POST /api/deposit/withdraw — запрос на вывод
router.post('/withdraw', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, wallet_address } = req.body

    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })
    if (!wallet_address) return res.status(400).json({ error: 'Wallet address required' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })

    const withdrawAmount = parseFloat(amount)

    // Проверяем минимальный вывод
    const { rows: [minW] } = await client.query("SELECT value FROM settings WHERE key='min_withdraw_ton'")
    const minWithdraw = parseFloat(minW?.value || 1)
    if (withdrawAmount < minWithdraw) {
      return res.status(400).json({ error: `Минимальный вывод: ${minWithdraw} TON` })
    }

    // Получаем комиссию — вычитается из суммы вывода
    const { rows: [feeSetting] } = await client.query("SELECT value FROM settings WHERE key='withdraw_fee'")
    const fee = parseFloat(feeSetting?.value || 0)
    const netAmount = withdrawAmount - fee  // сумма к выплате после вычета комиссии
    const totalDeduct = withdrawAmount      // с баланса списываем только запрошенную сумму

    if (netAmount <= 0) {
      return res.status(400).json({ error: `Сумма меньше комиссии (${fee} TON)` })
    }

    if (parseFloat(user.balance_ton) < totalDeduct) {
      return res.status(400).json({ error: `Недостаточно средств` })
    }

    // Списываем с баланса
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [totalDeduct, user.id])

    // Комиссия на аккаунт админа
    if (fee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [5651190404])
      if (admin) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [fee, admin.id])
        await client.query(
          "INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'fee',$2,'Комиссия за вывод')",
          [admin.id, fee]
        )
      }
    }

    // Сохраняем адрес кошелька
    await client.query('UPDATE users SET ton_address=$1 WHERE id=$2', [wallet_address, user.id])

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'withdraw',$2,$3,'pending')`,
      [user.id, -totalDeduct, `Вывод на ${wallet_address}|net:${netAmount}`]
    )

    await client.query('COMMIT')

    // Уведомление админу в Telegram
    try {
      const bot = getBot()
      if (bot) {
        await bot.sendMessage(ADMIN_TG_ID,
          `💸 *Новая заявка на вывод*\n\n` +
          `👤 ${user.username ? '@' + user.username : user.first_name}\n` +
          `💰 К выплате: *${withdrawAmount} TON*\n` +
          `🏦 Комиссия: *${fee} TON*\n` +
          `📬 Адрес: \`${wallet_address}\`\n\n` +
          `Открой админку → Заявки`,
          { parse_mode: 'Markdown' }
        )
      }
    } catch (e) { console.error('Notify error:', e.message) }

    res.json({ ok: true, message: 'Заявка на вывод создана. Обработка до 24 часов.' })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router
