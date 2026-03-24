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
      "SELECT key, value FROM settings WHERE key IN ('min_deposit','min_withdraw','min_reinvest','min_collect','staking_withdraw_fee','task_price','task_reward','task_ref_bonus','task_project_fee')"
    )
    const mins = {}
    const prices = {}
    let stakingWithdrawFee = 0
    rows.forEach(r => {
      if (r.key.startsWith('min_')) mins[r.key.replace('min_', '')] = parseFloat(r.value)
      else if (r.key === 'staking_withdraw_fee') stakingWithdrawFee = parseFloat(r.value)
      else prices[r.key] = parseFloat(r.value)
    })
    res.json({ daily_rate: DAILY_RATE, daily_percent: 1, mins, prices, staking_withdraw_fee: stakingWithdrawFee })
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
      earned: parseFloat(s.earned || 0), // только сохранённое в БД, фронт сам считает тикер
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

    // Реф. бонус за депозит начисляется только при пополнении через TON Connect

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
    const label = req.body?.label || 'Вывод стейка + доход'
    const internal = req.body?.internal || false // внутренняя операция — не начислять баланс

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    const earned = calcEarned(stake.amount, stake.started_at)
    const returnAmount = parseFloat(stake.amount) + earned

    if (!internal) {
      // Реальный вывод — начисляем баланс и пишем в историю
      await client.query('UPDATE users SET balance_ton = balance_ton + $1 WHERE id = $2', [returnAmount, stake.uid])
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'reward', $2, $3)`,
        [stake.uid, returnAmount, label]
      )
    }

    await client.query(`UPDATE stakes SET status = 'completed', earned = $1 WHERE id = $2`, [earned, stakeId])
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

// POST /api/staking/withdraw — частичный вывод из стейка
router.post('/withdraw', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, stakeId } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id=u.id
       WHERE s.id=$1 AND u.telegram_id=$2 AND s.status='active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    const withdrawAmt = parseFloat(amount)
    if (withdrawAmt > parseFloat(stake.amount)) return res.status(400).json({ error: 'Amount exceeds stake' })

    // Сохраняем накопленный доход перед изменением
    const currentEarned = parseFloat(stake.earned || 0) + parseFloat(stake.amount) * 0.01 / (24*60*60*1000) * (Date.now() - new Date(stake.started_at).getTime())
    const newAmount = parseFloat(stake.amount) - withdrawAmt

    // Получаем комиссию за вывод из стейка
    const { rows: [stFee] } = await client.query("SELECT value FROM settings WHERE key='staking_withdraw_fee'")
    const feePercent = parseFloat(stFee?.value || 0) / 100
    const fee = withdrawAmt * feePercent
    const netWithdraw = withdrawAmt - fee
    console.log(`WITHDRAW: amount=${withdrawAmt} fee%=${feePercent} fee=${fee} net=${netWithdraw}`)

    // Начисляем выводимую сумму за вычетом комиссии
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [netWithdraw, stake.uid])

    // Комиссия на аккаунт админа
    if (fee > 0) {
      const { rows: [admin] } = await client.query('SELECT * FROM users WHERE telegram_id=5651190404')
      if (admin) {
        await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [fee, admin.id])
      }
    }

    if (newAmount > 0) {
      // Уменьшаем стейк
      await client.query(
        'UPDATE stakes SET amount=$1, earned=$2, started_at=NOW() WHERE id=$3',
        [newAmount, currentEarned, stakeId]
      )
    } else {
      // Закрываем стейк
      await client.query("UPDATE stakes SET status='completed', earned=$1 WHERE id=$2", [currentEarned, stakeId])
    }

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'reward',$2,$3)`,
      [stake.uid, netWithdraw, fee > 0 ? `Вывод из стейка (комиссия ${(feePercent*100).toFixed(0)}%)` : 'Вывод из стейка']
    )

    await client.query('COMMIT')
    res.json({ ok: true, netWithdraw, fee })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/collect/:stakeId — собрать доход
router.post('/collect/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id=$1 AND u.telegram_id=$2 AND s.status='active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    const earned = parseFloat(stake.earned || 0) + parseFloat(stake.amount) * 0.01 / (24*60*60*1000) * (Date.now() - new Date(stake.started_at).getTime())

    // Начисляем доход на баланс
    await client.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [earned, stake.uid])

    // Сбрасываем earned и started_at, сумма депозита не меняется
    await client.query('UPDATE stakes SET earned=0, started_at=NOW() WHERE id=$1', [stakeId])

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'reward',$2,'Сбор дохода')`,
      [stake.uid, earned]
    )

    await client.query('COMMIT')
    res.json({ ok: true, earned })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/add — добавить к существующему стейку
router.post('/add', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { amount, stakeId } = req.body
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Invalid amount' })

    await client.query('BEGIN')

    const { rows: [user] } = await client.query('SELECT * FROM users WHERE telegram_id=$1', [tgId])
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (parseFloat(user.balance_ton) < parseFloat(amount)) return res.status(400).json({ error: 'Insufficient balance' })

    // Списываем только добавляемую сумму
    await client.query('UPDATE users SET balance_ton=balance_ton-$1 WHERE id=$2', [amount, user.id])

    let stake
    if (stakeId) {
      // Обновляем существующий стейк — увеличиваем сумму
      // Сохраняем накопленный доход и обновляем сумму + время
      const { rows: [existing] } = await client.query('SELECT * FROM stakes WHERE id=$1', [stakeId])
      const currentEarned = existing ? parseFloat(existing.earned || 0) + (parseFloat(existing.amount) * 0.01 / (24*60*60*1000) * (Date.now() - new Date(existing.started_at).getTime())) : 0
      const { rows: [s] } = await client.query(
        `UPDATE stakes SET amount=amount+$1, earned=$2, started_at=NOW() WHERE id=$3 AND user_id=$4 AND status='active' RETURNING *`,
        [amount, currentEarned, stakeId, user.id]
      )
      stake = s
    }

    if (!stake) {
      // Создаём новый
      const { rows: [s] } = await client.query(
        `INSERT INTO stakes (user_id,amount,started_at,status) VALUES ($1,$2,NOW(),'active') RETURNING *`,
        [user.id, amount]
      )
      stake = s
    }

    await client.query(
      `INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'stake',$2,'Пополнение стейка')`,
      [user.id, -parseFloat(amount)]
    )

    await client.query('COMMIT')
    res.json({ stake })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

// POST /api/staking/reinvest/:stakeId
router.post('/reinvest/:stakeId', async (req, res) => {
  const client = await pool.connect()
  try {
    const tgId = req.telegramUser.id
    const { stakeId } = req.params
    const { earned, newAmount } = req.body

    await client.query('BEGIN')

    const { rows: [stake] } = await client.query(
      `SELECT s.*, u.id as uid FROM stakes s JOIN users u ON s.user_id = u.id
       WHERE s.id = $1 AND u.telegram_id = $2 AND s.status = 'active'`,
      [stakeId, tgId]
    )
    if (!stake) return res.status(404).json({ error: 'Stake not found' })

    // Просто обновляем сумму стейка и сбрасываем время — без лишних транзакций
    await client.query(
      `UPDATE stakes SET amount = $1, earned = 0, started_at = NOW() WHERE id = $2`,
      [newAmount, stakeId]
    )

    // Одна запись в историю
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, label) VALUES ($1, 'reinvest', $2, 'Реинвестиция')`,
      [stake.uid, earned]
    )

    await client.query('COMMIT')
    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error(e)
    res.status(500).json({ error: 'Server error' })
  } finally {
    client.release()
  }
})

export default router
