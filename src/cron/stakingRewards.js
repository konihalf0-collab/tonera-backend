import cron from 'node-cron'
import pool from '../db/index.js'

// Runs every hour — accrues staking rewards
export function startCronJobs() {
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Accruing staking rewards...')
    try {
      // Get all active stakes
      const { rows: stakes } = await pool.query(
        `SELECT s.*, p.apy
         FROM stakes s
         JOIN staking_pools p ON s.pool_id = p.id
         WHERE s.status = 'active'`
      )

      for (const stake of stakes) {
        // Hourly reward = (amount * apy%) / (365 * 24)
        const hourlyReward = (parseFloat(stake.amount) * parseFloat(stake.apy) / 100) / (365 * 24)

        await pool.query(
          'UPDATE stakes SET earned = earned + $1 WHERE id = $2',
          [hourlyReward, stake.id]
        )
      }

      console.log(`✅ Accrued rewards for ${stakes.length} stakes`)
    } catch (e) {
      console.error('Cron error:', e)
    }
  })

  console.log('⏰ Cron jobs started')
}
