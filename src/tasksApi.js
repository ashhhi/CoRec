export { recurrenceLabel } from '../server/task-recurrence.js'
export const taskKindLabels = { reminder: '提醒事项', generate_text: '定时生成文字', ledger_summary: '账本收支汇总' }
export const taskStatusLabels = { pending: '待处理', running: '执行中', waiting: '待确认完成', completed: '已完成', failed: '执行失败', cancelled: '已取消' }

export function formatTaskTime(value) {
  return value ? `${new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}（香港时间）` : '未设置提醒'
}

export async function taskApi(groupId, path = '', options = {}) {
  const response = await fetch(`/api/groups/${groupId}/tasks${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...options.headers },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '任务操作失败，请稍后重试。')
  return data
}

export function hongKongInputTime(iso) {
  return iso ? new Date(new Date(iso).valueOf() + 8 * 3600000).toISOString().slice(0,16) : ''
}
