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
  // Обработка inline кнопок одобрения/отклонения заданий
  bot.on('callback_query', async (query) => {
    const data = query.data
    try {
      if (data.startsWith('approve_task:')) {
        const taskId = data.split(':')[1]
        await pool.query('UPDATE tasks SET active=true WHERE id=$1', [taskId])
        await bot.answerCallbackQuery(query.id, { text: '✅ Задание одобрено' })
        await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ ОДОБРЕНО', callback_data: 'done' }]] }, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        })
        // Уведомить заказчика
        const { rows: [task] } = await pool.query('SELECT t.*, u.telegram_id FROM tasks t JOIN users u ON t.creator_id=u.id WHERE t.id=$1', [taskId])
        if (task) {
          await bot.sendMessage(task.telegram_id, `✅ Ваше задание *${task.title}* одобрено и теперь активно!`, { parse_mode: 'Markdown' })
        }
      } else if (data.startsWith('reject_task:')) {
        const taskId = data.split(':')[1]
        // Возвращаем бюджет и удаляем задание
        const { rows: [task] } = await pool.query('SELECT t.*, u.id as uid, u.telegram_id FROM tasks t JOIN users u ON t.creator_id=u.id WHERE t.id=$1', [taskId])
        if (task) {
          await pool.query('UPDATE users SET balance_ton=balance_ton+$1 WHERE id=$2', [task.budget, task.uid])
          await pool.query('DELETE FROM tasks WHERE id=$1', [taskId])
          await bot.sendMessage(task.telegram_id, `❌ Ваше задание *${task.title}* отклонено. Бюджет ${parseFloat(task.budget).toFixed(4)} TON возвращён.`, { parse_mode: 'Markdown' })
        }
        await bot.answerCallbackQuery(query.id, { text: '❌ Задание отклонено' })
        await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ ОТКЛОНЕНО', callback_data: 'done' }]] }, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        })
      } else {
        await bot.answerCallbackQuery(query.id)
      }
    } catch (e) {
      console.error('Callback error:', e.message)
      await bot.answerCallbackQuery(query.id, { text: 'Ошибка' })
    }
  })

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
