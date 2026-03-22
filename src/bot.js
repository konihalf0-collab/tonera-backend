import TelegramBot from 'node-telegram-bot-api'
import pool from './db/index.js'
import crypto from 'crypto'
import { APP_URL, WEBHOOK_URL } from './config.js'

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

      // Регистрируем юзера и сохраняем pending_ref если есть реф код
      await pool.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, ref_code, pending_ref)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (telegram_id) DO UPDATE SET
           username   = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           pending_ref = CASE
             WHEN users.referred_by IS NULL AND $6 IS NOT NULL AND $6 != users.ref_code
             THEN $6
             ELSE users.pending_ref
           END`,
        [tgId, msg.from.username, msg.from.first_name, msg.from.last_name, refCode, startParam || null]
      )

      await bot.sendMessage(tgId,
        `👋 Привет, ${msg.from.first_name}!\n\n💎 Добро пожаловать в *TonEra*\n\nЗарабатывай TON через стейкинг и задания!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🚀 Открыть приложение', web_app: { url: APP_URL } }
            ]]
          }
        }
      )
    } catch (e) {
      console.error('Bot /start error:', e)
    }
  })
}
