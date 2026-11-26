import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import mysql from 'mysql2/promise'
import { confirmGroupBinding, getGroupBinding, qqOpenidPattern, requestGroupBinding } from './qq-group.js'

const appId = process.env.QQ_BOT_APP_ID?.trim()
const secret = process.env.QQ_BOT_CLIENT_SECRET?.trim()
const internalToken = process.env.QQ_BOT_INTERNAL_TOKEN || ''
const apiUrl = (process.env.COREC_API_URL || 'http://api:3001').replace(/\/$/, '')
if (!appId || !secret || internalToken.length < 32) throw new Error('Set QQ_BOT_APP_ID, QQ_BOT_CLIENT_SECRET and a QQ_BOT_INTERNAL_TOKEN of at least 32 characters.')

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  connectionLimit: 5, dateStrings: true,
})
const categories = ['餐饮', '交通', '娱乐', '购物', '居住', '其他']
const incomeCategories = ['工资', '奖金', '退款', '其他收入']
const hash = (value) => createHash('sha256').update(value).digest('hex')
const queues = new Map()
const imageDomains = ['qpic.cn', 'qq.com', 'gtimg.cn', 'nt.qq.com.cn']
let accessToken = ''
let tokenExpires = 0
let tokenPromise = null
let socket
let heartbeat
let lastSequence = null
let sessionId = ''
let stopping = false

async function qqToken() {
  if (accessToken && Date.now() < tokenExpires - 60000) return accessToken
  if (!tokenPromise) tokenPromise = (async () => {
    const response = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret }), signal: AbortSignal.timeout(15000),
    })
    const data = await response.json()
    if (!response.ok || !data.access_token) throw new Error(`QQ access token request failed (${response.status}): ${data.message || data.code || 'unknown error'}`)
    accessToken = data.access_token
    tokenExpires = Date.now() + Number(data.expires_in || 3600) * 1000
    return accessToken
  })().finally(() => { tokenPromise = null })
  return tokenPromise
}

async function qqRequest(path, options = {}) {
  const token = await qqToken()
  const response = await fetch(`https://api.bot.qq.com${path}`, {
    ...options, headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`QQ API request failed (${response.status}): ${data.message || data.code || 'unknown error'}`)
  return data
}

async function reply({ openid, groupOpenid }, messageId, content) {
  const target = groupOpenid ? `groups/${encodeURIComponent(groupOpenid)}` : `users/${encodeURIComponent(openid)}`
  await qqRequest(`/v2/${target}/messages`, {
    method: 'POST', body: JSON.stringify({ msg_type: 0, content: content.slice(0, 1900), msg_id: messageId, msg_seq: 1 }),
  })
}

async function bind(openid, code) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [codes] = await connection.execute(`
      SELECT c.user_id, c.group_id, g.name AS group_name FROM qq_bind_codes c
      JOIN group_members gm ON gm.user_id = c.user_id AND gm.group_id = c.group_id
      JOIN ledger_groups g ON g.id = c.group_id
      WHERE c.code_hash = ? AND c.expires_at > UTC_TIMESTAMP() FOR UPDATE
    `, [hash(code)])
    if (!codes.length) { await connection.rollback(); return null }
    const { user_id: userId, group_id: groupId, group_name: groupName } = codes[0]
    await connection.execute('DELETE FROM qq_bindings WHERE openid = ? OR user_id = ?', [openid, userId])
    await connection.execute('INSERT INTO qq_bindings (openid, user_id, group_id) VALUES (?, ?, ?)', [openid, userId, groupId])
    await connection.execute('DELETE FROM qq_bind_codes WHERE user_id = ?', [userId])
    await connection.commit()
    return groupName
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

async function getBinding(openid) {
  const [rows] = await pool.execute(`
    SELECT b.user_id, b.group_id, a.display_name, g.name AS group_name
    FROM qq_bindings b JOIN accounts a ON a.id = b.user_id
    JOIN ledger_groups g ON g.id = b.group_id
    JOIN group_members gm ON gm.user_id = b.user_id AND gm.group_id = b.group_id
    WHERE b.openid = ?
  `, [openid])
  return rows[0] || null
}

async function requireCurrentBinding({ openid, groupOpenid }, binding) {
  const current = groupOpenid ? await getGroupBinding(pool, groupOpenid, openid) : await getBinding(openid)
  if (!current || current.user_id !== binding.user_id || current.group_id !== binding.group_id) throw new Error('QQ 绑定已变更，请重新发送账单。')
}

async function getState({ openid, groupOpenid }, binding) {
  const [rows] = groupOpenid
    ? await pool.execute(`SELECT state FROM qq_group_members WHERE group_id = ? AND member_openid = ? AND user_id = ?
      AND state_updated_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`, [binding.group_id, openid, binding.user_id])
    : await pool.execute('SELECT state FROM qq_conversations WHERE openid = ? AND updated_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY)', [openid])
  if (!rows.length) return { messages: [] }
  const state = typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state
  return state && Array.isArray(state.messages) ? state : { messages: [] }
}

async function setState({ openid, groupOpenid }, binding, state) {
  if (groupOpenid) {
    await pool.execute(`UPDATE qq_group_members SET state = ?, state_updated_at = UTC_TIMESTAMP()
      WHERE group_id = ? AND member_openid = ? AND user_id = ?`, [JSON.stringify(state), binding.group_id, openid, binding.user_id])
    return
  }
  await pool.execute('INSERT INTO qq_conversations (openid, state) VALUES (?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP', [openid, JSON.stringify(state)])
}

function isPrivateAddress(address) {
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7))
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
  }
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)
}

