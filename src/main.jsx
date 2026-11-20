import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  BookOpen,
  BriefcaseBusiness,
  CircleDollarSign,
  Home,
  LogOut,
  MessageSquare,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  TrainFront,
  Trash2,
  Undo2,
  UserRound,
  UsersRound,
  Utensils,
  X,
} from 'lucide-react'
import { AuthScreen, GroupPanel } from './AccountViews.jsx'
import ChatPage from './ChatPage.jsx'
import './styles.css'

const categoryMeta = {
  餐饮: { icon: Utensils, color: '#ef8b72', soft: '#fff0eb' },
  交通: { icon: TrainFront, color: '#6d8db6', soft: '#edf3fb' },
  娱乐: { icon: Sparkles, color: '#bb8cce', soft: '#f5eef9' },
  居家: { icon: Home, color: '#72a586', soft: '#edf7ef' },
  购物: { icon: ShoppingBag, color: '#d6a15f', soft: '#fff6e8' },
}
const incomeCategoryMeta = {
  工资: { icon: BriefcaseBusiness, color: '#4c9671', soft: '#edf7ef' },
  奖金: { icon: BadgeDollarSign, color: '#6d8db6', soft: '#edf3fb' },
  退款: { icon: Undo2, color: '#d6a15f', soft: '#fff6e8' },
  其他收入: { icon: CircleDollarSign, color: '#8c9d62', soft: '#f2f5e8' },
}
const incomeCategories = Object.keys(incomeCategoryMeta)

