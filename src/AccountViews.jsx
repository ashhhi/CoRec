import React, { useEffect, useId, useRef, useState } from 'react'
import { Copy, KeyRound, Plus, UserPlus, UsersRound, X } from 'lucide-react'

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。')
  return data
}

export function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const data = await requestJson(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ username: form.get('username'), displayName: form.get('displayName'), password: form.get('password') }),
      })
      await onAuthenticated(data.user)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <main className="account-page"><header className="topbar"><div className="brand"><img className="brand-mark" src="/cat-head.svg" alt="" aria-hidden="true" /><span>CoRec</span></div></header><section className="account-panel"><div className="account-icon"><KeyRound size={20} /></div><p className="eyebrow">COREC ACCOUNT</p><h1>{mode === 'login' ? '登录 CoRec' : '创建账号'}</h1><p className="account-description">{mode === 'login' ? '登录后进入你所在的群组。' : '创建账号后，可以创建群组或加入已有群组。'}</p><form className="account-form" onSubmit={submit}>{mode === 'register' && <label><span>名字</span><input name="displayName" autoComplete="name" minLength="1" maxLength="32" placeholder="在群组和账单中显示的名字" required /></label>}<label><span>账号</span><input name="username" autoComplete="username" minLength="2" maxLength="32" placeholder="2 到 32 位字母、数字或符号" required /></label><label><span>密码</span><input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="8" maxLength="72" placeholder="至少 8 位" required /></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary-button account-submit" type="submit" disabled={busy}>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册账号'}</button></form><button className="account-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>{mode === 'login' ? '还没有账号？创建一个' : '已有账号？返回登录'}</button></section></main>
}

const qqBindingTabs = [
  { key: 'group', label: '群聊绑定' },
  { key: 'private', label: '私聊绑定' },
]

function QqBindingTabs({ groupId }) {
  const id = useId()
  const [activeTab, setActiveTab] = useState(0)

  function handleTabKey(event) {
    let next
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        next = 1 - activeTab
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = 1
        break
      default:
        return
    }
    event.preventDefault()
    setActiveTab(next)
    event.currentTarget.querySelectorAll('[role="tab"]')[next].focus()
  }

  return <section className="qq-binding" aria-label="QQ 绑定">
    <div className="mode-tabs qq-tabs" role="tablist" aria-label="QQ 绑定方式" onKeyDown={handleTabKey}>
      {qqBindingTabs.map(({ key, label }, index) => <button
        key={key}
        type="button"
        className="mode-tab"
        role="tab"
        id={`${id}-${key}-tab`}
        aria-controls={`${id}-${key}-panel`}
        aria-selected={activeTab === index}
        tabIndex={activeTab === index ? 0 : -1}
        onClick={() => setActiveTab(index)}
      >{label}</button>)}
    </div>
    {qqBindingTabs.map(({ key }, index) => <div
      key={key}
      role="tabpanel"
      id={`${id}-${key}-panel`}
      aria-labelledby={`${id}-${key}-tab`}
      tabIndex={0}
      hidden={activeTab !== index}
    >
      {key === 'group' ? <QqGroupBinding groupId={groupId} /> : <QqPrivateBinding groupId={groupId} />}
    </div>)}
  </section>
}

function QqBindingStatus({ label, bound, onUnlink, unlinkLabel, busy }) {
  return <li className="qq-binding-row">
    <div className="qq-binding-state">
      <strong>{label}</strong>
      <span className={bound ? 'is-bound' : undefined}>{bound ? '已绑定' : '未绑定'}</span>
    </div>
    {bound && onUnlink && <button type="button" className="copy-button" onClick={onUnlink} disabled={busy}>{unlinkLabel}</button>}
  </li>
}