async function readImage(attachment) {
  let url
  try { url = new URL(attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url) } catch { throw new Error('图片地址无效。') }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !imageDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) throw new Error('不支持的图片地址。')
  const addresses = await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('图片地址无效。')
  if (Number(attachment.size) > 4 * 1024 * 1024) throw new Error('图片不能超过 4 MB。')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('无法下载 QQ 图片。')
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 4 * 1024 * 1024) throw new Error('图片不能超过 4 MB。')
    chunks.push(chunk)
  }
  if (!length) throw new Error('图片内容为空。')
  const content = Buffer.concat(chunks)
  const declaredMime = (response.headers.get('content-type') || attachment.content_type || '').split(';')[0].toLowerCase()
  const detectedMime = content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    ? 'image/jpeg'
    : content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? 'image/png'
      : (content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a')
        ? 'image/gif'
        : content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP'
          ? 'image/webp'
          : null
  const mime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(declaredMime) ? declaredMime : detectedMime
  if (!mime || (detectedMime && mime !== detectedMime)) throw new Error('仅支持 JPEG、PNG、WebP 或 GIF 图片。')
  return `data:${mime};base64,${content.toString('base64')}`
}

async function corecRequest(binding, path, body, chat) {
  const headers = { 'Content-Type': 'application/json', 'X-CoRec-Bot-Token': internalToken, 'X-CoRec-Bot-User': String(binding.user_id) }
  if (chat.groupOpenid) {
    headers['X-CoRec-QQ-Group'] = chat.groupOpenid
    headers['X-CoRec-QQ-Member'] = chat.openid
  }
  const response = await fetch(`${apiUrl}/api/groups/${binding.group_id}/${path}`, {
    method: 'POST', headers,
    body: JSON.stringify(body), signal: AbortSignal.timeout(70000),
  })
  const data = await response.json().catch(() => ({}))
  if (response.status === 409 && data.code === 'POSSIBLE_DUPLICATE') return data
  if (!response.ok) throw new Error(data.error || `CoRec API error (${response.status})`)
  return data
}

function extractJson(content) {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('模型返回格式无效，请重试。')
  try { return JSON.parse(content.slice(start, end + 1)) } catch { throw new Error('模型返回格式无效，请重试。') }
}

function validateExpense(value, binding, members) {
  if (!value || typeof value !== 'object') return null
  if (!['expense', 'income'].includes(value.type)) throw new Error('请问这笔账单是收入还是支出？')
  const amount = Number(value.amount)
  const date = typeof value.date === 'string' ? value.date : ''
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('请提供账单日期。')
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 100000000) throw new Error('请提供有效金额。')
  if (!(value.type === 'income' ? incomeCategories : categories).includes(value.category)) throw new Error('请提供账单分类。')
  const payerId = members
    ? (members.find((member) => member.displayName === value.payerName) || members.find((member) => member.id === binding.user_id))?.id
    : binding.user_id
  if (!payerId) throw new Error('无法找到群组成员，请检查账号绑定。')
  const time = typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ? value.time : null
  return { type: value.type, amount, date, time, category: value.category, payerId,
    merchant: typeof value.merchant === 'string' && value.merchant.trim() ? value.merchant.trim().slice(0, 100) : value.category,
    productName: typeof value.productName === 'string' ? value.productName.trim().slice(0, 100) : '',
    note: typeof value.note === 'string' ? value.note.trim().slice(0, 250) : '' }
}

