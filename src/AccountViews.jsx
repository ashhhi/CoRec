import React, { useEffect, useId, useState } from 'react'
import { Copy, KeyRound, UsersRound, X } from 'lucide-react'

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

  return <main className="account-page"><header className="topbar"><div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div></header><section className="account-panel"><div className="account-icon"><KeyRound size={20} /></div><p className="eyebrow">COREC ACCOUNT</p><h1>{mode === 'login' ? '登录 CoRec' : '创建账号'}</h1><p className="account-description">{mode === 'login' ? '登录后进入你所在的群组。' : '创建账号后，可以创建群组或加入已有群组。'}</p><form className="account-form" onSubmit={submit}>{mode === 'register' && <label><span>名字</span><input name="displayName" autoComplete="name" minLength="1" maxLength="32" placeholder="在群组和账单中显示的名字" required /></label>}<label><span>账号</span><input name="username" autoComplete="username" minLength="2" maxLength="32" placeholder="2 到 32 位字母、数字或符号" required /></label><label><span>密码</span><input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength="8" maxLength="72" placeholder="至少 8 位" required /></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary-button account-submit" type="submit" disabled={busy}>{busy ? '请稍候…' : mode === 'login' ? '登录' : '注册账号'}</button></form><button className="account-switch" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError('') }}>{mode === 'login' ? '还没有账号？创建一个' : '已有账号？返回登录'}</button></section></main>
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
    {status && !status.linked && !status.canManage && <p>请先由账本创建者绑定 QQ 群，再绑定你的 QQ 群身份。</p>}
    {status && !status.memberBound && (status.linked || status.canManage) && <>
      {confirmCode && <div className="qq-code" aria-live="polite">
        <span>用同一个 QQ 账号，在原群里 @机器人 发送</span>
        <strong>确认绑定 {confirmCode}</strong>
      </div>}
      <p>{confirmCode ? '如需重新获取确认码，请填写 QQ 群绑定请求码。' : '在 QQ 群里 @机器人 发送「绑定」，然后填入机器人回复的请求码。'}</p>
      {!status.linked && !confirmCode && <p>创建者完成首次确认时，会同时绑定账本和自己的 QQ 群身份。</p>}
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

export function GroupPanel({ user, groups, activeGroup, onChanged, onClose, fullScreen = false }) {
  const [mode, setMode] = useState('join')
  const [members, setMembers] = useState([])
  const [inviteCode, setInviteCode] = useState(activeGroup?.inviteCode || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!activeGroup) return
    let current = true
    requestJson(`/api/groups/${activeGroup.id}`).then(({ group }) => {
      if (!current) return
      setMembers(group.members)
      setInviteCode(group.invite_code || group.inviteCode || activeGroup.inviteCode)
    }).catch((requestError) => {
      if (current) setError(requestError.message)
    })
    return () => { current = false }
  }, [activeGroup?.id])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    const creating = mode === 'create'
    try {
      const data = await requestJson(creating ? '/api/groups' : '/api/groups/join', {
        method: 'POST',
        body: JSON.stringify(creating ? { name: form.get('name') } : { inviteCode: form.get('inviteCode') }),
      })
      await onChanged(data.group)
      if (!fullScreen) onClose()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
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
    {activeGroup && <QqBindingTabs key={activeGroup.id} groupId={activeGroup.id} />}
    {activeGroup && <div className="group-detail"><div className="group-detail-heading"><span>群组邀请码</span><button className="copy-button" onClick={copyInvite}><Copy size={15} />{copied ? '已复制' : '复制'}</button></div><div className="invite-code">{inviteCode}</div><div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><span className={`avatar ${member.id === user.id ? 'avatar-coral' : 'avatar-blue'}`}>{member.displayName.slice(0, 1)}</span><span>{member.displayName}{member.id === user.id ? '（你）' : ''}</span><small>{member.role === 'owner' ? '创建者' : '成员'}</small></div>)}</div></div>}
    <div className="group-actions"><div className="mode-tabs"><button className={mode === 'join' ? 'mode-tab active' : 'mode-tab'} onClick={() => { setMode('join'); setError('') }}>加入群组</button><button className={mode === 'create' ? 'mode-tab active' : 'mode-tab'} onClick={() => { setMode('create'); setError('') }}>创建群组</button></div><form className="account-form" onSubmit={submit}>{mode === 'create' ? <label><span>群组名称</span><input name="name" maxLength="80" placeholder="例如：周末搭子" required /></label> : <label><span>邀请码</span><input name="inviteCode" autoCapitalize="characters" maxLength="16" placeholder="输入 16 位邀请码" required /></label>}{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary-button account-submit" type="submit" disabled={busy}>{busy ? '请稍候…' : mode === 'create' ? '创建群组' : '加入群组'}</button></form></div>
  </>

  if (fullScreen) return <main className="account-page"><header className="topbar"><div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div><span className="account-user" title={user.username}>{user.displayName}</span></header><section className="group-panel account-panel setup-panel">{content}</section></main>
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="group-panel group-modal">{content}</section></div>
}
