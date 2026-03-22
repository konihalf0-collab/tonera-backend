import { Router } from 'express'
import { getBot } from '../bot.js'

const router = Router()

// GET /api/channels/info?link=https://t.me/username
// Автозагрузка данных канала/бота
router.get('/info', async (req, res) => {
  try {
    const { link } = req.query
    if (!link) return res.status(400).json({ error: 'link required' })

    const bot = getBot()
    if (!bot) return res.status(500).json({ error: 'Bot not initialized' })

    // Извлекаем username из ссылки
    const match = link.match(/t\.me\/([^/?]+)/)
    if (!match) return res.status(400).json({ error: 'Invalid telegram link' })

    const username = match[1]

    try {
      const chat = await bot.getChat('@' + username)
      res.json({
        id: chat.id,
        title: chat.title || chat.first_name || username,
        description: chat.description || chat.bio || '',
        username: chat.username || username,
        type: chat.type,
        photo: chat.photo ? `https://t.me/i/userpic/320/${username}.jpg` : null,
      })
    } catch (e) {
      // Если бот не в канале — возвращаем базовую инфу
      res.json({
        title: username,
        description: '',
        username: username,
        photo: `https://t.me/i/userpic/320/${username}.jpg`,
      })
    }
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
