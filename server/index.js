import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import mysql from 'mysql2/promise'

const app = express()
const port = Number(process.env.API_PORT || 3001)
const categories = new Set(['餐饮', '交通', '娱乐', '购物', '居住', '其他'])
const incomeCategories = new Set(['工资', '奖金', '退款', '其他收入'])
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const usernamePattern = /^[\p{L}\p{N}_.-]{2,32}$/u
const invitePattern = /^[A-F0-9]{16}$/
const cookieName = 'corec_session'
const sessionDays = 30
const cookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  path: '/',
}
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'corec',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'corec',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
})

app.set('trust proxy', 1)
app.use('/api/groups/:groupId/llm/chat', express.json({ limit: '6mb' }))
app.use(express.json({ limit: '20kb' }))
app.use(cookieParser())

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '尝试次数过多，请 15 分钟后再试。' },
})
const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '模型请求过于频繁，请稍后再试。' },
})

function serializeExpense(row) {
  return {
    id: row.id,
    type: row.entry_type || 'expense',
    date: row.date,
    time: row.transaction_time || null,
    merchant: row.merchant,
    productName: row.product_name || '',
    note: row.note,
    category: row.category,
    amount: Number(row.amount_cents) / 100,
    payerId: row.payer_user_id,
    payer: row.payer_name,
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function createSession(userId, response) {
  const token = randomBytes(32).toString('base64url')
  await pool.execute('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()')
  await pool.execute(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${sessionDays} DAY))
  `, [tokenHash(token), userId])
  response.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDays * 24 * 60 * 60 * 1000 })
}

function clearSession(response) {
  response.clearCookie(cookieName, cookieOptions)
}

async function requireAuth(request, response, next) {
  try {
    const internalToken = process.env.QQ_BOT_INTERNAL_TOKEN || ''
    const suppliedToken = request.get('X-CoRec-Bot-Token') || ''
    if (suppliedToken) {
      if (request.method !== 'POST' || !/^\/api\/groups\/\d+\/(?:llm\/chat|expenses)$/.test(request.path)) return response.status(403).json({ error: '服务接口无权限。' })
      const expected = Buffer.from(internalToken)
      const supplied = Buffer.from(suppliedToken)
      if (expected.length < 32 || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return response.status(401).json({ error: '服务认证失败。' })
      const userId = Number(request.get('X-CoRec-Bot-User'))
      if (!Number.isSafeInteger(userId) || userId < 1) return response.status(401).json({ error: '服务账号无效。' })
      const [users] = await pool.execute('SELECT id, username, display_name FROM accounts WHERE id = ?', [userId])
      if (!users.length) return response.status(401).json({ error: '服务账号无效。' })
      request.user = { id: users[0].id, username: users[0].username, displayName: users[0].display_name }
      return next()
    }
    const token = request.cookies[cookieName]
    if (!token) return response.status(401).json({ error: '请先登录。' })
    const [rows] = await pool.execute(`
      SELECT a.id, a.username, a.display_name, s.token_hash
      FROM sessions s
      JOIN accounts a ON a.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
      LIMIT 1
    `, [tokenHash(token)])
    if (!rows.length) {
      clearSession(response)
      return response.status(401).json({ error: '登录已过期，请重新登录。' })
    }
    request.user = { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name }
    request.sessionTokenHash = rows[0].token_hash
    next()
  } catch (error) {
    next(error)
  }
}

async function requireGroupMember(request, response, next) {
  try {
    const groupId = Number(request.params.groupId)
    if (!Number.isSafeInteger(groupId) || groupId < 1) {
      return response.status(400).json({ error: '群组编号无效。' })
    }
    const [rows] = await pool.execute(`
      SELECT g.id, g.name, g.invite_code, gm.role
      FROM group_members gm
      JOIN ledger_groups g ON g.id = gm.group_id
      WHERE gm.group_id = ? AND gm.user_id = ?
      LIMIT 1
    `, [groupId, request.user.id])
    if (!rows.length) return response.status(404).json({ error: '找不到这个群组。' })
    request.group = rows[0]
    next()
  } catch (error) {
    next(error)
  }
}

function isNonPublicAddress(address) {
  if (address.startsWith('::ffff:')) return isNonPublicAddress(address.slice(7))
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number)
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19 || second === 51))
      || (first === 203 && second === 0)
  }
  const normalized = address.toLowerCase()
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
}

async function getPublicModelEndpoint(baseUrl, apiFormat) {
  let base
  try { base = new URL(baseUrl) } catch { throw new Error('模型服务地址无效。') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('模型服务地址必须是有效的 HTTPS 地址。')
  }
  const hostname = base.hostname.replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('模型服务地址必须是公网 HTTPS 地址。')
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error('模型服务地址必须解析到公网 IP。')
  }
  const path = base.pathname.replace(/\/+$/, '')
  if (apiFormat === 'responses') {
    base.pathname = path.endsWith('/responses') ? path : path.endsWith('/v1') ? `${path}/responses` : `${path}/v1/responses`
  } else {
    base.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`
  }
  return base
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(32) NOT NULL,
      display_name VARCHAR(32) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY accounts_username_unique (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  const [accountColumns] = await pool.query('SHOW COLUMNS FROM accounts')
  if (!accountColumns.some((column) => column.Field === 'display_name')) {
    await pool.query('ALTER TABLE accounts ADD COLUMN display_name VARCHAR(32) NULL AFTER username')
    await pool.query('UPDATE accounts SET display_name = username WHERE display_name IS NULL')
    await pool.query('ALTER TABLE accounts MODIFY display_name VARCHAR(32) NOT NULL')
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_groups (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(80) NOT NULL,
      invite_code CHAR(16) NOT NULL,
      created_by INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY ledger_groups_invite_unique (invite_code),
      CONSTRAINT ledger_groups_creator_fk FOREIGN KEY (created_by) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
      joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, user_id),
      CONSTRAINT group_members_group_fk FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
      CONSTRAINT group_members_account_fk FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (token_hash),
      INDEX sessions_expiry_idx (expires_at),
      CONSTRAINT sessions_account_fk FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      entry_type ENUM('expense', 'income') NOT NULL DEFAULT 'expense',
      group_id INT UNSIGNED NOT NULL,
      date DATE NOT NULL,
      transaction_time TIME NULL,
      merchant VARCHAR(100) NOT NULL,
      product_name VARCHAR(100) NOT NULL DEFAULT '',
      note VARCHAR(250) NOT NULL DEFAULT '',
      category VARCHAR(20) NOT NULL,
      amount_cents BIGINT UNSIGNED NOT NULL,
      payer_user_id INT UNSIGNED NULL,
      payer VARCHAR(80) NOT NULL,
      created_by INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX expenses_group_date_idx (group_id, date DESC, id DESC),
      CONSTRAINT expenses_amount_positive CHECK (amount_cents > 0),
      CONSTRAINT expenses_group_fk FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
      CONSTRAINT expenses_payer_fk FOREIGN KEY (payer_user_id) REFERENCES accounts(id),
      CONSTRAINT expenses_creator_fk FOREIGN KEY (created_by) REFERENCES accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `)

  const [columns] = await pool.query('SHOW COLUMNS FROM expenses')
  const names = new Set(columns.map((column) => column.Field))
  if (!names.has('entry_type')) await pool.query("ALTER TABLE expenses ADD COLUMN entry_type ENUM('expense', 'income') NOT NULL DEFAULT 'expense' AFTER id")
  if (!names.has('product_name')) await pool.query("ALTER TABLE expenses ADD COLUMN product_name VARCHAR(100) NOT NULL DEFAULT '' AFTER merchant")
  if (!names.has('transaction_time')) await pool.query('ALTER TABLE expenses ADD COLUMN transaction_time TIME NULL AFTER date')
  if (!names.has('group_id')) await pool.query('ALTER TABLE expenses ADD COLUMN group_id INT UNSIGNED NULL AFTER id')
  if (!names.has('payer_user_id')) await pool.query('ALTER TABLE expenses ADD COLUMN payer_user_id INT UNSIGNED NULL AFTER amount_cents')
  if (!names.has('payer')) await pool.query('ALTER TABLE expenses ADD COLUMN payer VARCHAR(80) NULL AFTER payer_user_id')
  if (!names.has('created_by')) await pool.query('ALTER TABLE expenses ADD COLUMN created_by INT UNSIGNED NULL AFTER payer')
  await pool.execute("UPDATE expenses SET category = '居住' WHERE entry_type = 'expense' AND category = '居家'")
  if (names.has('payer') && columns.find((column) => column.Field === 'payer')?.Type !== 'varchar(80)') {
    await pool.query("ALTER TABLE expenses MODIFY payer VARCHAR(80) NOT NULL DEFAULT ''")
  }
  const [indexes] = await pool.query('SHOW INDEX FROM expenses')
  if (!indexes.some((index) => index.Key_name === 'expenses_group_date_idx')) {
    await pool.query('ALTER TABLE expenses ADD INDEX expenses_group_date_idx (group_id, date DESC, id DESC)')
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_bind_codes (
    code_hash CHAR(64) PRIMARY KEY, user_id INT UNSIGNED NOT NULL, group_id INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL, INDEX qq_bind_expiry_idx (expires_at),
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_bindings (
    openid VARCHAR(128) PRIMARY KEY, user_id INT UNSIGNED NOT NULL, group_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY qq_binding_user_idx (user_id),
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_conversations (
    openid VARCHAR(128) PRIMARY KEY, state JSON NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (openid) REFERENCES qq_bindings(openid) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_processed_messages (
    message_hash CHAR(64) PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX qq_processed_created_idx (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
}

app.get('/api/health', async (_request, response) => {
  await pool.query('SELECT 1')
  response.json({ status: 'ok' })
})

function getLlmConfig() {
  return {
    baseUrl: process.env.LLM_BASE_URL?.trim() || '',
    apiKey: process.env.LLM_API_KEY?.trim() || '',
    model: process.env.LLM_MODEL?.trim() || '',
    apiFormat: process.env.LLM_API_FORMAT?.trim() || 'chat-completions',
  }
}

app.post('/api/auth/register', authLimiter, async (request, response) => {
  const { username, displayName, password } = request.body || {}
  if (typeof username !== 'string' || !usernamePattern.test(username.trim())) {
    return response.status(400).json({ error: '账号需为 2 到 32 位字母、数字或 _ . -。' })
  }
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 32) {
    return response.status(400).json({ error: '名字需为 1 到 32 个字符。' })
  }
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return response.status(400).json({ error: '密码长度需为 8 到 72 个字节。' })
  }
  try {
    const passwordHash = await bcrypt.hash(password, 12)
    const [result] = await pool.execute('INSERT INTO accounts (username, display_name, password_hash) VALUES (?, ?, ?)', [username.trim(), displayName.trim(), passwordHash])
    await createSession(result.insertId, response)
    response.status(201).json({ user: { id: result.insertId, username: username.trim(), displayName: displayName.trim() } })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: '这个账号已经被注册。' })
    throw error
  }
})

app.post('/api/auth/login', authLimiter, async (request, response) => {
  const { username, password } = request.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return response.status(400).json({ error: '请输入账号和密码。' })
  }
  const [rows] = await pool.execute('SELECT id, username, display_name, password_hash FROM accounts WHERE username = ? LIMIT 1', [username.trim()])
  if (!rows.length || !await bcrypt.compare(password, rows[0].password_hash)) {
    return response.status(401).json({ error: '账号或密码不正确。' })
  }
  await createSession(rows[0].id, response)
  response.json({ user: { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name } })
})

app.post('/api/auth/logout', requireAuth, async (request, response) => {
  await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [request.sessionTokenHash])
  clearSession(response)
  response.json({ loggedOut: true })
})

app.put('/api/auth/profile', requireAuth, async (request, response) => {
  const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim() : ''
  if (!displayName || displayName.length > 32) {
    return response.status(400).json({ error: '名字需为 1 到 32 个字符。' })
  }
  await pool.execute('UPDATE accounts SET display_name = ? WHERE id = ?', [displayName, request.user.id])
  response.json({ user: { ...request.user, displayName } })
})

app.get('/api/auth/me', requireAuth, async (request, response) => {
  const [groups] = await pool.execute(`
    SELECT g.id, g.name, g.invite_code AS inviteCode, gm.role
    FROM group_members gm
    JOIN ledger_groups g ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at, g.id
  `, [request.user.id])
  response.json({ user: request.user, groups })
})

app.get('/api/groups', requireAuth, async (request, response) => {
  const [groups] = await pool.execute(`
    SELECT g.id, g.name, g.invite_code AS inviteCode, gm.role
    FROM group_members gm
    JOIN ledger_groups g ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at, g.id
  `, [request.user.id])
  response.json({ groups })
})

app.post('/api/groups', requireAuth, async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  if (!name || name.length > 80) return response.status(400).json({ error: '群组名称需为 1 到 80 个字符。' })
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const inviteCode = randomBytes(8).toString('hex').toUpperCase()
    const [result] = await connection.execute(
      'INSERT INTO ledger_groups (name, invite_code, created_by) VALUES (?, ?, ?)',
      [name, inviteCode, request.user.id],
    )
    await connection.execute(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')",
      [result.insertId, request.user.id],
    )
    await connection.execute(
      'UPDATE expenses SET group_id = ?, created_by = ? WHERE group_id IS NULL',
      [result.insertId, request.user.id],
    )
    await connection.commit()
    response.status(201).json({ group: { id: result.insertId, name, inviteCode, role: 'owner' } })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

app.post('/api/groups/join', requireAuth, async (request, response) => {
  const inviteCode = typeof request.body?.inviteCode === 'string' ? request.body.inviteCode.trim().toUpperCase() : ''
  if (!invitePattern.test(inviteCode)) return response.status(400).json({ error: '请输入有效的邀请码。' })
  const [groups] = await pool.execute('SELECT id, name, invite_code FROM ledger_groups WHERE invite_code = ? LIMIT 1', [inviteCode])
  if (!groups.length) return response.status(404).json({ error: '没有找到这个群组，请检查邀请码。' })
  try {
    await pool.execute("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')", [groups[0].id, request.user.id])
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return response.status(409).json({ error: '你已经在这个群组里了。' })
    throw error
  }
  response.status(201).json({ group: { id: groups[0].id, name: groups[0].name, inviteCode: groups[0].invite_code, role: 'member' } })
})

app.get('/api/groups/:groupId', requireAuth, requireGroupMember, async (request, response) => {
  const [members] = await pool.execute(`
    SELECT a.id, a.username, a.display_name AS displayName, gm.role
    FROM group_members gm
    JOIN accounts a ON a.id = gm.user_id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at, a.id
  `, [request.group.id])
  response.json({ group: { ...request.group, members } })
})

app.post('/api/groups/:groupId/qq/bind-code', requireAuth, requireGroupMember, async (request, response) => {
  if (request.get('X-CoRec-Bot-Token')) return response.status(403).json({ error: '请在网站上生成绑定码。' })
  if ((process.env.QQ_BOT_INTERNAL_TOKEN || '').length < 32) return response.status(503).json({ error: 'QQ Bot 尚未配置。' })
  const code = randomBytes(8).toString('hex').toUpperCase()
  await pool.execute('DELETE FROM qq_bind_codes WHERE expires_at <= UTC_TIMESTAMP() OR user_id = ?', [request.user.id])
  await pool.execute('INSERT INTO qq_bind_codes (code_hash, user_id, group_id, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))', [tokenHash(code), request.user.id, request.group.id])
  response.json({ code, expiresIn: 600 })
})

app.delete('/api/qq/binding', requireAuth, async (request, response) => {
  if (request.get('X-CoRec-Bot-Token')) return response.status(403).json({ error: '请在网站上解除绑定。' })
  await pool.execute('DELETE FROM qq_bindings WHERE user_id = ?', [request.user.id])
  await pool.execute('DELETE FROM qq_bind_codes WHERE user_id = ?', [request.user.id])
  response.json({ ok: true })
})

app.get('/api/qq/binding', requireAuth, async (request, response) => {
  if (request.get('X-CoRec-Bot-Token')) return response.status(403).json({ error: '请在网站上查看绑定。' })
  const [rows] = await pool.execute('SELECT b.group_id, g.name AS group_name FROM qq_bindings b JOIN ledger_groups g ON g.id = b.group_id WHERE b.user_id = ?', [request.user.id])
  response.json({ binding: rows.length ? { groupId: rows[0].group_id, groupName: rows[0].group_name } : null })
})

app.get('/api/groups/:groupId/llm/config', requireAuth, requireGroupMember, (_request, response) => {
  const config = getLlmConfig()
  const configured = Boolean(config.baseUrl && config.apiKey && config.model && ['chat-completions', 'responses'].includes(config.apiFormat))
  response.json({ configured })
})

app.post('/api/groups/:groupId/llm/chat', requireAuth, llmLimiter, requireGroupMember, async (request, response) => {
  const { messages } = request.body || {}
  const config = getLlmConfig()
  if (!config.baseUrl || !config.apiKey || !config.model || !['chat-completions', 'responses'].includes(config.apiFormat)) {
    return response.status(503).json({ error: '后端还没有配置模型，请先在 .env 填写 LLM 配置并重启服务。' })
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 16) {
    return response.status(400).json({ error: '对话内容无效。' })
  }
  const validMessages = messages.every((message) => message
    && ['system', 'user', 'assistant'].includes(message.role)
    && typeof message.content === 'string'
    && message.content.length <= 4000)
  if (!validMessages || messages.reduce((size, message) => size + message.content.length, 0) > 5000) {
    return response.status(400).json({ error: '对话内容过长或格式无效。' })
  }
  const imageMessages = messages.filter((message) => message.image !== undefined)
  if (imageMessages.length > 1 || imageMessages.some((message) => {
    if (message.role !== 'user' || typeof message.image !== 'string' || message.image.length > 5592500) return true
    const match = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(message.image)
    if (!match || match[2].length % 4 !== 0) return true
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.toString('base64') !== match[2]) return true
    const signatures = {
      jpeg: bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
      png: bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      gif: bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a',
      webp: bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    }
    return !signatures[match[1]]
  })) return response.status(400).json({ error: '图片格式无效或超过 4 MB。' })

  const modelMessages = messages.map(({ role, content, image }) => ({
    role,
    content: image ? (config.apiFormat === 'responses'
      ? [{ type: 'input_text', text: content }, { type: 'input_image', image_url: image }]
      : [{ type: 'text', text: content }, { type: 'image_url', image_url: { url: image } }]) : content,
  }))

  let endpoint
  try {
    endpoint = await getPublicModelEndpoint(config.baseUrl, config.apiFormat)
  } catch (error) {
    return response.status(400).json({ error: error.message || '模型服务地址无效。' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(config.apiFormat === 'responses' ? {
        model: config.model,
        input: modelMessages,
      } : {
        model: config.model,
        temperature: 0.1,
        messages: modelMessages,
      }),
    })
    const body = await upstream.text()
    if (body.length > 100000) return response.status(502).json({ error: '模型服务返回内容过大。' })
    const contentType = upstream.headers.get('content-type') || 'application/json'
    response.status(upstream.status).set('Content-Type', contentType.includes('json') ? 'application/json' : 'text/plain; charset=utf-8').send(body)
  } catch (error) {
    response.status(controller.signal.aborted ? 504 : 502).json({
      error: controller.signal.aborted ? '模型响应超时，请稍后重试。' : 'CoRec 服务端无法连接模型服务，请检查服务地址、网络和服务状态。',
    })
  } finally {
    clearTimeout(timeout)
  }
})

app.get('/api/groups/:groupId/analytics', requireAuth, requireGroupMember, async (request, response) => {
  const { from, to, granularity = 'day' } = request.query
  const isValidDate = (value) => {
    if (typeof value !== 'string' || !datePattern.test(value)) return false
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  }
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    return response.status(400).json({ error: '统计日期范围无效。' })
  }
  if (!['day', 'week', 'month'].includes(granularity)) {
    return response.status(400).json({ error: '统计时间颗粒度无效。' })
  }
  const bucketSql = granularity === 'month'
    ? "DATE_FORMAT(e.date, '%Y-%m-01')"
    : granularity === 'week'
      ? "DATE_FORMAT(DATE_SUB(e.date, INTERVAL WEEKDAY(e.date) DAY), '%Y-%m-%d')"
      : "DATE_FORMAT(e.date, '%Y-%m-%d')"
  const [categoryRows] = await pool.execute(`
    SELECT e.category, SUM(e.amount_cents) AS amount_cents
    FROM expenses e
    WHERE e.group_id = ? AND e.entry_type = 'expense' AND e.date >= ? AND e.date <= ?
    GROUP BY e.category
    ORDER BY amount_cents DESC
  `, [request.group.id, from, to])
  const [timelineRows] = await pool.execute(`
    SELECT ${bucketSql} AS date, e.entry_type, SUM(e.amount_cents) AS amount_cents
    FROM expenses e
    WHERE e.group_id = ? AND e.date >= ? AND e.date <= ?
    GROUP BY date, e.entry_type
    ORDER BY date
  `, [request.group.id, from, to])
  response.json({
    categories: categoryRows.map((row) => ({ category: row.category, amount: Number(row.amount_cents) / 100 })),
    timeline: timelineRows.map((row) => ({ date: row.date, type: row.entry_type, amount: Number(row.amount_cents) / 100 })),
  })
})

app.get('/api/groups/:groupId/ledger', requireAuth, requireGroupMember, async (request, response) => {
  const month = request.query.month
  if (typeof month !== 'string' || !monthPattern.test(month)) {
    return response.status(400).json({ error: '月份格式无效。' })
  }
  const [year, monthNumber] = month.split('-').map(Number)
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10)
  const [rows] = await pool.execute(`
    SELECT e.id, DATE_FORMAT(e.date, '%Y-%m-%d') AS date, TIME_FORMAT(e.transaction_time, '%H:%i') AS transaction_time, e.merchant, e.product_name, e.note, e.category,
      e.entry_type, e.amount_cents, e.payer_user_id, COALESCE(a.display_name, e.payer) AS payer_name
    FROM expenses e
    LEFT JOIN accounts a ON a.id = e.payer_user_id
    WHERE e.group_id = ? AND e.date >= ? AND e.date < ?
    ORDER BY e.date DESC, e.transaction_time DESC, e.id DESC
  `, [request.group.id, `${month}-01`, nextMonth])
  const [balanceRows] = await pool.execute(`
    SELECT COALESCE(SUM(CASE
      WHEN entry_type = 'income' THEN amount_cents
      ELSE -CAST(amount_cents AS SIGNED)
    END), 0) AS balance_cents
    FROM expenses
    WHERE group_id = ?
  `, [request.group.id])
  response.json({ expenses: rows.map(serializeExpense), balance: Number(balanceRows[0].balance_cents) / 100 })
})

app.post('/api/groups/:groupId/expenses', requireAuth, requireGroupMember, async (request, response) => {
  const { date, time = null, merchant, productName = '', note = '', category, amount, payerId, type = 'expense', confirmedDuplicateIds = [] } = request.body || {}
  const parsedAmount = Number(amount)
  const parsedDate = typeof date === 'string' && datePattern.test(date) ? new Date(`${date}T00:00:00Z`) : null
  const validDate = parsedDate && !Number.isNaN(parsedDate.valueOf()) && parsedDate.toISOString().slice(0, 10) === date
  const payerUserId = Number(payerId)

  if (!validDate || typeof merchant !== 'string' || !merchant.trim() || merchant.trim().length > 100) {
    return response.status(400).json({ error: '请填写有效日期和账单名称。' })
  }
  if (time !== null && (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    return response.status(400).json({ error: '时间格式无效。' })
  }
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 100000000) {
    return response.status(400).json({ error: '请输入有效金额。' })
  }
  const allowedCategories = type === 'income' ? incomeCategories : categories
  if (!['expense', 'income'].includes(type) || !allowedCategories.has(category) || !Number.isSafeInteger(payerUserId) || payerUserId < 1) {
    return response.status(400).json({ error: '账目类型、分类或成员无效。' })
  }
  if (typeof note !== 'string' || note.length > 250) {
    return response.status(400).json({ error: '备注不能超过 250 个字符。' })
  }
  if (typeof productName !== 'string' || productName.trim().length > 100) {
    return response.status(400).json({ error: '商品名不能超过 100 个字符。' })
  }
  if (!Array.isArray(confirmedDuplicateIds) || !confirmedDuplicateIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return response.status(400).json({ error: '重复账单确认信息无效。' })
  }
  const [payers] = await pool.execute(`
    SELECT a.display_name
    FROM group_members gm JOIN accounts a ON a.id = gm.user_id
    WHERE gm.group_id = ? AND gm.user_id = ?
    LIMIT 1
  `, [request.group.id, payerUserId])
  if (!payers.length) return response.status(400).json({ error: '付款人必须是群组成员。' })

  const amountCents = Math.round(parsedAmount * 100)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.execute('SELECT id FROM ledger_groups WHERE id = ? FOR UPDATE', [request.group.id])
    const [duplicates] = await connection.execute(`
      SELECT e.id, DATE_FORMAT(e.date, '%Y-%m-%d') AS date, TIME_FORMAT(e.transaction_time, '%H:%i') AS transaction_time,
        e.merchant, e.product_name, e.note, e.category, e.entry_type, e.amount_cents, e.payer_user_id,
        COALESCE(a.display_name, e.payer) AS payer_name
      FROM expenses e LEFT JOIN accounts a ON a.id = e.payer_user_id
      WHERE e.group_id = ? AND e.date = ? AND e.entry_type = ? AND e.amount_cents = ?
      ORDER BY e.id DESC
    `, [request.group.id, date, type, amountCents])
    if (duplicates.some((row) => !confirmedDuplicateIds.includes(row.id))) {
      await connection.rollback()
      return response.status(409).json({ code: 'POSSIBLE_DUPLICATE', error: '发现可能重复的账单，请确认是否继续。', duplicates: duplicates.map(serializeExpense) })
    }
    const [result] = await connection.execute(`
      INSERT INTO expenses (entry_type, group_id, date, transaction_time, merchant, product_name, note, category, amount_cents, payer_user_id, payer, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [type, request.group.id, date, time, merchant.trim(), productName.trim(), note.trim(), category, amountCents, payerUserId, payers[0].display_name, request.user.id])
    const [rows] = await connection.execute(`
      SELECT e.id, DATE_FORMAT(e.date, '%Y-%m-%d') AS date, TIME_FORMAT(e.transaction_time, '%H:%i') AS transaction_time, e.merchant, e.product_name, e.note, e.category,
        e.entry_type, e.amount_cents, e.payer_user_id, COALESCE(a.display_name, e.payer) AS payer_name
      FROM expenses e LEFT JOIN accounts a ON a.id = e.payer_user_id WHERE e.id = ?
    `, [result.insertId])
    await connection.commit()
    response.status(201).json({ expense: serializeExpense(rows[0]) })
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
})

app.delete('/api/groups/:groupId/expenses/:id', requireAuth, requireGroupMember, async (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: '账单编号无效。' })
  const [result] = await pool.execute('DELETE FROM expenses WHERE id = ? AND group_id = ?', [id, request.group.id])
  if (!result.affectedRows) return response.status(404).json({ error: '账单不存在。' })
  response.json({ deleted: true })
})

app.use((error, _request, response, _next) => {
  if (error.type === 'entity.too.large') return response.status(413).json({ error: '上传内容过大，请选择不超过 4 MB 的图片。' })
  console.error(error)
  response.status(500).json({ error: '服务暂时不可用，请稍后重试。' })
})

async function shutdown() {
  server.close(async () => {
    await pool.end()
    process.exit(0)
  })
}

await ensureSchema()
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`CoRec API listening on port ${port}`)
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