async function parseMessage(binding, messages, chat) {
  const members = chat.groupOpenid ? null : (await pool.execute('SELECT a.id, a.display_name AS displayName FROM group_members gm JOIN accounts a ON a.id = gm.user_id WHERE gm.group_id = ?', [binding.group_id]))[0]
  const payerInstruction = members
    ? `群组成员：${members.map((member) => member.displayName).join('、')}。未指定付款人或收入归属时使用 ${binding.display_name}。`
    : '付款人或收入归属固定为发送者，不需要填写名字。'
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const system = `你是 CoRec 账本助手。今天是 ${now}。${payerInstruction}支出分类：${categories.join('、')}。收入分类：${incomeCategories.join('、')}。用户发送文字或图片默认是记账，请读取图片和聊天中的账单。只返回 JSON：{"reply":"回复","expense":null}。明确收支类型、实际金额、日期、分类后，expense 为 {"type":"expense或income","amount":数字,"date":"YYYY-MM-DD","time":"HH:mm或null","category":"分类","merchant":"商家名或空","productName":"商品名或空","note":"备注","payerName":"成员名"}。缺少金额、日期、类型或分类时在 reply 询问缺失信息，expense 为 null；不要猜测金额或日期。商家只写真正的商家名，消费描述放备注。无需用户确认后即可保存，但不要声称已保存。`
  const recent = messages.slice(-8)
  const history = recent.map((message, index) => ({ ...message, content: message.content.slice(0, index === recent.length - 1 ? 3000 : 100) }))
  const lastImage = history.findLastIndex((message) => message.image)
  const input = [{ role: 'system', content: system }, ...history.map((message, index) => ({ role: message.role, content: message.content || '请提取图片中的账单并记账。', ...(index === lastImage ? { image: message.image } : {}) }))]
  async function askModel(inputMessages) {
    const data = await corecRequest(binding, 'llm/chat', { messages: inputMessages }, chat)
    const text = data.output_text || (data.output ? data.output.flatMap((item) => item.content || []).filter((item) => typeof item.text === 'string').map((item) => item.text).join('\n') : '') || data.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new Error('模型没有返回文本。')
    return extractJson(text)
  }
  let result = await askModel(input)
  if (lastImage >= 0 && !result.expense && typeof result.reply === 'string' && !/[?？]|请(?:问|补充|提供|确认|告知|说明|填写)|能否|是否/.test(result.reply)) {
    result = await askModel([{ ...input[0], content: `${system} 不要只描述图片。信息齐全时必须返回 expense，信息不全时请具体追问。` }, ...input.slice(1)])
  }
  try { return { reply: typeof result.reply === 'string' ? result.reply : '请补充账单信息。', expense: validateExpense(result.expense, binding, members) } }
  catch (error) { return { reply: error.message, expense: null } }
}

function summary(expense) {
  return `${expense.date}${expense.time ? ` ${expense.time}` : ''} · ${expense.type === 'income' ? '收入' : '支出'} · ${expense.category} · ¥${Number(expense.amount).toFixed(2)}${expense.productName ? ` · ${expense.productName}` : ''}${expense.merchant && expense.merchant !== expense.category ? ` · ${expense.merchant}` : ''}`
}

