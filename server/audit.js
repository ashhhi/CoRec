import { GroupError } from './groups.js'

export async function ensureAuditSchema(pool) {
  // No cascading foreign keys: resets, removed members and dissolved groups keep their history.
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    group_id INT UNSIGNED NULL, group_name VARCHAR(80) NOT NULL DEFAULT '',
    actor_id INT UNSIGNED NULL, actor_name VARCHAR(80) NOT NULL,
    category VARCHAR(20) NOT NULL, action VARCHAR(80) NOT NULL, entity_id VARCHAR(80) NULL,
    source VARCHAR(20) NOT NULL, outcome VARCHAR(16) NOT NULL DEFAULT 'success',
    details JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX audit_group_id_idx (group_id, id), INDEX audit_actor_id_idx (actor_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
}

// Only known business fields may enter the history. Never persist credentials, binding codes,
// QQ identifiers, uploaded images, raw Chat messages or model configuration.
const fields = new Set(['id','type','transferDirection','date','time','merchant','productName','note','category','amount','savingsAmount','payerId','payer',
  'title','details','kind','status','createdBy','assigneeId','assigneeName','dueAt','recurrence','seriesId','target','deliveryStatus','deliveredAt','completedAt',
  'name','displayName','role','userId','username','action','page','scope','deletedCount','count','before','after','changes','targetName','targetUserId','groupName',
  'unit','every','weekdays','days','messageCount','hasImage','httpStatus'])

export function auditDetails(value, depth = 0) {
  if (depth > 8 || value == null) return null
  if (typeof value === 'string') return value.slice(0, 2000)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => auditDetails(item, depth + 1))
  if (typeof value !== 'object') return null
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)).map(([key, item]) => [key, auditDetails(item, depth + 1)]))
}

