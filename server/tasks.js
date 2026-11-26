import { randomUUID } from 'node:crypto'
import { GroupError, managesGroup } from './groups.js'
import { getGroupBinding } from './qq-group.js'
import { normalizeRecurrence, readRecurrence, nextOccurrence } from './task-recurrence.js'

export async function ensureTaskSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL,
    created_by INT UNSIGNED NOT NULL, assignee_id INT UNSIGNED NOT NULL,
    title VARCHAR(160) NOT NULL, details TEXT NOT NULL,
    kind ENUM('reminder','generate_text','ledger_summary') NOT NULL DEFAULT 'reminder',
    status ENUM('pending','running','waiting','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    due_at DATETIME NULL, target ENUM('group','private') NOT NULL DEFAULT 'group', target_openid VARCHAR(128) NOT NULL DEFAULT '',
    result TEXT NULL, error VARCHAR(500) NULL, request_id VARCHAR(80) NOT NULL,
    delivery_status ENUM('none','pending','sending','sent','failed') NOT NULL DEFAULT 'none',
    delivery_error VARCHAR(500) NULL, delivery_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    delivery_after DATETIME NULL, delivered_at DATETIME NULL,
    lease_token VARCHAR(36) NULL, lease_until DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    recurrence JSON NULL, series_id INT UNSIGNED NULL,
    UNIQUE KEY task_request_idx (group_id, created_by, request_id),
    INDEX task_due_idx (status, due_at), INDEX task_delivery_idx (delivery_status, delivery_after),
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES accounts(id), FOREIGN KEY (assignee_id) REFERENCES accounts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  const [columns] = await pool.query('SHOW COLUMNS FROM tasks')
  if (!columns.some((column)=>column.Field === 'recurrence')) await pool.query('ALTER TABLE tasks ADD COLUMN recurrence JSON NULL')
  if (!columns.some((column)=>column.Field === 'series_id')) await pool.query('ALTER TABLE tasks ADD COLUMN series_id INT UNSIGNED NULL')
}

const utc = (value) => value ? `${String(value).replace(' ', 'T')}Z` : null
const sqlDate = (value) => new Date(value).toISOString().slice(0, 19).replace('T', ' ')
const validId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
export function serializeTask(row) {
  return { id: row.id, title: row.title, details: row.details, kind: row.kind, status: row.status,
    createdBy: row.created_by, assigneeId: row.assignee_id, assigneeName: row.assignee_name,
    dueAt: utc(row.due_at), recurrence: readRecurrence(row.recurrence), seriesId: row.series_id || null, target: row.target, result: row.result, error: row.error,
    deliveryStatus: row.delivery_status, deliveryError: row.delivery_error, deliveredAt: utc(row.delivered_at),
    createdAt: utc(row.created_at), completedAt: utc(row.completed_at) }
}

export function validateTask(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const details = typeof body.details === 'string' ? body.details.trim() : ''
  const kind = body.kind || 'reminder'
  const target = body.target || 'group'
  if (!title || title.length > 160 || details.length > 2000) throw new GroupError(400, '标题需为1–160字，详情不超过2000字。')
  if (!['reminder', 'generate_text', 'ledger_summary'].includes(kind) || !['group', 'private'].includes(target)) throw new GroupError(400, '任务类型或提醒位置无效。')
  let dueAt = null
  if (body.dueAt != null && body.dueAt !== '') {
    const match = typeof body.dueAt === 'string' && /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(body.dueAt)
    if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) throw new GroupError(400, '请提供带时区的完整提醒时间。')
    const parsed = new Date(body.dueAt)
    const datePart = body.dueAt.slice(0, 10)
    const calendarDate = new Date(`${datePart}T00:00:00Z`)
    if (!Number.isFinite(parsed.valueOf()) || !Number.isFinite(calendarDate.valueOf()) || calendarDate.toISOString().slice(0, 10) !== datePart || parsed.valueOf() <= Date.now()) throw new GroupError(400, '提醒时间必须是有效的未来时间。')
    dueAt = sqlDate(parsed)
  }
  if (kind !== 'reminder' && !dueAt) throw new GroupError(400, '自动任务需要设置执行时间。')
  let recurrence
  try { recurrence = normalizeRecurrence(body.recurrence) } catch (error) { throw new GroupError(400,error.message) }
  if (recurrence && !dueAt) throw new GroupError(400,'重复任务需要设置首次执行时间。')
  if (recurrence && recurrence.type !== 'interval') dueAt = sqlDate(nextOccurrence(recurrence,utc(dueAt),new Date(new Date(utc(dueAt)).valueOf()-1)))
  const requestId = body.requestId || randomUUID()
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new GroupError(400, '任务请求编号无效。')
  return { title, details, kind, target, dueAt, requestId, recurrence }
}

