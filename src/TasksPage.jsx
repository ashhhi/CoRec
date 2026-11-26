import React, { useEffect, useRef, useState } from 'react'
import { Bell, Check, CheckSquare, Clock, Plus, RefreshCw, X } from 'lucide-react'
import { taskApi, formatTaskTime, hongKongInputTime, taskKindLabels, taskStatusLabels } from './tasksApi.js'

export default function TasksPage({ groupId, groupName, members, user, role }) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('active')
  const [mine, setMine] = useState(false)
  const [editor, setEditor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [groupBound, setGroupBound] = useState(true)
  const [revision, setRevision] = useState(0)
  const requestId = useRef('')

  useEffect(() => {
    let current = true
    let refreshing = false
    async function refresh() {
      if (refreshing) return
      refreshing = true
      try {
        const data = await taskApi(groupId)
        if (current) { setTasks(data.tasks); setGroupBound(data.groupBound); setError('') }
      } catch (error) { if (current) setError(error.message) } finally { refreshing = false; if (current) setLoading(false) }
    }
    refresh()
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, 10000)
    window.addEventListener('focus', refresh)
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [groupId, revision])

  useEffect(() => {
    if (!editor) return
    const keydown = (event) => { if (event.key === 'Escape' && !busy) setEditor(null) }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [editor, busy])

  const activeCount = tasks.filter((task) => !['completed','cancelled'].includes(task.status)).length
  const visible = tasks.filter((task) => (!mine || task.assigneeId === user.id) && (filter === 'all' || filter === 'active' && !['completed','cancelled'].includes(task.status) || task.status === filter))
  const canEdit = (task) => ['owner','admin'].includes(role) || task.createdBy === user.id || task.assigneeId === user.id

  async function action(task, body) {
    setBusy(true)
    setError('')
    try { await taskApi(groupId, '/action', { method:'POST', body: { id:task.id, ...body } }); setRevision((value) => value + 1) }
    catch (error) { setError(error.message) } finally { setBusy(false) }
  }

  function openEditor(task) {
    requestId.current = crypto.randomUUID()
    setEditor(task ? { ...task, reschedule:true } : { kind:'reminder', target:'group', title:'',details:'',assigneeId:user.id,dueAt:'' })
  }

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const dueAt = form.get('dueAt') ? `${form.get('dueAt')}:00+08:00` : null
    try {
      if (editor.reschedule) await taskApi(groupId, '/action', { method:'POST', body: { id:editor.id, action:'reschedule', dueAt } })
      else await taskApi(groupId, '', { method:'POST', body: { title:form.get('title'),details:form.get('details'),assigneeId:Number(form.get('assigneeId')),kind:editor.kind,target:editor.target,dueAt,requestId:requestId.current } })
      setEditor(null)
      setRevision((value) => value + 1)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }

  return <section className="tasks-page">
    <header className="tasks-header"><div><p className="eyebrow">COREC TASKS</p><h1>任务</h1><p>{groupName} · {activeCount} 项待处理</p></div><button type="button" className="primary-button" onClick={() => openEditor()}><Plus size={16} />新建任务</button></header>
    <div className="task-intro"><Bell size={17} /><p>在 Chat 里说“明天下午3点提醒我交水电费”，或“今晚8点汇总本月收支”。提醒等待你确认完成，自动任务执行后记录结果。时间均为香港时间（UTC+8）。</p></div>
    {!groupBound && <div className="error-banner">本账本尚未绑定 QQ 群。可先记录无定时的待办，绑定 QQ 群后再安排提醒，或选择已绑定的 QQ 私聊。</div>}
    {!editor && error && <div className="error-banner" role="alert">{error}</div>}
    <div className="task-toolbar"><div className="filter-tabs" role="group" aria-label="任务状态">{[['active','待处理'],['all','全部'],['completed','已完成'],['cancelled','已取消']].map(([value,label]) => <button key={value} type="button" className="filter-tab" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="task-mine"><input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />只看我的</label><button type="button" className="icon-button" aria-label="刷新任务" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button></div>
    <div className="task-list">
      {loading ? <div className="empty-state">正在读取任务…</div> : !visible.length ? <div className="empty-state"><CheckSquare size={28} /><p>这里还没有符合条件的任务</p><div>点击新建任务，或在 Chat 中安排提醒</div></div> : visible.map((task) => <article className={`task-card status-${task.status}`} key={task.id}>
        <div className="task-card-heading"><span className="task-number">#{task.id}</span><h2>{task.title}</h2><span className={`task-status ${task.status}`}>{taskStatusLabels[task.status]}</span></div>
        <div className="task-meta"><span>{taskKindLabels[task.kind]}</span><span>负责人：{task.assigneeName}</span><span>{task.target === 'group' ? 'QQ 群提醒' : 'QQ 私聊提醒'}</span></div>
        <p className="task-due"><Clock size={14} />{formatTaskTime(task.dueAt)}</p>
        {task.details && <p className="task-details">{task.details}</p>}
        {task.result && <div className="task-result"><strong>执行结果</strong><p>{task.result}</p></div>}
        {task.error && <p className="task-error">执行失败：{task.error}</p>}
        {task.deliveryStatus !== 'none' && <p className={`task-delivery ${task.deliveryStatus}`}>{task.deliveryStatus === 'sent' ? `已发送 · ${formatTaskTime(task.deliveredAt)}` : task.deliveryStatus === 'failed' ? `发送失败：${task.deliveryError}` : task.deliveryStatus === 'sending' ? '正在发送通知…' : task.deliveryError ? `发送未成功，正在重试：${task.deliveryError}` : '通知等待发送'}</p>}
        {canEdit(task) && <div className="task-actions">
          {!['completed','cancelled','running'].includes(task.status) && <><button type="button" disabled={busy} onClick={() => action(task,{status:'completed'})}><Check size={14} />标记完成</button><button type="button" disabled={busy} onClick={() => openEditor(task)}>重新安排</button><button type="button" disabled={busy} onClick={() => action(task,{status:'cancelled'})}>取消任务</button></>}
          {task.status === 'running' && <button type="button" disabled={busy} onClick={() => action(task,{status:'cancelled'})}>取消任务</button>}
          {task.deliveryStatus === 'failed' && !['cancelled'].includes(task.status) && <button type="button" disabled={busy} onClick={() => action(task,{action:'retry-delivery'})}>重试通知</button>}
        </div>}
      </article>)}
    </div>
    {editor && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditor(null) }}><section className="expense-modal task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title">
      <div className="modal-head"><h2 id="task-editor-title">{editor.reschedule ? '重新安排任务' : '新建任务'}</h2><button type="button" className="close-button" disabled={busy} aria-label="关闭" onClick={() => setEditor(null)}><X size={19} /></button></div>
      <form className="account-form" onSubmit={submit}>
        {!editor.reschedule && <><label><span>任务名称</span><input name="title" maxLength="160" placeholder="例如：交水电费" autoFocus required /></label><label><span>任务类型</span><select value={editor.kind} onChange={(event) => setEditor({...editor,kind:event.target.value})}>{Object.entries(taskKindLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><p className="group-help">{editor.kind === 'reminder' ? '到点提醒，完成情况由负责人确认。' : editor.kind === 'ledger_summary' ? '到点自动汇总本月截至当天的账本收支，并发送结果。' : '到点生成指定文字、计划或清单，不执行外部操作。'}</p><label><span>详情</span><textarea name="details" rows={3} maxLength="2000" placeholder="补充说明或自动生成内容的要求" /></label><div className="form-grid"><label><span>负责人</span><select name="assigneeId" defaultValue={user.id}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label><span>通知位置</span><select value={editor.target} onChange={(event) => setEditor({...editor,target:event.target.value})}><option value="group">当前账本的 QQ 群</option><option value="private">负责人的 QQ 私聊</option></select></label></div></>}
        <label><span>{editor.kind === 'reminder' ? '提醒时间' : '执行时间'}（香港时间）</span><input type="datetime-local" name="dueAt" defaultValue={hongKongInputTime(editor.dueAt)} required={editor.reschedule || editor.kind !== 'reminder'} /></label>
        {!editor.reschedule && editor.kind === 'reminder' && <p className="group-help">不设时间则只记录待办。</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="primary-button account-submit" disabled={busy}>{busy ? '正在保存…' : editor.reschedule ? '保存时间' : '创建任务'}</button>
      </form>
    </section></div>}
  </section>
}
