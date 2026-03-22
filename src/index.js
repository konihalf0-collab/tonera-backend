import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { telegramAuth } from './middleware/telegramAuth.js'
import { runMigrations } from './db/migrations.js'
import { startCronJobs } from './cron/stakingRewards.js'
import authRoutes     from './routes/auth.js'
import stakingRoutes  from './routes/staking.js'
import tasksRoutes    from './routes/tasks.js'
import referralRoutes from './routes/referrals.js'
import walletRoutes   from './routes/wallet.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors({ origin: '*' }))
app.use(express.json())

// Health check
app.get('/health', (_, res) => res.json({ ok: true }))

// Auth middleware on all /api routes
app.use('/api', telegramAuth)

// Routes
app.use('/api/auth',     authRoutes)
app.use('/api/staking',  stakingRoutes)
app.use('/api/tasks',    tasksRoutes)
app.use('/api/referrals', referralRoutes)
app.use('/api/wallet',   walletRoutes)
app.use('/api/user',     walletRoutes) // /api/user/me reused from wallet

// Start
async function bootstrap() {
  await runMigrations()
  startCronJobs()
  app.listen(PORT, () => console.log(`🚀 Tonera backend on port ${PORT}`))
}

bootstrap().catch(console.error)