async function transaction(pool, run) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const result = await run(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

async function lockMember(connection, groupId, userId, qqGroup) {
  const [[group]] = await connection.execute('SELECT id FROM ledger_groups WHERE id = ? FOR UPDATE', [groupId])
  const [[member]] = await connection.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])
  if (!group || !member) throw new GroupError(403, '你已离开群组或群组已解散。')
  if (qqGroup) {
    const binding = await getGroupBinding(connection, qqGroup.groupOpenid, qqGroup.memberOpenid)
    if (binding?.group_id !== groupId || binding.user_id !== userId) throw new GroupError(403, 'QQ 群绑定已失效。')
  }
  return member.role
}

async function destination(connection, groupId, assigneeId, target) {
  const [[row]] = target === 'group'
    ? await connection.execute('SELECT group_openid AS openid FROM qq_group_links WHERE group_id = ?', [groupId])
    : await connection.execute('SELECT openid FROM qq_bindings WHERE group_id = ? AND user_id = ?', [groupId, assigneeId])
  return row?.openid || ''
}

export async function createTask(pool, groupId, userId, body, qqGroup) {
  const requestId = body.requestId || randomUUID()
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new GroupError(400, '任务请求编号无效。')
  const assigneeId = body.assigneeId == null ? userId : Number(body.assigneeId)
  if (!validId(assigneeId)) throw new GroupError(400, '请选择任务负责人。')
  return transaction(pool, async (connection) => {
    await lockMember(connection, groupId, userId, qqGroup)
    const [[existing]] = await connection.execute('SELECT * FROM tasks WHERE group_id = ? AND created_by = ? AND request_id = ?', [groupId, userId, requestId])
    if (existing) return serializeTask(existing)
    const task = validateTask({ ...body, requestId })
    const [[assignee]] = await connection.execute('SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, assigneeId])
    if (!assignee) throw new GroupError(400, '负责人必须是当前群组成员。')
    const openid = await destination(connection, groupId, assigneeId, task.target)
    if (task.dueAt && !openid) throw new GroupError(400, task.target === 'group' ? '请先绑定本账本的 QQ 群，再设置群提醒。' : '负责人需先为本账本绑定 QQ 私聊。')
    const [result] = await connection.execute(`INSERT INTO tasks
      (group_id,created_by,assignee_id,title,details,kind,due_at,target,target_openid,request_id,recurrence) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [groupId, userId, assigneeId, task.title, task.details, task.kind, task.dueAt, task.target, openid, task.requestId, task.recurrence ? JSON.stringify(task.recurrence) : null])
    const [[row]] = await connection.execute('SELECT * FROM tasks WHERE id = ?', [result.insertId])
    return serializeTask(row)
  })
}

export async function updateTask(pool, groupId, userId, id, body, qqGroup) {
  if (!validId(id)) throw new GroupError(400, '任务编号无效。')
  return transaction(pool, async (connection) => {
    const role = await lockMember(connection, groupId, userId, qqGroup)
    const [[task]] = await connection.execute('SELECT * FROM tasks WHERE id = ? AND group_id = ? FOR UPDATE', [id, groupId])
    if (!task) throw new GroupError(404, '找不到该任务。')
    if (![task.created_by, task.assignee_id].includes(userId) && !managesGroup(role)) throw new GroupError(403, '只有创建人、负责人、群主或管理员可修改任务。')
    if (body.action === 'retry-delivery') {
      if (task.delivery_status !== 'failed') throw new GroupError(409, '只有发送失败的通知可以重试。')
      const current = await destination(connection, groupId, task.assignee_id, task.target)
      if (!current) throw new GroupError(400, '请先恢复 QQ 绑定。')
      // Explicit retry authorizes delivery to the currently linked conversation.
      await connection.execute("UPDATE tasks SET target_openid=?, delivery_status='pending',delivery_attempts=0,delivery_after=UTC_TIMESTAMP(),delivery_error=NULL WHERE id=?", [current, id])
    } else if (['completed', 'cancelled'].includes(body.status)) {
      if (task.recurrence && body.status === 'completed') throw new GroupError(400,'请完成具体执行记录；停止整个重复计划请取消任务。')
      if ((task.status === 'running' && body.status !== 'cancelled') || task.delivery_status === 'sending') throw new GroupError(409, '任务正在处理，请稍后操作。')
      await connection.execute(`UPDATE tasks SET status=?,completed_at=?,delivery_status=IF(delivery_status='sent','sent','none'),
        lease_token=NULL,lease_until=NULL WHERE id=?`, [body.status, body.status === 'completed' ? sqlDate(new Date()) : null, id])
      if (task.recurrence && body.status === 'cancelled') {
        await connection.execute(`UPDATE tasks SET status='cancelled',delivery_status='none',lease_token=NULL,lease_until=NULL
          WHERE series_id=? AND status NOT IN ('completed','cancelled') AND delivery_status<>'sending'`,[id])
      }
    } else if (body.action === 'reschedule') {
      if (!['pending', 'waiting', 'failed'].includes(task.status) || task.delivery_status === 'sending') throw new GroupError(409, '该任务当前不能改期。')
      const validated = validateTask({ ...task, recurrence: body.recurrence === undefined ? readRecurrence(task.recurrence) : body.recurrence, dueAt: body.dueAt, requestId: task.request_id })
      if (!validated.dueAt) throw new GroupError(400, '请设置新的提醒时间。')
      const current = await destination(connection, groupId, task.assignee_id, task.target)
      if (!current) throw new GroupError(400, '请先恢复 QQ 绑定。')
      await connection.execute(`UPDATE tasks SET due_at=?,target_openid=?,status='pending',result=NULL,error=NULL,
        delivery_status='none',delivery_error=NULL,delivery_attempts=0,delivered_at=NULL,completed_at=NULL,recurrence=? WHERE id=?`, [validated.dueAt, current, validated.recurrence ? JSON.stringify(validated.recurrence) : null, id])
    } else throw new GroupError(400, '任务操作无效。')
    const [[row]] = await connection.execute('SELECT * FROM tasks WHERE id=?', [id])
    return serializeTask(row)
  })
}

export function registerTaskRoutes(app, { pool, requireAuth, requireGroupMember }) {
  app.get('/api/groups/:groupId/tasks', requireAuth, requireGroupMember, async (request, response) => {
    const [rows] = await pool.execute(`SELECT t.*,a.display_name AS assignee_name FROM tasks t JOIN accounts a ON a.id=t.assignee_id
      WHERE t.group_id=? ORDER BY (t.recurrence IS NOT NULL AND t.status<>'cancelled') DESC,t.created_at DESC,t.id DESC LIMIT 500`, [request.group.id])
    const [[binding]] = await pool.execute('SELECT group_id FROM qq_group_links WHERE group_id=?', [request.group.id])
    response.set('Cache-Control','no-store').json({ tasks: rows.map(serializeTask), groupBound: Boolean(binding) })
  })
  app.post('/api/groups/:groupId/tasks', requireAuth, requireGroupMember, async (request, response) => {
    response.status(201).json({ task: await createTask(pool, request.group.id, request.user.id, request.body || {}, request.qqGroup) })
  })
  app.post('/api/groups/:groupId/tasks/action', requireAuth, requireGroupMember, async (request, response) => {
    response.json({ task: await updateTask(pool, request.group.id, request.user.id, request.body?.id, request.body || {}, request.qqGroup) })
  })
}

async function eligible(connection, task) {
  if (task.series_id) {
    const [[series]]=await connection.execute('SELECT status FROM tasks WHERE id=?',[task.series_id])
    if (!series || series.status === 'cancelled') throw new Error('重复计划已停止。')
  }
  const [members] = await connection.execute('SELECT user_id FROM group_members WHERE group_id=? AND user_id IN (?,?)', [task.group_id, task.created_by, task.assignee_id])
  if (![task.created_by, task.assignee_id].every((id) => members.some((member) => member.user_id === id))) throw new Error('创建人或负责人已离开群组，任务停止。')
  const current = await destination(connection, task.group_id, task.assignee_id, task.target)
  if (!current || current !== task.target_openid) throw new Error('QQ 绑定已变更，请在任务页面确认绑定后重试或重新安排。')
}

async function claim(pool, delivery) {
  return transaction(pool, async (connection) => {
    const condition = delivery
      ? "((delivery_status='pending' AND delivery_after<=UTC_TIMESTAMP()) OR (delivery_status='sending' AND lease_until<UTC_TIMESTAMP()))"
      : "due_at<=UTC_TIMESTAMP() AND (status='pending' OR (status='running' AND lease_until<UTC_TIMESTAMP()))"
    const [[task]] = await connection.execute(`SELECT * FROM tasks WHERE ${condition} ORDER BY id LIMIT 1 FOR UPDATE`)
    if (!task) return null
    const token = randomUUID()
    await connection.execute(`UPDATE tasks SET ${delivery ? "delivery_status='sending',delivery_attempts=delivery_attempts+1" : "status='running'"},
      lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 MINUTE) WHERE id=?`, [token, task.id])
    return { ...task, lease_token: token, delivery_attempts: task.delivery_attempts + (delivery ? 1 : 0) }
  })
}

export async function processDueTask(pool, { generate }) {
  const task = await claim(pool, false)
  if (!task) return false
  try {
    await eligible(pool, task)
    if (task.recurrence) {
      await transaction(pool,async(connection)=>{
        await lockMember(connection,task.group_id,task.created_by)
        const [[current]]=await connection.execute('SELECT lease_token,status FROM tasks WHERE id=? FOR UPDATE',[task.id])
        if (current?.lease_token !== task.lease_token || current.status !== 'running') return
        const rule=readRecurrence(task.recurrence)
        const next=sqlDate(nextOccurrence(rule,utc(task.due_at)))
        await connection.execute(`INSERT INTO tasks (group_id,created_by,assignee_id,title,details,kind,due_at,target,target_openid,request_id,series_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
        [task.group_id,task.created_by,task.assignee_id,task.title,task.details,task.kind,task.due_at,task.target,task.target_openid,`repeat-${task.id}-${new Date(utc(task.due_at)).valueOf()}`,task.id])
        await connection.execute("UPDATE tasks SET status='pending',due_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",[next,task.id,task.lease_token])
      })
      return true
    }
    let result = null
    if (task.kind === 'generate_text') {
      result = await generate([
        { role: 'system', content: '你是定时任务助手，只生成用户要求的中文文字、计划或清单，不可执行外部操作，不可声称完成现实事项。回复不超过1500字。' },
        { role: 'user', content: `${task.title}\n${task.details}` },
      ])
    } else if (task.kind === 'ledger_summary') {
      const [rows] = await pool.execute(`SELECT entry_type,category,COUNT(*) AS count,SUM(amount_cents) AS cents FROM expenses
        WHERE group_id=? AND date BETWEEN DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00'),'%Y-%m-01')
        AND DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00')) GROUP BY entry_type,category ORDER BY entry_type,category`, [task.group_id])
      const lines = rows.map((row) => `${row.entry_type === 'income' ? '收入' : '支出'} · ${row.category}：¥${(Number(row.cents)/100).toFixed(2)}（${row.count}笔）`)
      result = `本月截至当前的账本收支汇总：\n${lines.join('\n') || '暂无账单。'}`
    }
    if (task.kind !== 'reminder' && (typeof result !== 'string' || !result.trim())) throw new Error('自动任务未返回结果。')
    await eligible(pool, task)
    await pool.execute(`UPDATE tasks SET status=?,result=?,completed_at=?,error=NULL,delivery_status='pending',delivery_after=UTC_TIMESTAMP(),
      lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`,
    [task.kind === 'reminder' ? 'waiting' : 'completed', result?.slice(0,12000) || null, task.kind === 'reminder' ? null : sqlDate(new Date()), task.id, task.lease_token])
  } catch (error) {
    await pool.execute("UPDATE tasks SET status='failed',error=?,delivery_status='pending',delivery_after=UTC_TIMESTAMP(),lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?", [error.message.slice(0,500), task.id, task.lease_token])
  }
  return true
}

