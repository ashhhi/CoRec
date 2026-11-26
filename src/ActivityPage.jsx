import React, { useEffect, useRef, useState } from 'react'
import { History, RefreshCw } from 'lucide-react'

const categories = { ledger: '账单', group: '群组', task: '任务', binding: 'QQ 绑定', account: '账号', chat: 'Chat', view: '页面访问' }
const sources = { web: '网页', chat: 'Chat', 'qq-group': 'QQ 群', 'qq-private': 'QQ 私聊', system: '系统' }
const labels = { type:'类型', transferDirection:'转账方向', date:'日期', time:'时间', merchant:'商家', productName:'商品', note:'备注', category:'分类', amount:'金额', savingsAmount:'其中存入存款', payerId:'归属成员编号', payer:'归属成员',
  title:'任务名称', details:'内容', kind:'任务类型', status:'状态', createdBy:'创建人编号', assigneeId:'负责人编号', assigneeName:'负责人', dueAt:'执行时间', recurrence:'重复规则', seriesId:'重复计划编号', target:'通知位置', deliveryStatus:'通知状态', deliveredAt:'发送时间', completedAt:'完成时间',
  name:'群组名称', displayName:'显示名字', role:'角色', userId:'成员编号', username:'账号', action:'操作', page:'页面', scope:'范围', deletedCount:'删除账单数量', count:'数量', targetName:'目标成员', targetUserId:'目标成员编号', groupName:'群组', unit:'单位', every:'间隔', weekdays:'星期', days:'日期', messageCount:'对话条数', hasImage:'包含图片', httpStatus:'响应状态', id:'编号' }
const values = { expense:'支出', income:'收入', transfer:'转账', to_savings:'活动账户 → 存款账户', from_savings:'存款账户 → 活动账户', owner:'创建者', admin:'管理员', member:'普通成员', group:'群组', private:'私聊', reminder:'提醒', generate_text:'生成文字', ledger_summary:'收支汇总', pending:'待处理', running:'执行中', waiting:'待确认', completed:'已完成', failed:'失败', cancelled:'已取消', none:'无', sent:'已发送', sending:'发送中' }

function displayValue(key, value) {
  if (value == null || value === '') return '未填写'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (key === 'amount' || key === 'savingsAmount') return `¥${Number(value).toFixed(2)}`
  if (['dueAt','deliveredAt','completedAt'].includes(key)) return new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Hong_Kong', hour12:false })
  if (typeof value === 'object') return JSON.stringify(value)
  return values[value] || String(value)
}

function OperationDetails({ details = {}, members }) {
  const before = details.before || {}
  const after = details.after || {}
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  const metadata = Object.entries(details).filter(([key]) => !['before','after','changes'].includes(key))
  function value(key, item) {
    if (['payerId','assigneeId','createdBy','userId','targetUserId'].includes(key) && item != null) {
      const person = members.find((member) => member.id === item)
      if (person) return `${person.displayName} (#${item})`
    }
    return displayValue(key, item)
  }
  if (!keys.length && !metadata.length) return <p className="activity-no-detail">操作已记录</p>
  return <dl className="activity-changes">
    {metadata.map(([key, item]) => <div key={key}><dt>{labels[key] || key}</dt><dd>{value(key, item)}</dd></div>)}
    {keys.map((key) => <div key={key}><dt>{labels[key] || key}</dt><dd>{Object.hasOwn(before, key) && <><span className="activity-before">{value(key, before[key])}</span><span className="activity-arrow"> → </span></>}{Object.hasOwn(after, key) ? <span>{value(key, after[key])}</span> : <span>已删除</span>}</dd></div>)}
  </dl>
}

export default function ActivityPage({ groupId, groupName, members }) {
  const [filters, setFilters] = useState({ scope:'group', actor:'', category:'', from:'', to:'' })
  const [items, setItems] = useState([])
  const [actors, setActors] = useState([])
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const requestVersion = useRef(0)
  const controller = useRef(null)

  async function load(before = null) {
    controller.current?.abort()
    const currentController = new AbortController()
    controller.current = currentController
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value))
    if (before) query.set('before', before)
    try {
      const response = await fetch(`/api/groups/${groupId}/activity?${query}`, { signal: currentController.signal })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取操作记录失败。')
      if (version !== requestVersion.current) return
      setItems((previous) => before ? [...previous, ...data.items] : data.items)
      setActors(data.actors)
      setCursor(data.nextCursor)
    } catch (error) {
      if (version === requestVersion.current && error.name !== 'AbortError') setError(error.message)
    } finally { if (version === requestVersion.current) setLoading(false) }
  }

  useEffect(() => {
    setItems([]); setCursor(null)
    load()
    return () => { ++requestVersion.current; controller.current?.abort() }
  }, [groupId, filters, revision])

  const setFilter = (key, value) => setFilters((previous) => ({ ...previous, [key]:value, ...(key === 'scope' ? { actor:'' } : {}) }))
  return <section className="activity-page">
    <header className="page-heading"><div><p className="eyebrow">ACTIVITY HISTORY</p><h1><History size={25} />操作记录</h1><p className="heading-note">{groupName} · 操作时间统一为香港时间</p></div><button type="button" className="icon-button" title="刷新操作记录" aria-label="刷新操作记录" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={18} /></button></header>
    <div className="panel">
      <div className="activity-filters">
        <label><span>范围</span><select value={filters.scope} onChange={(event) => setFilter('scope',event.target.value)}><option value="group">当前群组全部操作</option><option value="mine">我的全部操作</option></select></label>
        <label><span>操作人</span><select value={filters.actor} onChange={(event) => setFilter('actor',event.target.value)}><option value="">全部成员（含系统）</option>{actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.name} (#{actor.id})</option>)}</select></label>
        <label><span>操作类型</span><select value={filters.category} onChange={(event) => setFilter('category',event.target.value)}><option value="">全部类型</option>{Object.entries(categories).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>开始日期</span><input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilter('from',event.target.value)} /></label>
        <label><span>结束日期</span><input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilter('to',event.target.value)} /></label>
      </div>
      <p className="group-help">从启用后开始记录，展开可查看具体变化。“我的全部操作”也包含登录、个人设置及已退出群组的本人操作。</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div aria-busy={loading} className="activity-list">
        {items.map((item) => <details key={item.id} className="activity-item"><summary>
          <span className="activity-person">{item.actorName}<small>{item.actorId ? `#${item.actorId}` : '自动操作'}</small></span>
          <span className="activity-operation"><strong>{item.action}{item.entityId ? ` #${item.entityId}` : ''}</strong><small>{categories[item.category]} · {sources[item.source] || item.source}{filters.scope === 'mine' && item.groupName ? ` · ${item.groupName}` : ''}</small></span>
          <span className={item.outcome === 'failed' ? 'activity-failed' : 'activity-success'}>{item.outcome === 'failed' ? '未成功' : '成功'}</span>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone:'Asia/Hong_Kong', hour12:false })}</time>
        </summary><OperationDetails details={item.details} members={members} /></details>)}
        {!items.length && !loading && !error && <div className="empty-state">暂无符合条件的操作记录</div>}
        {loading && <p className="activity-loading" role="status">正在加载…</p>}
      </div>
      {cursor && <button type="button" className="load-more" disabled={loading} onClick={() => load(cursor)}>加载更早的操作</button>}
    </div>
  </section>
}
