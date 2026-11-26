import React, { useEffect, useRef, useState } from 'react'
import { Bell, Check, CheckSquare, Clock, Plus, RefreshCw, X } from 'lucide-react'
import { taskApi, formatTaskTime, hongKongInputTime, taskKindLabels, taskStatusLabels, recurrenceLabel } from './tasksApi.js'

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
    setEditor(task ? { ...task, reschedule:true } : { kind:'reminder', target:'group', title:'',details:'',assigneeId:user.id,dueAt:'',recurrence:null })
  }

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const dueAt = form.get('dueAt') ? `${form.get('dueAt')}:00+08:00` : null
    const recurrence = editor.recurrence && editor.recurrence.type !== 'interval'
      ? { ...editor.recurrence, time: String(form.get('dueAt') || '').slice(11,16) }
      : editor.recurrence
    try {
      if (editor.reschedule) await taskApi(groupId, '/action', { method:'POST', body: { id:editor.id, action:'reschedule', dueAt, recurrence } })
      else await taskApi(groupId, '', { method:'POST', body: { title:form.get('title'),details:form.get('details'),assigneeId:Number(form.get('assigneeId')),kind:editor.kind,target:editor.target,dueAt,recurrence,requestId:requestId.current } })
      setEditor(null)
      setRevision((value) => value + 1)
    } catch (error) { setError(error.message) } finally { setBusy(false) }
  }

  return <section className="tasks-page">
    <header className="tasks-header"><div><p className="eyebrow">COREC TASKS</p><h1>任务</h1><p>{groupName} · {activeCount} 项待处理</p></div><button type="button" className="primary-button" onClick={() => openEditor()}><Plus size={16} />新建任务</button></header>
    <div className="task-intro"><Bell size={17} /><p>在 Chat 里说“每天7点45叫我起床”“每周一、五下午3点提醒开会”或“每隔30分钟提醒喝水”。支持一次性和重复计划，每次执行单独记录，取消计划可停止后续提醒。时间均为香港时间（UTC+8）。</p></div>
    {!groupBound && <div className="error-banner">本账本尚未绑定 QQ 群。可先记录无定时的待办，绑定 QQ 群后再安排提醒，或选择已绑定的 QQ 私聊。</div>}
    {!editor && error && <div className="error-banner" role="alert">{error}</div>}
    <div className="task-toolbar"><div className="filter-tabs" role="group" aria-label="任务状态">{[['active','待处理'],['all','全部'],['completed','已完成'],['cancelled','已取消']].map(([value,label]) => <button key={value} type="button" className="filter-tab" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><label className="task-mine"><input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />只看我的</label><button type="button" className="icon-button" aria-label="刷新任务" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /></button></div>
    <div className="task-list">
      {loading ? <div className="empty-state">正在读取任务…</div> : !visible.length ? <div className="empty-state"><CheckSquare size={28} /><p>这里还没有符合条件的任务</p><div>点击新建任务，或在 Chat 中安排提醒</div></div> : visible.map((task) => <article className={`task-card status-${task.status}`} key={task.id}>
        <div className="task-card-heading"><span className="task-number">#{task.id}</span><h2>{task.title}</h2><span className={`task-status ${task.status}`}>{taskStatusLabels[task.status]}</span></div>
        <div className="task-meta"><span>{taskKindLabels[task.kind]}</span><span>负责人：{task.assigneeName}</span><span>{task.target === 'group' ? 'QQ 群提醒' : 'QQ 私聊提醒'}</span></div>
        {task.recurrence && <p className="task-details">重复计划 · {recurrenceLabel(task.recurrence)}</p>}
        {task.seriesId && <p className="task-details">重复计划 #{task.seriesId} 的执行记录</p>}
        <p className="task-due"><Clock size={14} />{task.recurrence ? '下次执行：' : ''}{formatTaskTime(task.dueAt)}</p>
        {task.details && <p className="task-details">{task.details}</p>}
        {task.result && <div className="task-result"><strong>执行结果</strong><p>{task.result}</p></div>}
        {task.error && <p className="task-error">执行失败：{task.error}</p>}
        {task.deliveryStatus !== 'none' && <p className={`task-delivery ${task.deliveryStatus}`}>{task.deliveryStatus === 'sent' ? `已发送 · ${formatTaskTime(task.deliveredAt)}` : task.deliveryStatus === 'failed' ? `发送失败：${task.deliveryError}` : task.deliveryStatus === 'sending' ? '正在发送通知…' : task.deliveryError ? `发送未成功，正在重试：${task.deliveryError}` : '通知等待发送'}</p>}
        {canEdit(task) && <div className="task-actions">
          {!['completed','cancelled','running'].includes(task.status) && <>{!task.recurrence && <button type="button" disabled={busy} onClick={() => action(task,{status:'completed'})}><Check size={14} />标记完成</button>}<button type="button" disabled={busy} onClick={() => openEditor(task)}>重新安排</button><button type="button" disabled={busy} onClick={() => action(task,{status:'cancelled'})}>{task.recurrence ? '停止重复计划' : '取消任务'}</button></>}
          {task.status === 'running' && <button type="button" disabled={busy} onClick={() => action(task,{status:'cancelled'})}>取消任务</button>}
          {task.deliveryStatus === 'failed' && !['cancelled'].includes(task.status) && <button type="button" disabled={busy} onClick={() => action(task,{action:'retry-delivery'})}>重试通知</button>}
        </div>}
      </article>)}
    </div>
    {editor && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setEditor(null) }}><section className="expense-modal task-editor" role="dialog" aria-modal="true" aria-labelledby="task-editor-title">
      <div className="modal-head"><h2 id="task-editor-title">{editor.reschedule ? '重新安排任务' : '新建任务'}</h2><button type="button" className="close-button" disabled={busy} aria-label="关闭" onClick={() => setEditor(null)}><X size={19} /></button></div>
      <form className="account-form" onSubmit={submit}>
        {!editor.reschedule && <><label><span>任务名称</span><input name="title" maxLength="160" placeholder="例如：交水电费" autoFocus required /></label><label><span>任务类型</span><select value={editor.kind} onChange={(event) => setEditor({...editor,kind:event.target.value})}>{Object.entries(taskKindLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><p className="group-help">{editor.kind === 'reminder' ? '到点提醒，完成情况由负责人确认。' : editor.kind === 'ledger_summary' ? '到点自动汇总本月截至当天的账本收支，并发送结果。' : '到点生成指定文字、计划或清单，不执行外部操作。'}</p><label><span>详情</span><textarea name="details" rows={3} maxLength="2000" placeholder="补充说明或自动生成内容的要求" /></label><div className="form-grid"><label><span>负责人</span><select name="assigneeId" defaultValue={user.id}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label><span>通知位置</span><select value={editor.target} onChange={(event) => setEditor({...editor,target:event.target.value})}><option value="group">当前账本的 QQ 群</option><option value="private">负责人的 QQ 私聊</option></select></label></div></>}
        {!editor.seriesId && <>
          <label><span>重复规则</span><select value={editor.recurrence?.type || 'none'} onChange={(event)=>setEditor({...editor,recurrence:event.target.value === 'none' ? null : event.target.value === 'interval' ? {type:'interval',every:1,unit:'day'} : event.target.value === 'weekly' ? {type:'weekly',weekdays:[1],time:'09:00'} : {type:'monthly',days:[1],time:'09:00'}})}><option value="none">不重复</option><option value="interval">每隔一定时间</option><option value="weekly">每周指定星期</option><option value="monthly">每月指定日期</option></select></label>
          {editor.recurrence?.type === 'interval' && <div className="form-grid"><label><span>每隔</span><input type="number" min="1" max="100000" step="1" required value={editor.recurrence.every} onChange={(event)=>setEditor({...editor,recurrence:{...editor.recurrence,every:Number(event.target.value)}})} /></label><label><span>单位</span><select value={editor.recurrence.unit} onChange={(event)=>setEditor({...editor,recurrence:{...editor.recurrence,unit:event.target.value}})}><option value="minute">分钟</option><option value="hour">小时</option><option value="day">天</option></select></label></div>}
          {editor.recurrence?.type === 'weekly' && <fieldset className="task-repeat-days"><legend>每周</legend>{[1,2,3,4,5,6,7].map((day)=><label key={day}><input type="checkbox" checked={editor.recurrence.weekdays.includes(day)} onChange={(event)=>setEditor({...editor,recurrence:{...editor.recurrence,weekdays:event.target.checked ? [...editor.recurrence.weekdays,day] : editor.recurrence.weekdays.filter((value)=>value!==day)}})} />周{'一二三四五六日'[day-1]}</label>)}</fieldset>}
          {editor.recurrence?.type === 'monthly' && <label><span>每月日期（多日用逗号分隔）</span><input key={`monthly-${editor.id || 'new'}`} defaultValue={editor.recurrence.days.join(',')} onChange={(event)=>setEditor({...editor,recurrence:{...editor.recurrence,days:event.target.value.split(/[,，、\s]+/).filter(Boolean).map(Number)}})} placeholder="例如：1,15,28" required /><span>没有该日期的月份跳过。</span></label>}
        </>}
        <label><span>{editor.recurrence ? '首次／下次执行时间' : editor.kind === 'reminder' ? '提醒时间' : '执行时间'}（香港时间）</span><input type="datetime-local" name="dueAt" defaultValue={hongKongInputTime(editor.dueAt)} required={editor.reschedule || editor.kind !== 'reminder' || Boolean(editor.recurrence)} /></label>
        {editor.recurrence && <p className="group-help">每周／每月规则使用这里的时刻，首次执行从该日期起计算。完成某一次不会停止计划。</p>}
        {!editor.reschedule && editor.kind === 'reminder' && !editor.recurrence && <p className="group-help">不设时间则只记录待办。</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="primary-button account-submit" disabled={busy}>{busy ? '正在保存…' : editor.reschedule ? '保存时间' : '创建任务'}</button>
      </form>
    </section></div>}
  </section>
}
