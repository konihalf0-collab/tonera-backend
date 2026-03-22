import crypto from 'crypto'

export function telegramAuth(req, res, next) {
  // Skip in dev if no init data
  if (process.env.NODE_ENV !== 'production') {
    const initData = req.headers['x-telegram-init-data']
    if (!initData) {
      // Dev fallback: inject mock user
      req.telegramUser = {
        id: 123456789,
        username: 'devuser',
        first_name: 'Dev',
        last_name: 'User',
      }
      return next()
    }
  }

  const initData = req.headers['x-telegram-init-data']
  if (!initData) return res.status(401).json({ error: 'No init data' })

  try {
    const params = new URLSearchParams(initData)
    const hash = params.get('hash')
    params.delete('hash')

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest()

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex')

    if (expectedHash !== hash) {
      return res.status(401).json({ error: 'Invalid hash' })
    }

    const userParam = params.get('user')
    if (userParam) {
      req.telegramUser = JSON.parse(userParam)
    }

    next()
  } catch (e) {
    res.status(401).json({ error: 'Auth failed' })
  }
}
