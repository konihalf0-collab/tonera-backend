import TelegramBot from 'node-telegram-bot-api'
import pool from './db/index.js'
import crypto from 'crypto'
import { APP_URL, WEBHOOK_URL, BOT_USERNAME } from './config.js'

let bot = null

export function initBot() {
  const token = process.env.BOT_TOKEN
  if (!token) { console.log('⚠️ BOT_TOKEN not set'); return null }
  bot = new TelegramBot(token)
  if (WEBHOOK_URL) {
    bot.setWebHook(`${WEBHOOK_URL}/bot/webhook`)
    console.log(`🤖 Bot webhook: ${WEBHOOK_URL}/bot/webhook`)
  }
  return bot
}

export function getBot() { return bot }
export function processUpdate(update) { if (bot) bot.processUpdate(update) }

export function setupBotHandlers(bot) {
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const tgId = msg.from.id
    const startParam = match[1]?.trim()
    try {
      const refCode = crypto.randomBytes(4).toString('hex')
      const { rows: [user] } = await pool.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, ref_code)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (telegram_id) DO UPDATE SET
           username=EXCLUDED.username, first_name=EXCLUDED.first_name
         RETURNING *`,
        [tgId, msg.from.username, msg.from.first_name, msg.from.last_name, refCode]
      )

      if (startParam && startParam !== user.ref_code) {
        const { rows: [referrer] } = await pool.query('SELECT * FROM users WHERE ref_code=$1', [startParam])
        if (referrer && referrer.telegram_id !== tgId) {
          const { rows: [existing] } = await pool.query('SELECT id FROM referrals WHERE referred_id=$1', [user.id])
          if (!existing) {
            await pool.query('INSERT INTO referrals (referrer_id,referred_id) VALUES ($1,$2)', [referrer.id, user.id])
            await pool.query('UPDATE users SET referred_by=$1, referral_count=referral_count+1 WHERE id=$2', [referrer.telegram_id, user.id])
            const { rows: [s] } = await pool.query("SELECT value FROM settings WHERE key='ref_register_bonus'")
            const bonus = parseFloat(s?.value || 0.5)
            if (bonus > 0) {
              await pool.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [bonus, referrer.id])
              await pool.query(`INSERT INTO transactions (user_id,type,amount,label) VALUES ($1,'reward',$2,'Реф. бонус за регистрацию')`, [referrer.id, bonus])
            }
          }
        }
      }

      await bot.sendMessage(tgId,
        `👋 Привет, ${msg.from.first_name}!\n\n💎 Добро пожаловать в *TonEra*\n\nЗарабатывай TON через стейкинг и задания!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: APP_URL } }]]
          }
        }
      )
    } catch (e) { console.error('Bot /start error:', e) }
  })
}