function QqGroupBinding({ groupId }) {
  const path = `/api/groups/${groupId}/qq/group-binding`
  const [status, setStatus] = useState(null)
  const [confirmCode, setConfirmCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    async function refresh() {
      try {
        const data = await requestJson(path)
        if (!current) return
        setStatus(data)
        if (data.memberBound) setConfirmCode('')
      } catch (requestError) {
        if (current) setError(requestError.message)
      }
    }
    refresh()
    const timer = confirmCode ? window.setInterval(refresh, 3000) : null
    return () => { current = false; window.clearInterval(timer) }
  }, [path, confirmCode])

  async function claim(event) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('code')
    setBusy(true)
    setError('')
    setConfirmCode('')
    try {
      const result = await requestJson(path, { method: 'POST', body: JSON.stringify({ code }) })
      setConfirmCode(result.code)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function unlink(scope) {
    const label = scope === 'group' ? '解除本账本的 QQ 群绑定？所有成员的群聊身份也会解除。' : '解除你的 QQ 群身份绑定？'
    if (!window.confirm(label)) return
    setBusy(true)
    setError('')
    try {
      await requestJson(`${path}?scope=${scope}`, { method: 'DELETE' })
      setConfirmCode('')
      setStatus(await requestJson(path))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    {status ? <ul className="qq-binding-status" aria-live="polite">
      <QqBindingStatus
        label="账本与 QQ 群"
        bound={status.linked}
        onUnlink={status.canManage ? () => unlink('group') : undefined}
        unlinkLabel="解绑 QQ 群"
        busy={busy}
      />
      <QqBindingStatus
        label="我的 CoRec 账号与 QQ 群成员"
        bound={status.memberBound}
        onUnlink={() => unlink('member')}
        unlinkLabel="解绑个人身份"
        busy={busy}
      />
    </ul> : !error && <p role="status">正在读取群聊绑定状态…</p>}
    {status && !status.linked && !status.canManage && <p>请先由群主绑定 QQ 群，再绑定你的 QQ 群身份。</p>}
    {status && !status.memberBound && (status.linked || status.canManage) && <>
      {confirmCode && <div className="qq-code" aria-live="polite">
        <span>用同一个 QQ 账号，在原群里 @机器人 发送</span>
        <strong>确认绑定 {confirmCode}</strong>
      </div>}
      <p>{confirmCode ? '如需重新获取确认码，请填写 QQ 群绑定请求码。' : '在 QQ 群里 @机器人 发送「绑定」，然后填入机器人回复的请求码。'}</p>
      {!status.linked && !confirmCode && <p>群主完成首次确认时，会同时绑定账本和自己的 QQ 群身份。</p>}
      <form className="account-form qq-binding-form" onSubmit={claim}>
        <label>
          <span>QQ 群绑定请求码</span>
          <input name="code" pattern="[A-Fa-f0-9]{16}" maxLength="16" autoComplete="off" autoCapitalize="characters" required />
        </label>
        <button type="submit" className="primary-button qq-bind-button" disabled={busy}>获取确认码</button>
      </form>
    </>}
    {error && <div className="error-banner" role="alert">{error}</div>}
  </>
}

function QqPrivateBinding({ groupId }) {
  const [binding, setBinding] = useState(undefined)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    async function refresh() {
      const { binding } = await requestJson('/api/qq/binding')
      if (current) setBinding(binding)
    }
    refresh().catch((requestError) => {
      if (current) setError(requestError.message)
    })
    const timer = code ? window.setInterval(() => refresh().catch(() => {}), 5000) : null
    const expiry = code ? window.setTimeout(() => setCode(''), 10 * 60 * 1000) : null
    return () => { current = false; window.clearInterval(timer); window.clearTimeout(expiry) }
  }, [code])

  async function generateCode() {
    setBusy(true)
    setError('')
    try {
      const data = await requestJson(`/api/groups/${groupId}/qq/bind-code`, { method: 'POST' })
      setCode(data.code)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function unlink() {
    if (!window.confirm('确定解除与 QQ 账号的绑定吗？')) return
    setBusy(true)
    setError('')
    try {
      await requestJson('/api/qq/binding', { method: 'DELETE' })
      setBinding(null)
      setCode('')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  const bindingStatus = binding === undefined
    ? (error ? '无法读取绑定状态' : '正在读取绑定状态…')
    : (binding ? '已绑定' : '未绑定')

  return <>
    <div className="qq-binding-row">
      <div className="qq-binding-state" role="status">
        <strong>CoRec 账号与 QQ 账号</strong>
        <span className={binding ? 'is-bound' : undefined}>{bindingStatus}</span>
      </div>
      {binding && <button type="button" className="copy-button" onClick={unlink} disabled={busy}>解除绑定</button>}
    </div>
    {code && <div className="qq-code" aria-live="polite">
      <span>用要绑定的 QQ 账号私聊机器人，发送以下指令。绑定码有效期为 10 分钟。</span>
      <strong>绑定 {code}</strong>
    </div>}
    <button type="button" className="primary-button qq-bind-button" onClick={generateCode} disabled={busy}>{code ? '重新生成绑定码' : '生成 QQ 绑定码'}</button>
    {error && <div className="error-banner" role="alert">{error}</div>}
  </>
}

function GroupAccessInbox({ groups, onChanged, revision }) {
  const [access, setAccess] = useState({ requests: [], invitations: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const latest = useRef({ groups, onChanged })
  latest.current = { groups, onChanged }

  useEffect(() => {
    let current = true
    let refreshing = false
    async function refresh() {
      if (refreshing) return
      refreshing = true
      try {
        const data = await requestJson('/api/group-access')
        if (!current) return
        setAccess(data)
        setError('')
        const signature = (items) => JSON.stringify(items.map(({ id, role, name }) => [id, role, name]).sort((a, b) => a[0] - b[0]))
        if (signature(data.memberships) !== signature(latest.current.groups)) await latest.current.onChanged()
      } catch (requestError) {
        if (current) setError(requestError.message)
      } finally {
        refreshing = false
      }
    }
    refresh()
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, 5000)
    window.addEventListener('focus', refresh)
    return () => { current = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [revision, reload])

  async function respond(groupId, action) {
    setBusy(true)
    setError('')
    try {
      if (action === 'withdraw') await requestJson(`/api/group-requests/${groupId}`, { method: 'DELETE' })
      else {
        const data = await requestJson(`/api/group-invitations/${groupId}`, { method: 'POST', body: JSON.stringify({ action }) })
        if (data.group) await latest.current.onChanged(data.group)
      }
      setReload((value) => value + 1)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  return <>
    {(access.requests.length > 0 || access.invitations.length > 0) && <section className="group-access-section" aria-label="我的入群申请与邀请">
      <h3>我的入群申请与邀请</h3>
      {access.invitations.map((invitation) => <div className="group-access-row" key={`invite-${invitation.groupId}`}>
        <div className="group-access-person"><strong>{invitation.groupName}</strong><span>{invitation.invitedBy} 邀请你加入</span></div>
        <div className="group-inline-actions"><button type="button" onClick={() => respond(invitation.groupId, 'accept')} disabled={busy}>接受</button><button type="button" onClick={() => respond(invitation.groupId, 'decline')} disabled={busy}>拒绝</button></div>
      </div>)}
      {access.requests.map((application) => <div className="group-access-row" key={`request-${application.groupId}`}>
        <div className="group-access-person"><strong>{application.groupName}</strong><span>{application.status === 'pending' ? '等待群主或管理员审批' : '申请未通过，可重新提交'}</span></div>
        <div className="group-inline-actions"><button type="button" onClick={() => respond(application.groupId, 'withdraw')} disabled={busy}>{application.status === 'pending' ? '撤回' : '移除'}</button></div>
      </div>)}
    </section>}
    {error && <div className="error-banner" role="alert">申请与邀请更新失败：{error}</div>}
  </>
}

const groupRoleLabels = { owner: '群主', admin: '管理员', member: '成员' }

export function GroupAddMenu({ onSelect }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    root.current?.querySelector('[role="menuitem"]')?.focus()
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside) }
  }, [open])

  function choose(mode) {
    setOpen(false)
    trigger.current?.focus()
    onSelect(mode)
  }

  function keydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      if (!open) { setOpen(true); return }
      const items = [...root.current.querySelectorAll('[role="menuitem"]')]
      const index = items.indexOf(document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }
  }

  return <div ref={root} className="group-add-menu" onKeyDown={keydown}>
    <button ref={trigger} id="group-add-trigger" type="button" className="icon-button" title="创建或加入群组" aria-label="创建或加入群组" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}><Plus size={19} /></button>
    {open && <div id={id} className="group-add-options" role="menu" aria-label="群组操作">
      <button type="button" role="menuitem" onClick={() => choose('create')}><Plus size={16} />创建群组</button>
      <button type="button" role="menuitem" onClick={() => choose('join')}><UserPlus size={16} />加入群组</button>
    </div>}
  </div>
}

function GroupEntryForm({ groups, onChanged, onClose, initialMode = 'join', showTabs = false }) {
  const [mode, setMode] = useState(initialMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const form = new FormData(event.currentTarget)
    const creating = mode === 'create'
    try {
      const data = await requestJson(creating ? '/api/groups' : '/api/groups/join', {
        method: 'POST', body: JSON.stringify(creating ? { name: form.get('name') } : { inviteCode: form.get('inviteCode') }),
      })
      if (creating) {
        await onChanged(data.group)
        onClose?.()
      } else {
        setNotice(`已向「${data.request.groupName}」提交申请，等待群主或管理员审批。`)
        setRevision((value) => value + 1)
      }
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  return <>
    <div className="group-entry-form">
      {showTabs && <div className="mode-tabs" role="group" aria-label="创建或加入群组">
        {[['join', '加入群组'], ['create', '创建群组']].map(([value, label]) => <button key={value} type="button" className={`mode-tab${mode === value ? ' active' : ''}`} aria-pressed={mode === value} onClick={() => { setMode(value); setError(''); setNotice('') }}>{label}</button>)}
      </div>}
      {mode === 'join' && <p className="group-help">输入邀请码提交入群申请，由群主或管理员审批后加入。</p>}
      <form className="account-form" onSubmit={submit}>
        {mode === 'create' ? <label><span>群组名称</span><input key="name" name="name" maxLength="80" placeholder="例如：周末搭子" autoFocus required /></label> : <label><span>邀请码</span><input key="inviteCode" name="inviteCode" autoCapitalize="characters" maxLength="16" placeholder="输入 16 位邀请码" autoFocus required /></label>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="success-banner" role="status">{notice}</div>}
        <button type="submit" className="primary-button account-submit" disabled={busy}>{busy ? '请稍候…' : mode === 'create' ? '创建群组' : '提交入群申请'}</button>
      </form>
    </div>
    <GroupAccessInbox groups={groups} onChanged={onChanged} revision={revision} />
  </>
}

export function GroupEntryDialog({ mode, groups, onChanged, onClose }) {
  const titleId = useId()
  const dialog = useRef(null)
  useEffect(() => {
    const keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Tab') {
        const focusable = [...dialog.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]
        const first = focusable[0]
        const last = focusable.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="group-panel group-modal group-entry-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="group-panel-heading"><div><p className="eyebrow">SHARED GROUP</p><h2 id={titleId}>{mode === 'create' ? '创建群组' : '加入群组'}</h2></div><button type="button" className="close-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></div>
      <GroupEntryForm groups={groups} onChanged={onChanged} onClose={onClose} initialMode={mode} />
    </section>
  </div>
}

export function GroupPanel({ user, groups, activeGroup, onChanged, onLedgerReset, onClose, fullScreen = false }) {
  const [members, setMembers] = useState([])
  const [membersError, setMembersError] = useState('')
  const [inviteCode, setInviteCode] = useState(activeGroup?.inviteCode || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [role, setRole] = useState(activeGroup?.role || 'member')
  const [access, setAccess] = useState({ requests: [], invitations: [] })
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [inviteUsername, setInviteUsername] = useState('')
  const [successorId, setSuccessorId] = useState('')
  const [nameDraft, setNameDraft] = useState(activeGroup?.name || '')
  const nameEdited = useRef(false)
  const latest = useRef({ onChanged, onLedgerReset })
  latest.current = { onChanged, onLedgerReset }
  const canManage = role === 'owner' || role === 'admin'

  useEffect(() => {
    setNotice('')
    setError('')
    setInviteUsername('')
    nameEdited.current = false
    setNameDraft(activeGroup?.name || '')
  }, [activeGroup?.id])

  useEffect(() => {
    if (!nameEdited.current) setNameDraft(activeGroup?.name || '')
  }, [activeGroup?.name])

  useEffect(() => {
    if (!activeGroup) return
    let current = true
    let refreshing = false
    setMembers([])
    setMembersError('')
    setAccess({ requests: [], invitations: [] })
    setRole(activeGroup.role || 'member')
    setInviteCode('')
    setSuccessorId('')
    async function refresh() {
      if (refreshing) return
      refreshing = true
      try {
        const { group } = await requestJson(`/api/groups/${activeGroup.id}`)
        if (!current) return
        setMembers(group.members)
        setRole(group.role)
        setInviteCode(group.inviteCode || '')
        setMembersError('')
        if (group.role === 'owner' || group.role === 'admin') {
          const data = await requestJson(`/api/groups/${activeGroup.id}/access`)
          if (current) setAccess(data)
        } else setAccess({ requests: [], invitations: [] })
      } catch (requestError) {
        if (current) setMembersError(requestError.message)
      } finally {
        refreshing = false
      }
    }
    refresh()
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, 5000)
    window.addEventListener('focus', refresh)
    return () => {
      current = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [activeGroup?.id, revision])

  async function manage(path, { method = 'POST', body, confirmation, success, leave = false, profile = false } = {}) {
    if (confirmation && !window.confirm(confirmation)) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await requestJson(`/api/groups/${activeGroup.id}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
      setNotice(success || '操作成功。')
      if (profile || leave) await latest.current.onChanged()
      if (leave) { if (!fullScreen) onClose(); return }
      setRevision((value) => value + 1)
      return true
    } catch (requestError) { setError(requestError.message); return false } finally { setBusy(false) }
  }

  async function rename(event) {
    event.preventDefault()
    const name = nameDraft.trim()
    if (await manage('', { method: 'PATCH', body: { name }, success: '群组名称已更新。', profile: true })) {
      nameEdited.current = false
      setNameDraft(name)
    }
  }

  async function resetLedger() {
    const confirmation = window.prompt(`重置「${activeGroup.name}」的全部账单？\n将永久删除所有成员、所有月份的收入和支出记录，无法恢复。\n请输入群组名称「${activeGroup.name}」确认：`)
    if (confirmation === null) return
    if (confirmation !== activeGroup.name) { setError('群组名称不匹配，未重置账单。'); return }
    setBusy(true)
    setError('')
    setNotice('')
    const groupId = activeGroup.id
    try {
      const result = await requestJson(`/api/groups/${groupId}/ledger/reset`, { method: 'POST', body: JSON.stringify({ confirmation }) })
      latest.current.onLedgerReset?.(groupId)
      setNotice(`账单已重置，共删除 ${result.deletedCount} 条记录。`)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function invite(event) {
    event.preventDefault()
    await manage('/invitations', { body: { username: inviteUsername }, success: '邀请已发送，对方接受后即可加入。' })
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('复制失败，请手动复制邀请码。')
    }
  }

  const content = <>
    <div className="group-panel-heading"><div className="account-icon"><UsersRound size={20} /></div><div><p className="eyebrow">SHARED GROUP</p><h2>{activeGroup ? activeGroup.name : '加入一个群组'}</h2><p>{activeGroup ? `${members.length} 位成员 · ${user.displayName}` : '群组成员可以共同查看和记录账单。'}</p></div>{!fullScreen && <button className="close-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>}</div>
    {activeGroup && canManage && <section className="group-access-section" aria-label="群组设置">
      <h3>群组设置</h3>
      <form className="account-form group-name-form" onSubmit={rename}>
        <label><span>群组名称</span><input value={nameDraft} onChange={(event) => { nameEdited.current = true; setNameDraft(event.target.value) }} maxLength="80" required /></label>
        <button type="submit" className="primary-button" disabled={busy || !nameDraft.trim() || nameDraft.trim() === activeGroup.name}>保存名称</button>
      </form>
    </section>}
    {activeGroup && <QqBindingTabs key={`${activeGroup.id}:${role}`} groupId={activeGroup.id} />}
    {activeGroup && <div className="group-detail">
      {canManage ? <>
        <div className="group-detail-heading"><span>群组邀请码</span><button type="button" className="copy-button" onClick={copyInvite} disabled={!inviteCode}><Copy size={15} />{copied ? '已复制' : '复制'}</button></div>
        <div className="invite-code">{inviteCode || '正在读取…'}</div>
        <p className="group-help">使用邀请码申请后，需由群主或管理员审批。</p>
      </> : <div className="group-detail-heading"><span>群组成员</span><span>邀请成员请联系群主或管理员</span></div>}
      <div className="member-list" aria-label="群组成员与 QQ 绑定状态">
        {members.map((member) => <div className="member-row" key={member.id}>
          <span className={`avatar ${member.id === user.id ? 'avatar-coral' : 'avatar-blue'}`}>{member.displayName.slice(0, 1)}</span>
          <div className="member-info">
            <div className="member-heading"><span>{member.displayName}{member.id === user.id ? '（你）' : ''}</span><small>{groupRoleLabels[member.role]}</small></div>
            <div className="member-qq-bindings">
              <span className={`member-qq-status${member.qqPrivateBound ? member.qqPrivateInGroup ? ' is-bound' : ' is-other-group' : ''}`}>QQ 私聊 · {member.qqPrivateBound ? member.qqPrivateInGroup ? '已绑定' : '已绑定其他账本' : '未绑定'}</span>
              <span className={`member-qq-status${member.qqGroupBound ? ' is-bound' : ''}`}>QQ 群聊 · {member.qqGroupBound ? '已绑定' : '未绑定'}</span>
            </div>
            {canManage && member.id !== user.id && member.role !== 'owner' && <div className="group-inline-actions member-actions">
              {role === 'owner' && <button type="button" disabled={busy} onClick={() => manage(`/members/${member.id}`, { method: 'PATCH', body: { role: member.role === 'admin' ? 'member' : 'admin' }, confirmation: `确定${member.role === 'admin' ? '取消' : '设置'} ${member.displayName} 的管理员身份？` })}>{member.role === 'admin' ? '取消管理员' : '设为管理员'}</button>}
              {(role === 'owner' || member.role === 'member') && <button type="button" className="is-danger" disabled={busy} onClick={() => manage(`/members/${member.id}`, { method: 'DELETE', confirmation: `将 ${member.displayName} 移出群组？该成员将失去账本访问权限，历史账单保留。` })}>移出群组</button>}
            </div>}
          </div>
        </div>)}
        {membersError && <div className="error-banner" role="alert">成员绑定状态更新失败：{membersError}</div>}
      </div>
    </div>}
    {activeGroup && canManage && <section className="group-access-section" aria-label="群组管理">
      <h3>邀请成员</h3>
      <form className="account-form group-invite-form" onSubmit={invite}>
        <label><span>CoRec 账号</span><input value={inviteUsername} onChange={(event) => setInviteUsername(event.target.value)} placeholder="输入对方的登录账号" minLength="2" maxLength="32" required /></label>
        <button type="submit" className="primary-button" disabled={busy}>发送邀请</button>
      </form>
      {access.invitations.map((invitation) => <div className="group-access-row" key={invitation.userId}>
        <div className="group-access-person"><strong>{invitation.displayName}</strong><span>{invitation.username} · 等待接受邀请</span></div>
        <div className="group-inline-actions"><button type="button" disabled={busy} onClick={() => manage(`/invitations/${invitation.userId}`, { method: 'DELETE', success: '邀请已撤回。' })}>撤回邀请</button></div>
      </div>)}
      <h3>入群申请{access.requests.length > 0 ? `（${access.requests.length}）` : ''}</h3>
      {access.requests.length === 0 ? <p className="group-help">暂无待审批的申请。</p> : access.requests.map((application) => <div className="group-access-row" key={application.userId}>
        <div className="group-access-person"><strong>{application.displayName}</strong><span>{application.username}</span></div>
        <div className="group-inline-actions"><button type="button" disabled={busy} onClick={() => manage(`/requests/${application.userId}`, { body: { action: 'approve' }, success: '申请已通过。' })}>通过</button><button type="button" className="is-danger" disabled={busy} onClick={() => manage(`/requests/${application.userId}`, { body: { action: 'reject' }, success: '申请已拒绝。' })}>拒绝</button></div>
      </div>)}
    </section>}
    {activeGroup && <GroupAccessInbox groups={groups} onChanged={onChanged} revision={revision} />}
    {notice && <div className="success-banner" role="status">{notice}</div>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {activeGroup && role === 'owner' && <section className="group-lifecycle" aria-label="账单重置">
      <h3>重置账单</h3>
      <p className="group-help">永久删除本群组所有月份、所有成员的收入和支出记录，无法恢复。</p>
      <button type="button" className="group-danger-button" disabled={busy} onClick={resetLedger}>重置全部账单</button>
    </section>}
    {activeGroup && <section className="group-lifecycle" aria-label="退出与群主管理">
      {role === 'owner' ? <>
        <h3>转让群主</h3>
        <p className="group-help">转让后，你将成为普通成员，新群主接管群组管理权限。</p>
        <form className="group-transfer-form" onSubmit={(event) => { event.preventDefault(); manage('/transfer-owner', { body: { userId: Number(successorId) }, confirmation: `将群主转让给 ${members.find((member) => member.id === Number(successorId))?.displayName}？转让后你将失去群主权限。`, success: '群主已转让，你现在是普通成员。', profile: true }) }}>
          <label><span className="visually-hidden">新群主</span><select value={successorId} onChange={(event) => setSuccessorId(event.target.value)} required><option value="">选择新群主</option>{members.filter((member) => member.id !== user.id).map((member) => <option key={member.id} value={member.id}>{member.displayName}（{groupRoleLabels[member.role]}）</option>)}</select></label>
          <button type="submit" className="group-secondary-button" disabled={busy || !successorId}>转让群主</button>
        </form>
        <button type="button" className="group-danger-button" disabled={busy} onClick={() => manage('', { method: 'DELETE', confirmation: `解散「${activeGroup.name}」？所有成员将退出，该群组的全部账单、QQ 绑定、申请和邀请都会删除，无法恢复。`, leave: true })}>解散群组</button>
      </> : <button type="button" className="group-danger-button" disabled={busy} onClick={() => manage('/membership', { method: 'DELETE', confirmation: `退出「${activeGroup.name}」？你将失去账本访问权限，该群组的 QQ 绑定会解除，历史账单保留。`, leave: true })}>退出群组</button>}
    </section>}
    {!activeGroup && <GroupEntryForm groups={groups} onChanged={onChanged} showTabs />}
  </>

  if (fullScreen) return <main className="account-page"><header className="topbar"><div className="brand"><img className="brand-mark" src="/cat-head.svg" alt="" aria-hidden="true" /><span>CoRec</span></div><span className="account-user" title={user.username}>{user.displayName}</span></header><section className="group-panel account-panel setup-panel">{content}</section></main>
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="group-panel group-modal">{content}</section></div>
}
