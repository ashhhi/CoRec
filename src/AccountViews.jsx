import React, { useEffect, useState } from 'react'
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

export function GroupPanel({ user, groups, activeGroup, onChanged, onClose, fullScreen = false }) {
  const [mode, setMode] = useState('join')
  const [members, setMembers] = useState([])
  const [inviteCode, setInviteCode] = useState(activeGroup?.inviteCode || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [qqBinding, setQqBinding] = useState(null)
  const [qqCode, setQqCode] = useState('')

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

  useEffect(() => {
    if (!qqCode) return
    let current = true
    const refresh = window.setInterval(() => {
      requestJson('/api/qq/binding').then(({ binding }) => { if (current) setQqBinding(binding) }).catch(() => {})
    }, 5000)
    const expiry = window.setTimeout(() => setQqCode(''), 10 * 60 * 1000)
    return () => { current = false; window.clearInterval(refresh); window.clearTimeout(expiry) }
  }, [qqCode])

  useEffect(() => {
    if (!activeGroup) return
    let current = true
    setQqCode('')
    requestJson('/api/qq/binding').then(({ binding }) => { if (current) setQqBinding(binding) }).catch(() => {})
    return () => { current = false }
  }, [activeGroup?.id])

  async function generateQqCode() {
    setBusy(true)
    setError('')
    try {
      const data = await requestJson(`/api/groups/${activeGroup.id}/qq/bind-code`, { method: 'POST' })
      setQqCode(data.code)
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

  async function unbindQq() {
    if (!window.confirm('确定解除 QQ 绑定吗？')) return
    setBusy(true)
    setError('')
    try {
      await requestJson('/api/qq/binding', { method: 'DELETE' })
      setQqBinding(null)
      setQqCode('')
    } catch (requestError) { setError(requestError.message) } finally { setBusy(false) }
  }

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
    {activeGroup && <div className="qq-binding"><div className="group-detail-heading"><span>QQ 私聊绑定</span>{qqBinding && <button type="button" className="copy-button" onClick={unbindQq} disabled={busy}>解除绑定</button>}</div><p>{qqBinding ? `已绑定账本：${qqBinding.groupName}` : '尚未绑定 QQ'}</p>{qqCode && <div className="qq-code"><strong>{qqCode}</strong><span>向机器人发送：绑定 {qqCode}，有效期 10 分钟</span></div>}<button type="button" className="add-profile-button qq-bind-button" onClick={generateQqCode} disabled={busy}>生成当前群组的绑定码</button></div>}
    {activeGroup && <div className="group-detail"><div className="group-detail-heading"><span>群组邀请码</span><button className="copy-button" onClick={copyInvite}><Copy size={15} />{copied ? '已复制' : '复制'}</button></div><div className="invite-code">{inviteCode}</div><div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><span className={`avatar ${member.id === user.id ? 'avatar-coral' : 'avatar-blue'}`}>{member.displayName.slice(0, 1)}</span><span>{member.displayName}{member.id === user.id ? '（你）' : ''}</span><small>{member.role === 'owner' ? '创建者' : '成员'}</small></div>)}</div></div>}
    <div className="group-actions"><div className="mode-tabs"><button className={mode === 'join' ? 'mode-tab active' : 'mode-tab'} onClick={() => { setMode('join'); setError('') }}>加入群组</button><button className={mode === 'create' ? 'mode-tab active' : 'mode-tab'} onClick={() => { setMode('create'); setError('') }}>创建群组</button></div><form className="account-form" onSubmit={submit}>{mode === 'create' ? <label><span>群组名称</span><input name="name" maxLength="80" placeholder="例如：周末搭子" required /></label> : <label><span>邀请码</span><input name="inviteCode" autoCapitalize="characters" maxLength="16" placeholder="输入 16 位邀请码" required /></label>}{error && <div className="error-banner" role="alert">{error}</div>}<button className="primary-button account-submit" type="submit" disabled={busy}>{busy ? '请稍候…' : mode === 'create' ? '创建群组' : '加入群组'}</button></form></div>
  </>

  if (fullScreen) return <main className="account-page"><header className="topbar"><div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div><span className="account-user" title={user.username}>{user.displayName}</span></header><section className="group-panel account-panel setup-panel">{content}</section></main>
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="group-panel group-modal">{content}</section></div>
}