async function handleMessage(chat, event) {
  const { openid, groupOpenid } = chat
  let text = (typeof event.content === 'string' ? event.content : '').trim().slice(0, 3000)
  let binding
  if (groupOpenid) {
    text = text.replace(/^<@!?[A-Za-z0-9_-]+>\s*/, '')
    if (text === '绑定') {
      const code = await requestGroupBinding(pool, groupOpenid, openid)
      return `请求码：${code}\n请在 CoRec 对应账本的「QQ 群聊绑定」中输入，有效期 10 分钟。`
    }
    if (/^确认绑定(?:\s|$)/.test(text)) {
      const match = /^确认绑定\s+([A-Fa-f0-9]{16})$/.exec(text)
      const confirmed = match && await confirmGroupBinding(pool, groupOpenid, openid, match[1].toUpperCase())
      return confirmed ? '绑定成功。' : '无法确认绑定，请由发起绑定的成员在本群使用网页显示的有效确认码。'
    }
    if (/^绑定\s/.test(text)) return '群聊绑定请只发送“绑定”，再到 CoRec 网页输入机器人给出的请求码。'
    binding = await getGroupBinding(pool, groupOpenid, openid)
    if (!binding) return '请先加入对应的 CoRec 群组并完成绑定。加入后可 @机器人 发送“绑定”。'
  } else {
    const bindMatch = /^绑定\s+([A-Fa-f0-9]{16})$/.exec(text)
    if (bindMatch) {
      const groupName = await bind(openid, bindMatch[1].toUpperCase())
      return groupName ? `绑定成功，当前账本：${groupName}。` : '绑定码无效或已过期，请在 CoRec 群组面板重新生成。'
    }
    binding = await getBinding(openid)
    if (!binding) return '请先在 CoRec 群组面板生成绑定码，然后发送：绑定 绑定码'
  }

  const state = await getState(chat, binding)
  const saveState = (value) => setState(chat, binding, value)
  const savedReply = (expense) => groupOpenid ? '已记入账本。' : `已记入 ${binding.group_name}：\n${summary(expense)}`
  const duplicateReply = (title, duplicates) => {
    const details = groupOpenid ? '' : `${duplicates.slice(0, 5).map(summary).join('\n')}\n`
    const mention = groupOpenid ? '@机器人 ' : ''
    return `${title}\n${details}${mention}回复“确认”继续，或回复“取消”。`
  }
  if (state.pending && /^(取消|取消入账)$/.test(text)) {
    await saveState({ messages: [] })
    return '已取消这笔账单。'
  }
  if (state.pending && /^(确认|仍然入账)$/.test(text)) {
    await requireCurrentBinding(chat, binding)
    const result = await corecRequest(binding, 'expenses', { ...state.pending.expense, confirmedDuplicateIds: state.pending.duplicateIds }, chat)
    if (result.duplicates) {
      state.pending.duplicateIds = result.duplicates.map((item) => item.id)
      await saveState(state)
      return duplicateReply('发现新的相似账单：', result.duplicates)
    }
    await saveState({ messages: [] })
    return savedReply(result.expense)
  }
  if (state.pending) return '有一笔可能重复的账单等待处理，请回复“确认”或“取消”。'
  if (/^(取消|重新开始)$/.test(text)) { await saveState({ messages: [] }); return '已清除本次待处理内容。' }
  const attachments = Array.isArray(event.attachments) ? event.attachments : []
  const imageAttachment = attachments.find((item) => typeof item.url === 'string' && ((typeof item.content_type === 'string' && item.content_type.startsWith('image/')) || (item.width && item.height)))
  if (!text && !imageAttachment) return '请发送账单文字或图片。'
  const image = imageAttachment ? await readImage(imageAttachment) : undefined
  const previousMessages = image ? state.messages.map(({ image: _image, ...message }) => message) : state.messages
  const messages = [...previousMessages, { role: 'user', content: text || '请提取图片中的账单并记账。', ...(image ? { image } : {}) }].slice(-10)
  const result = await parseMessage(binding, messages, chat)
  if (!result.expense) {
    const answer = /[?？]|请(?:问|补充|提供|确认|告知|说明|填写)|能否|是否/.test(result.reply) ? result.reply : `${result.reply}\n请补充账单的收支类型、金额、日期和分类。`
    await saveState({ messages: [...messages, { role: 'assistant', content: answer }].slice(-10) })
    return answer
  }
  await requireCurrentBinding(chat, binding)
  const saved = await corecRequest(binding, 'expenses', result.expense, chat)
  if (saved.duplicates) {
    await saveState({ messages: [], pending: { expense: result.expense, duplicateIds: saved.duplicates.map((item) => item.id) } })
    return duplicateReply('发现可能重复的账单：', saved.duplicates)
  }
  await saveState({ messages: [] })
  return savedReply(saved.expense)
}

