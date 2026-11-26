const dayMs = 86400000
const offset = 8 * 3600000

export function normalizeRecurrence(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('重复规则无效。')
  if (value.type === 'interval') {
    const every = Number(value.every)
    if (!['minute', 'hour', 'day'].includes(value.unit) || !Number.isSafeInteger(every) || every < 1 || every > 100000) throw new Error('重复间隔必须是正整数，最短1分钟。')
    return { type:'interval', unit:value.unit, every }
  }
  if (!['weekly','monthly'].includes(value.type) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time || '')) throw new Error('请设置有效的重复日期和时间。')
  const key = value.type === 'weekly' ? 'weekdays' : 'days'
  const max = value.type === 'weekly' ? 7 : 31
  if (!Array.isArray(value[key]) || !value[key].length || value[key].length > max || value[key].some((day) => !Number.isInteger(day) || day < 1 || day > max)) throw new Error('请选择有效的重复日期。')
  return { type:value.type, [key]:[...new Set(value[key])].sort((a,b)=>a-b), time:value.time }
}

export function readRecurrence(value) {
  return typeof value === 'string' ? JSON.parse(value) : value || null
}

// Intervals retain the original anchor; calendar schedules use Hong Kong time.
// After downtime only one overdue occurrence is emitted, then future dates resume.
export function nextOccurrence(rule, anchor, after = new Date()) {
  const start = new Date(anchor).valueOf()
  const cutoff = new Date(after).valueOf()
  if (!Number.isFinite(start) || !Number.isFinite(cutoff)) throw new Error('重复任务时间无效。')
  if (rule.type === 'interval') {
    const step = rule.every * ({minute:60000,hour:3600000,day:dayMs}[rule.unit])
    return new Date(start + Math.max(1, Math.floor((cutoff-start)/step)+1)*step).toISOString()
  }
  const local = new Date(Math.max(start,cutoff) + offset)
  const midnight = Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())
  const [hour,minute] = rule.time.split(':').map(Number)
  for (let days=0; days<740; days++) {
    const date = new Date(midnight + days*dayMs)
    const matches = rule.type === 'weekly' ? rule.weekdays.includes(date.getUTCDay() || 7) : rule.days.includes(date.getUTCDate())
    const candidate = date.valueOf()+hour*3600000+minute*60000-offset
    if (matches && candidate >= start && candidate > cutoff) return new Date(candidate).toISOString()
  }
  throw new Error('无法计算下一次执行时间。')
}

export function recurrenceLabel(rule) {
  if (!rule) return '不重复'
  if (rule.type === 'interval') return `每隔${rule.every}${{minute:'分钟',hour:'小时',day:'天'}[rule.unit]}`
  if (rule.type === 'weekly') return `每周${rule.weekdays.map((day)=>'一二三四五六日'[day-1]).join('、')} ${rule.time}`
  return `每月${rule.days.join('、')}号 ${rule.time}`
}
