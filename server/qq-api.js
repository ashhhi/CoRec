let accessToken = ''
let tokenExpires = 0
let tokenPromise = null

export function qqConfigured() {
  return Boolean(process.env.QQ_BOT_APP_ID?.trim() && process.env.QQ_BOT_CLIENT_SECRET?.trim())
}

export async function qqToken() {
  if (!qqConfigured()) throw new Error('QQ 机器人尚未配置，无法发送提醒。')
  if (accessToken && Date.now() < tokenExpires - 60000) return accessToken
  if (!tokenPromise) tokenPromise = (async () => {
    const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: process.env.QQ_BOT_APP_ID.trim(), clientSecret: process.env.QQ_BOT_CLIENT_SECRET.trim() }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await response.json()
    if (!response.ok || !data.access_token) throw new Error(`QQ access token request failed (${response.status}): ${data.message || data.code || 'unknown error'}`)
    accessToken = data.access_token
    tokenExpires = Date.now() + Number(data.expires_in || 3600) * 1000
    return accessToken
  })().finally(() => { tokenPromise = null })
  return tokenPromise
}

export async function qqRequest(path, options = {}) {
  const token = await qqToken()
  const response = await fetch(`https://api.bot.qq.com${path}`, {
    ...options, headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`QQ API request failed (${response.status}): ${data.message || data.code || 'unknown error'}`)
  return data
}

export async function sendTaskNotification(task, content) {
  const target = task.target === 'group' ? 'groups' : 'users'
  // Scheduled messages are proactive: a previous user message ID must never be reused.
  const result = await qqRequest(`/v2/${target}/${encodeURIComponent(task.target_openid)}/messages`, {
    method: 'POST', body: JSON.stringify({ msg_type: 0, content: content.slice(0, 1900) }),
  })
  if (typeof result.id !== 'string' || !result.id) throw new Error(`QQ 未确认发送成功：${result.message || result.code || '缺少消息编号'}`)
  return result
}