export async function writeAudit(connection, event) {
  let actorName = event.actorName
  let groupName = event.groupName
  if (actorName == null && event.actorId) {
    const [[actor]] = await connection.execute('SELECT display_name FROM accounts WHERE id=?', [event.actorId])
    actorName = actor?.display_name || `成员 #${event.actorId}`
  }
  if (groupName == null && event.groupId) {
    const [[group]] = await connection.execute('SELECT name FROM ledger_groups WHERE id=?', [event.groupId])
    groupName = group?.name || ''
  }
  await connection.execute(`INSERT INTO audit_logs
    (group_id,group_name,actor_id,actor_name,category,action,entity_id,source,outcome,details,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
  [event.groupId || null, groupName || '', event.actorId || null, actorName || '系统', event.category, event.action,
    event.entityId == null ? null : String(event.entityId), event.source || 'web', event.outcome || 'success', JSON.stringify(auditDetails(event.details || {}))])
}

export function auditSource(request) {
  if (request.get?.('X-CoRec-Bot-Token')) return request.qqGroup ? 'qq-group' : 'qq-private'
  return request.get?.('X-CoRec-Source') === 'chat' ? 'chat' : 'web'
}

export async function auditRequest(connection, request, event) {
  await writeAudit(connection, { actorId: request.user.id, actorName: request.user.displayName,
    groupId: request.group?.id, groupName: request.group?.name, source: auditSource(request), ...event })
  request.auditRecorded = true
}

export function requestOperation(request) {
  const path = request.path
  const method = request.method
  if (path.endsWith('/llm/chat')) {
    const messages = Array.isArray(request.body?.messages) ? request.body.messages : []
    return { category: 'chat', action: '使用 Chat 助手', details: { messageCount: messages.length, hasImage: messages.some((item) => item?.image) } }
  }
  const auth = { '/api/auth/register': '注册账号', '/api/auth/login': '登录', '/api/auth/logout': '退出登录', '/api/auth/profile': '修改个人名字' }
  if (auth[path]) return { category: 'account', action: auth[path], details: path.endsWith('/profile') ? { before: { displayName: request.user?.displayName }, after: { displayName: request.body?.displayName } } : {} }
  if (path.includes('/qq/')) return { category: 'binding', action: method === 'DELETE' ? '解除 QQ 绑定' : path.endsWith('bind-code') ? '生成 QQ 私聊绑定码' : '申请 QQ 群绑定', details: { scope: request.query?.scope } }
  if (path.includes('/tasks')) return { category: 'task', action: path.endsWith('/action') ? '修改任务' : '创建任务', details: request.body }
  if (path.includes('/expenses')) return { category: 'ledger', action: method === 'DELETE' ? '删除账单' : method === 'PATCH' ? '编辑账单' : '新增账单' }
  return { category: 'group', action: '群组操作', details: request.body }
}

export function auditMiddleware(pool) {
  return (request, response, next) => {
    // Mutations and Chat calls are logged; automatic polling is not an operation.
    if (['GET','HEAD','OPTIONS'].includes(request.method) || request.path.endsWith('/activity/view')) return next()
    response.once('finish', () => {
      if (!request.user || (request.auditRecorded && response.statusCode < 400)) return
      const operation = requestOperation(request)
      const failed = response.statusCode >= 400
      // Failed requests are personal, so attempts against another group cannot pollute its history.
      writeAudit(pool, { actorId: request.user.id, actorName: request.user.displayName,
        groupId: failed ? null : request.group?.id, groupName: failed ? '' : request.group?.name,
        source: auditSource(request), ...operation, outcome: failed ? 'failed' : 'success',
        details: { ...operation.details, httpStatus: response.statusCode } }).catch((error) => console.error('Audit recording failed:', error.message))
    })
    next()
  }
}

export function auditQuery(query, groupId, userId) {
  const mine = query.scope === 'mine'
  if (query.scope && !['mine','group'].includes(query.scope)) throw new GroupError(400, '操作记录范围无效。')
  const conditions = [mine ? 'actor_id=?' : 'group_id=?']
  const parameters = [mine ? userId : groupId]
  if (query.actor) {
    if (!/^\d+$/.test(query.actor) || !Number.isSafeInteger(Number(query.actor))) throw new GroupError(400, '操作人无效。')
    conditions.push('actor_id=?'); parameters.push(Number(query.actor))
  }
  if (query.category) {
    if (!['ledger','group','task','binding','account','chat','view'].includes(query.category)) throw new GroupError(400, '操作类型无效。')
    conditions.push('category=?'); parameters.push(query.category)
  }
  for (const [key, operator] of [['from','>='], ['to','<']]) {
    if (!query[key]) continue
    const date = new Date(`${query[key]}T00:00:00+08:00`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || Number.isNaN(date.valueOf()) || new Date(date.valueOf() + 8 * 3600000).toISOString().slice(0,10) !== query[key]) throw new GroupError(400, '日期格式无效。')
    if (key === 'to') date.setUTCDate(date.getUTCDate() + 1)
    conditions.push(`created_at ${operator} ?`); parameters.push(date.toISOString().slice(0,19).replace('T',' '))
  }
  if (query.before) {
    if (!/^\d{1,20}$/.test(query.before)) throw new GroupError(400, '分页参数无效。')
    conditions.push('id < ?'); parameters.push(query.before)
  }
  return { conditions, parameters, mine }
}

export function registerAuditRoutes(app, { pool, requireAuth, requireGroupMember }) {
  app.get('/api/groups/:groupId/activity', requireAuth, requireGroupMember, async (request, response) => {
    if (request.group.role !== 'owner') throw new GroupError(403, '只有群组创建者可以查看操作记录。')
    const pageSize = Number(request.query.pageSize || 20)
    const requestedPage = Number(request.query.page || 1)
    if (![5,10,20,50].includes(pageSize) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) throw new GroupError(400, '分页参数无效。')
    const { conditions, parameters, mine } = auditQuery(request.query, request.group.id, request.user.id)
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS total FROM audit_logs WHERE ${conditions.join(' AND ')}`, parameters)
    const total = Number(count.total)
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)))
    const [rows] = await pool.execute(`SELECT CAST(id AS CHAR) AS id,group_id,group_name,actor_id,actor_name,category,action,entity_id,source,outcome,details,
      DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.000Z') AS created_at FROM audit_logs
      WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, parameters)
    const [actors] = await pool.execute(`SELECT actor_id AS id, MAX(actor_name) AS name FROM audit_logs
      WHERE ${mine ? 'actor_id' : 'group_id'}=? AND actor_id IS NOT NULL GROUP BY actor_id ORDER BY name`, [mine ? request.user.id : request.group.id])
    const items = rows.map((row) => ({ id: String(row.id), groupId: row.group_id, groupName: row.group_name,
      actorId: row.actor_id, actorName: row.actor_name, category: row.category, action: row.action, entityId: row.entity_id,
      source: row.source, outcome: row.outcome, createdAt: row.created_at, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details }))
    response.set('Cache-Control','no-store').json({ items, actors, page, pageSize, total })
  })
  app.post('/api/groups/:groupId/activity/view', requireAuth, requireGroupMember, async (request, response) => {
    const page = { ledger: '账本', tasks: '任务', chat: 'Chat', activity: '操作记录' }[request.body?.page]
    if (!page) throw new GroupError(400, '页面无效。')
    await auditRequest(pool, request, { category: 'view', action: `查看${page}页面`, details: { page } })
    response.json({ ok: true })
  })
  app.post('/api/groups/:groupId/activity/action', requireAuth, requireGroupMember, async (request, response) => {
    const action = { 'clear-chat': '清空 Chat 对话', 'cancel-ledger-draft': '取消账单草稿', 'cancel-task-draft': '取消任务草稿' }[request.body?.action]
    if (!action) throw new GroupError(400, '操作无效。')
    await auditRequest(pool, request, { category: 'chat', action })
    response.json({ ok: true })
  })
}