export async function deliverTask(pool, { send }) {
  const task = await claim(pool, true)
  if (!task) return false
  try {
    await transaction(pool, async (connection) => {
      await lockMember(connection, task.group_id, task.created_by)
      await eligible(connection, task)
      const [[person]] = await connection.execute('SELECT display_name FROM accounts WHERE id=?', [task.assignee_id])
      const content = task.status === 'failed' ? `${person.display_name}，任务执行失败 #${task.id}\n${task.title}\n${task.error}\n请在任务页面重新安排。` : task.kind === 'reminder'
        ? `${person.display_name}，任务提醒 #${task.id}\n${task.title}\n${task.details}\n完成后请回复「完成任务 ${task.id}」，或在任务页面标记完成。`
        : `${person.display_name}，自动任务已完成 #${task.id}\n${task.title}\n${task.result}`
      await send(task, content.length > 1850 ? `${content.slice(0,1800)}\n（完整内容请查看任务页面）` : content)
      await connection.execute("UPDATE tasks SET delivery_status='sent',delivery_error=NULL,delivered_at=UTC_TIMESTAMP(),lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?", [task.id, task.lease_token])
    })
  } catch (error) {
    const retry = task.delivery_attempts < 3
    await pool.execute(`UPDATE tasks SET delivery_status=?,delivery_error=?,delivery_after=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 MINUTE),
      lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?`, [retry ? 'pending' : 'failed', error.message.slice(0,500), task.id, task.lease_token])
  }
  return true
}

export function startTaskWorker(pool, dependencies) {
  let stopped = false
  const executions = new Set()
  let delivery = null
  const tick = () => {
    if (stopped) return
    // Keep notifications independent from slow text generation.
    while (executions.size < 2) {
      const work = processDueTask(pool, dependencies).catch((error) => console.error('Task execution failed:', error.message)).finally(() => executions.delete(work))
      executions.add(work)
    }
    if (!delivery) delivery = (async () => {
      for (let i=0; i<3 && !stopped; i++) if (!await deliverTask(pool, dependencies)) break
    })().catch((error) => console.error('Task delivery failed:', error.message)).finally(() => { delivery = null })
  }
  const timer = setInterval(tick, 10000)
  tick()
  return async () => { stopped = true; clearInterval(timer); await Promise.allSettled([...executions, delivery]) }
}
