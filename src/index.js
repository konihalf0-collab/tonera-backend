import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { telegramAuth } from './middleware/telegramAuth.js'
import { runMigrations } from './db/migrations.js'
import { startCronJobs } from './cron/stakingRewards.js'
import { initBot, setupBotHandlers, processUpdate } from './bot.js'
import pool from './db/index.js'
import authRoutes     from './routes/auth.js'
import stakingRoutes  from './routes/staking.js'
import tasksRoutes    from './routes/tasks.js'
import referralRoutes from './routes/referrals.js'
import walletRoutes   from './routes/wallet.js'
import adminRoutes    from './routes/admin.js'
import channelsRoutes from './routes/channels.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors({ origin: '*' }))
app.use(express.json())

app.get('/health', (_, res) => res.json({ ok: true }))

// Bot webhook
app.post('/bot/webhook', (req, res) => {
  processUpdate(req.body)
  res.sendStatus(200)
})

// Admin reset tasks
app.get('/admin/reset-tasks', async (req, res) => {
  try {
    await pool.query('DELETE FROM user_tasks')
    await pool.query('DELETE FROM tasks')
    await pool.query(`
      INSERT INTO tasks (type, title, reward, icon, link, active) VALUES
        ('subscribe', 'Подписаться на канал', 0.5, '✈️', 'https://t.me/tonera_official', true),
        ('bot',       'Открыть бота',         0.3, '🤖', 'https://t.me/ToneraBot',       true)
    `)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.use('/api', telegramAuth)
app.use('/api/auth',      authRoutes)
app.use('/api/staking',   stakingRoutes)
app.use('/api/tasks',     tasksRoutes)
app.use('/api/referrals', referralRoutes)
app.use('/api/wallet',    walletRoutes)
app.use('/api/user',      walletRoutes)
app.use('/api/admin',     adminRoutes)
app.use('/api/channels',  channelsRoutes)

async function bootstrap() {
  await runMigrations()
  startCronJobs()

  // Init bot
  const bot = initBot()
  if (bot) setupBotHandlers(bot)

  app.listen(PORT, () => console.log(`🚀 Tonera backend on port ${PORT}`))
}

bootstrap().catch(console.error)