async function processEvent(chat, event) {
  const messageId = event.id
  const messageHash = hash(chat.groupOpenid ? `group:${chat.groupOpenid}:${messageId}` : messageId)
  try {
    await pool.execute('INSERT INTO qq_processed_messages (message_hash) VALUES (?)', [messageHash])
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return
    throw error
  }
  let output
  try { output = await handleMessage(chat, event) } catch (error) {
    console.error('QQ message processing failed:', error.message)
    output = chat.groupOpenid ? '处理失败，请稍后重试。' : `处理失败：${error.message || '请稍后重试。'}`
  }
  await reply(chat, messageId, output)
}

function queueEvent(event, isGroup = false) {
  const groupOpenid = isGroup ? event?.group_openid : null
  const openid = isGroup ? event?.author?.member_openid : (event?.author?.user_openid || event?.author?.id)
  if (isGroup && (typeof groupOpenid !== 'string' || !qqOpenidPattern.test(groupOpenid))) return
  if (typeof openid !== 'string' || !qqOpenidPattern.test(openid) || typeof event?.id !== 'string' || !event.id || event.id.length > 512) return

  const chat = { openid, groupOpenid }
  const key = groupOpenid ? `group:${groupOpenid}:${openid}` : openid
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.then(() => processEvent(chat, event)).catch((error) => console.error('QQ event failed:', error.message))
  queues.set(key, next)
  next.finally(() => { if (queues.get(key) === next) queues.delete(key) })
}

async function connect() {
  const token = await qqToken()
  const gateway = await qqRequest('/gateway/bot')
  const url = new URL(gateway.url)
  if (url.protocol !== 'wss:' || !['api.bot.qq.com', 'api.sgroup.qq.com'].includes(url.hostname)) throw new Error('QQ gateway returned an invalid address.')
  socket = new WebSocket(url)
  let acknowledged = true
  socket.addEventListener('message', (event) => {
    let packet
    try { packet = JSON.parse(event.data) } catch { return }
    if (packet.s != null) lastSequence = packet.s
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval)
      if (!Number.isFinite(interval) || interval < 1000) { socket.close(); return }
      clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        if (!acknowledged) { socket.close(); return }
        acknowledged = false
        socket.send(JSON.stringify({ op: 1, d: lastSequence }))
      }, interval)
      socket.send(JSON.stringify(sessionId && lastSequence != null
        ? { op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSequence } }
        : { op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1], properties: {} } }))
    } else if (packet.op === 11) acknowledged = true
    else if (packet.op === 7) socket.close()
    else if (packet.op === 9) { sessionId = ''; lastSequence = null; socket.close() }
    else if (packet.op === 0 && packet.t === 'READY') { sessionId = packet.d?.session_id || ''; console.log('QQ Bot connected.') }
    else if (packet.op === 0 && packet.t === 'C2C_MESSAGE_CREATE') queueEvent(packet.d)
    else if (packet.op === 0 && packet.t === 'GROUP_AT_MESSAGE_CREATE') queueEvent(packet.d, true)
  })
  await new Promise((resolve) => {
    socket.addEventListener('error', () => console.error('QQ gateway connection error.'))
    socket.addEventListener('close', (event) => {
      clearInterval(heartbeat)
      if ([4001, 4002, 4004, 4006, 4007, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(event.code)) { sessionId = ''; lastSequence = null }
      console.log(`QQ gateway disconnected (${event.code}).`)
      resolve()
    }, { once: true })
  })
}

async function start() {
  const cleanup = async () => {
    try {
      await pool.execute('DELETE FROM qq_bind_codes WHERE expires_at <= UTC_TIMESTAMP()')
      await pool.execute('DELETE FROM qq_conversations WHERE updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY)')
      await pool.execute('DELETE FROM qq_group_bind_requests WHERE expires_at <= UTC_TIMESTAMP()')
      await pool.execute('UPDATE qq_group_members SET state = NULL, state_updated_at = NULL WHERE state_updated_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)')
      await pool.execute('DELETE FROM qq_processed_messages WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 7 DAY)')
    } catch (error) { console.error('QQ cleanup failed:', error.message) }
  }
  await cleanup()
  const cleanupTimer = setInterval(cleanup, 6 * 60 * 60 * 1000)
  while (!stopping) {
    try { await connect() } catch (error) { console.error('QQ gateway error:', error.message) }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  clearInterval(cleanupTimer)
  await Promise.allSettled([...queues.values()])
  await pool.end()
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; socket?.close() })
await start()