function formatMoney(value) {
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function localMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDate(value, currentDate) {
  const date = new Date(`${value}T12:00:00`)
  const dayLabel = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
  if (value === currentDate) return { date: dayLabel, weekday: '今天' }
  const previous = new Date(`${currentDate}T12:00:00`)
  previous.setDate(previous.getDate() - 1)
  if (value === localDate(previous)) return { date: dayLabel, weekday: '昨天' }
  return { date: dayLabel, weekday: `周${'日一二三四五六'[date.getDay()]}` }
}

async function readJson(response) {
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。')
  return data
}

function App() {
  const [user, setUser] = useState(null)
  const [groups, setGroups] = useState([])
  const [activeGroupId, setActiveGroupId] = useState(null)
  const [groupInfo, setGroupInfo] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [activePage, setActivePage] = useState('ledger')
  const [month, setMonth] = useState(() => localMonth(new Date()))
  const [transactions, setTransactions] = useState([])
  const [typeFilter, setTypeFilter] = useState('all')
  const [activeFilter, setActiveFilter] = useState('全部')
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [entryType, setEntryType] = useState('expense')
  const [entryCategory, setEntryCategory] = useState('餐饮')
  const [showGroupPanel, setShowGroupPanel] = useState(false)
  const [showProfilePanel, setShowProfilePanel] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const today = localDate(new Date())
  const activeGroup = groups.find((group) => group.id === activeGroupId) || null
  const members = groupInfo?.members || []
  const filterCategories = typeFilter === 'income'
    ? incomeCategories
    : typeFilter === 'expense'
      ? Object.keys(categoryMeta)
      : [...Object.keys(categoryMeta), ...incomeCategories]
  const monthLabel = new Date(`${month}-01T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
  const visibleTransactions = transactions.filter((item) => {
    const matchesType = typeFilter === 'all' || item.type === typeFilter
    const matchesFilter = activeFilter === '全部' || item.category === activeFilter
    const term = search.trim().toLowerCase()
    return matchesType && matchesFilter && (!term || `${item.merchant}${item.note}${item.category}${item.payer}`.toLowerCase().includes(term))
  })

  async function loadProfile(preferredGroupId = null) {
    const response = await fetch('/api/auth/me')
    if (response.status === 401) {
      setUser(null)
      setGroups([])
      setActiveGroupId(null)
      return false
    }
    const data = await readJson(response)
    setUser(data.user)
    setGroups(data.groups)
    setActiveGroupId((currentId) => {
      if (preferredGroupId && data.groups.some((group) => group.id === preferredGroupId)) return preferredGroupId
      if (data.groups.some((group) => group.id === currentId)) return currentId
      return data.groups[0]?.id || null
    })
    return true
  }

  useEffect(() => {
    loadProfile().catch((loadError) => setError(loadError.message)).finally(() => setAuthLoading(false))
  }, [])

  useEffect(() => {
    if (!user || !activeGroupId) {
      setGroupInfo(null)
      return
    }
    let current = true
    setGroupInfo(null)
    fetch(`/api/groups/${activeGroupId}`).then(readJson).then(({ group }) => {
      if (current) setGroupInfo(group)
    }).catch((loadError) => {
      if (current) setError(loadError.message)
    })
    return () => { current = false }
  }, [user?.id, activeGroupId])

  async function loadLedger(monthToLoad = month) {
    if (!user || !activeGroupId) {
      setTransactions([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/groups/${activeGroupId}/ledger?month=${encodeURIComponent(monthToLoad)}`)
      const data = await readJson(response)
      setTransactions(data.expenses)
    } catch (loadError) {
      setError(loadError.message || '无法连接账本服务。')
      if (loadError.message.includes('登录')) setUser(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadLedger(month) }, [user?.id, activeGroupId, month])

  async function addTransaction(event) {
    event.preventDefault()
    if (!activeGroupId) return
    setSaving(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch(`/api/groups/${activeGroupId}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: form.get('date'),
          merchant: form.get('category'),
          note: form.get('note'),
          category: form.get('category'),
          amount: form.get('amount'),
          payerId: form.get('payerId'),
          type: entryType,
        }),
      })
      const result = await readJson(response)
      setShowModal(false)
      const expenseMonth = result.expense.date.slice(0, 7)
      if (expenseMonth !== month) setMonth(expenseMonth)
      else await loadLedger(month)
    } catch (saveError) {
      setError(saveError.message || '保存账单失败。')
    } finally {
      setSaving(false)
    }
  }

  async function deleteTransaction(id) {
    if (!window.confirm('确定删除这笔账单吗？')) return
    setError('')
    try {
      const response = await fetch(`/api/groups/${activeGroupId}/expenses/${id}`, { method: 'DELETE' })
      await readJson(response)
      await loadLedger(month)
    } catch (deleteError) {
      setError(deleteError.message || '删除账单失败。')
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      setUser(null)
      setGroups([])
      setActiveGroupId(null)
      setTransactions([])
    }
  }

  async function updateDisplayName(event) {
    event.preventDefault()
    setProfileSaving(true)
    setProfileError('')
    try {
      const response = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: profileName }),
      })
      const { user: updatedUser } = await readJson(response)
      setUser(updatedUser)
      setShowProfilePanel(false)
    } catch (saveError) {
      setProfileError(saveError.message || '修改名字失败。')
      setProfileSaving(false)
      return
    }
    try {
      if (activeGroupId) {
        const groupResponse = await fetch(`/api/groups/${activeGroupId}`)
        const { group } = await readJson(groupResponse)
        setGroupInfo(group)
      }
      await loadLedger(month)
    } catch (refreshError) {
      setError(refreshError.message || '名字已修改，但刷新群组资料失败。')
    } finally {
      setProfileSaving(false)
    }
  }

  function shiftMonth(offset) {
    const date = new Date(`${month}-01T12:00:00`)
    date.setMonth(date.getMonth() + offset)
    setMonth(localMonth(date))
  }

  if (authLoading) return <main className="account-page"><div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div><div className="account-loading">正在连接 CoRec…</div></main>
  if (!user) return <AuthScreen onAuthenticated={async () => { await loadProfile() }} />
  if (!groups.length) return <GroupPanel user={user} groups={groups} activeGroup={null} onChanged={async (group) => { await loadProfile(group.id) }} fullScreen />

  return (
    <div className="app-shell">
      <main className="main-content">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div>
          <nav className="main-tabs" aria-label="主页面"><button className={activePage === 'ledger' ? 'main-tab active' : 'main-tab'} onClick={() => setActivePage('ledger')}><BookOpen size={16} />账本</button><button className={activePage === 'chat' ? 'main-tab active' : 'main-tab'} onClick={() => setActivePage('chat')}><MessageSquare size={16} />Chat</button></nav>
          <div className="account-actions"><label className="group-select-wrap"><UsersRound size={16} /><select aria-label="切换群组" value={activeGroupId || ''} onChange={(event) => setActiveGroupId(Number(event.target.value))}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><button className="icon-button" title="群组与邀请码" aria-label="群组与邀请码" onClick={() => setShowGroupPanel(true)}><UsersRound size={18} /></button><span className="account-user" title={user.username}>{user.displayName}</span><button className="icon-button" title="修改个人名字" aria-label="修改个人名字" onClick={() => { setProfileName(user.displayName); setProfileError(''); setShowProfilePanel(true) }}><UserRound size={18} /></button><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={18} /></button></div>
        </header>

        {activePage === 'ledger' ? <>
        <div className="page-heading">
          <div><h1>CoRec</h1></div>
          <button className="primary-button" onClick={() => setShowModal(true)}><Plus size={18} strokeWidth={2.5} />记一笔</button>
        </div>

        <section className="month-toolbar">
          <div className="month-picker"><button className="round-button" aria-label="上个月" onClick={() => shiftMonth(-1)}><ArrowLeft size={16} /></button><span>{monthLabel}</span><button className="round-button" aria-label="下个月" onClick={() => shiftMonth(1)}><ArrowRight size={16} /></button></div>
          <span className="view-label"><span className="live-dot" />{activeGroup?.name}</span>
        </section>

        <section className="ledger-section panel">
          <div className="section-header"><div><h2>账单明细</h2><p>{activeGroup?.name} 的共同账单</p></div><span className="ledger-count">{transactions.length} 笔</span></div>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="ledger-controls">
            <div className="ledger-filter-group">
              <div className="filter-tabs" aria-label="账目类型">
                {[['all', '全部'], ['expense', '支出'], ['income', '收入']].map(([value, label]) => <button key={value} className={typeFilter === value ? 'filter-tab active' : 'filter-tab'} onClick={() => { setTypeFilter(value); setActiveFilter('全部') }}>{label}</button>)}
              </div>
              <label className="category-filter"><span>分类</span><select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value)}><option value="全部">全部分类</option>{filterCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
            </div>
            <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索账单" aria-label="搜索账单" /></label>
          </div>
          <div className="transactions-list">
            {loading ? <div className="empty-state">正在加载账本…</div> : visibleTransactions.length ? visibleTransactions.map((item) => <TransactionRow key={item.id} item={item} today={today} onDelete={deleteTransaction} />) : <div className="empty-state">{transactions.length ? <>没有找到相关账单<div>换个关键词或分类试试</div></> : <>这个月还没有账单<div>记下群组的第一笔共同支出</div></>}</div>}
          </div>
          <button className="load-more" onClick={() => setShowModal(true)}><Plus size={16} />添加一笔新账单</button>
        </section>
        </> : <ChatPage key={activeGroupId} groupId={activeGroupId} groupName={activeGroup?.name || ''} members={members} user={user} onExpenseSaved={() => loadLedger(month)} />}
      </main>

      {showModal && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowModal(false)}>
        <form className={`expense-modal ${entryType === 'income' ? 'income-entry' : ''}`} onSubmit={addTransaction}>
          <div className="modal-head"><div><p className="eyebrow">{entryType === 'income' ? 'NEW INCOME' : 'NEW EXPENSE'}</p><h2>{entryType === 'income' ? '记一笔收入' : '记一笔共同支出'}</h2></div><button type="button" className="close-button" onClick={() => setShowModal(false)} aria-label="关闭"><X size={19} /></button></div>
          <div className="entry-type-switch" role="group" aria-label="账目类型"><button type="button" className={entryType === 'expense' ? 'active' : ''} onClick={() => { setEntryType('expense'); setEntryCategory('餐饮') }}>支出</button><button type="button" className={entryType === 'income' ? 'active income' : ''} onClick={() => { setEntryType('income'); setEntryCategory(incomeCategories[0]) }}>收入</button></div>
          <label className="amount-field"><span>金额</span><div><i>¥</i><input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" autoFocus required /></div></label>
          <div className="form-grid">
            <label><span>分类</span><select name="category" value={entryCategory} onChange={(event) => setEntryCategory(event.target.value)}>{(entryType === 'income' ? incomeCategories : Object.keys(categoryMeta)).map((item) => <option key={item}>{item}</option>)}</select></label>
            <label><span>{entryType === 'income' ? '收入归属' : '谁支付'}</span><select name="payerId" defaultValue={user.id}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>
            <label><span>日期</span><input name="date" type="date" defaultValue={today} required /></label>
          </div>
          <label><span>备注 <em>选填</em></span><input name="note" placeholder={entryType === 'income' ? '补充收入说明' : '写点这笔支出的来由'} maxLength="250" /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="primary-button modal-submit" type="submit" disabled={saving || !members.length}><Plus size={18} />{saving ? '保存中…' : entryType === 'income' ? '保存这笔收入' : '保存这笔支出'}</button>
        </form>
      </div>}
      {showGroupPanel && <GroupPanel user={user} groups={groups} activeGroup={activeGroup} onChanged={async (group) => { await loadProfile(group.id) }} onClose={() => setShowGroupPanel(false)} />}
      {showProfilePanel && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowProfilePanel(false)}><section className="group-panel profile-modal"><div className="group-panel-heading"><div className="account-icon"><UserRound size={20} /></div><div><p className="eyebrow">PERSONAL PROFILE</p><h2>修改个人名字</h2><p>这个名字会显示在群组成员和账单中。</p></div><button className="close-button" onClick={() => setShowProfilePanel(false)} aria-label="关闭"><X size={19} /></button></div><form className="account-form profile-form" onSubmit={updateDisplayName}><label><span>名字</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength="1" maxLength="32" autoComplete="name" required /></label>{profileError && <div className="error-banner" role="alert">{profileError}</div>}<button className="primary-button account-submit" type="submit" disabled={profileSaving}>{profileSaving ? '保存中…' : '保存名字'}</button></form></section></div>}
    </div>
  )
}

function TransactionRow({ item, today, onDelete }) {
  const isIncome = item.type === 'income'
  const meta = (isIncome ? incomeCategoryMeta : categoryMeta)[item.category] || categoryMeta['餐饮']
  const Icon = meta.icon
  const date = formatDate(item.date, today)
  const avatar = Number(item.payerId) % 2 === 0 ? 'blue' : 'coral'
  const initials = item.payer?.slice(0, 1) || '?'
  const title = item.merchant === item.category ? item.category : item.merchant
  return <div className={`transaction-row ${isIncome ? 'income-row' : ''}`}><div className="date-block"><strong>{date.date}</strong><span>{date.weekday}</span></div><div className="transaction-icon" style={{ background: meta.soft, color: meta.color }}><Icon size={19} /></div><div className="transaction-copy"><strong>{title}</strong><span>{item.note || (isIncome ? '共同收入' : '共同开销')}</span></div><div className="transaction-payer"><span className={`avatar avatar-${avatar}`}>{initials}</span><span>{item.payer}</span></div><strong className={isIncome ? 'transaction-amount income' : 'transaction-amount'}>{isIncome ? '+' : '−'} ¥{formatMoney(item.amount)}</strong><button className="row-more" aria-label={`${title}删除账单`} onClick={() => onDelete(item.id)} title="删除账单"><Trash2 size={16} /></button></div>
}

createRoot(document.getElementById('root')).render(<App />)
