import { Router } from 'express'
import pool from '../db/index.js'

const router = Router()

// GET /api/deposit/info — адрес кошелька проекта
router.get('/info', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM settings WHERE key IN ('project_wallet','min_deposit_ton')"
    )
    const data = {}
    rows.forEach(r => {
      if (r.key === 'project_wallet') data.wallet = r.value || process.env.PROJECT_WALLET || ''
      if (r.key === 'min_deposit_ton') data.min_amount = parseFloat(r.value || 0.5)
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
      [user.id, depositAmount, tx_hash ? `tx:${tx_hash}` : 'Пополнение через TON']
    )

    await client.query('COMMIT')
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
    if (parseFloat(user.balance_ton) < withdrawAmount) {
      return res.status(400).json({ error: 'Insufficient balance' })
    }

    // Списываем баланс
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [withdrawAmount, user.id])

    // Сохраняем адрес кошелька
    await client.query('UPDATE users SET ton_address=$1 WHERE id=$2', [wallet_address, user.id])

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label,status) VALUES ($1,'withdraw',$2,$3,'pending')`,
      [user.id, -withdrawAmount, `Вывод на ${wallet_address.slice(0,8)}...`]
    )

    await client.query('COMMIT')
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
