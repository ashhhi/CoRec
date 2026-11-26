import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  BookOpen,
  BriefcaseBusiness,
  CircleDollarSign,
  CheckSquare,
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
import { AuthScreen, GroupAddMenu, GroupEntryDialog, GroupPanel } from './AccountViews.jsx'
import ChatPage from './ChatPage.jsx'
import TasksPage from './TasksPage.jsx'
import LedgerColumnFilter from './LedgerColumnFilter.jsx'
import LedgerCalendar from './LedgerCalendar.jsx'
import { filterLedger, ledgerMemberOptions } from './ledgerFilters.js'
import { describeDuplicate, saveExpense } from './expenseApi.js'
import './styles.css'

const categoryMeta = {
  餐饮: { icon: Utensils, color: '#ef8b72', soft: '#fff0eb' },
  交通: { icon: TrainFront, color: '#6d8db6', soft: '#edf3fb' },
  娱乐: { icon: Sparkles, color: '#bb8cce', soft: '#f5eef9' },
  购物: { icon: ShoppingBag, color: '#d6a15f', soft: '#fff6e8' },
  居住: { icon: Home, color: '#72a586', soft: '#edf7ef' },
  其他: { icon: CircleDollarSign, color: '#8c9d62', soft: '#f2f5e8' },
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
  const [selectedMonth, setSelectedMonth] = useState(() => localMonth(new Date()))
  const [allMonths, setAllMonths] = useState(false)
  const [transactions, setTransactions] = useState([])
  const [groupBalance, setGroupBalance] = useState(0)
  const [typeFilter, setTypeFilter] = useState('all')
  const [selectedCategories, setSelectedCategories] = useState(null)
  const [selectedMembers, setSelectedMembers] = useState(null)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState(null)
  const [entryType, setEntryType] = useState('expense')
  const [entryCategory, setEntryCategory] = useState('餐饮')
  const [showGroupPanel, setShowGroupPanel] = useState(false)
  const [groupEntryMode, setGroupEntryMode] = useState(null)
  const [showProfilePanel, setShowProfilePanel] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [profileError, setProfileError] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const ledgerRequest = useRef(0)
  const topbarRef = useRef(null)

  useEffect(() => {
    const header = topbarRef.current
    if (!header) return
    const updateHeight = () => header.parentElement?.style.setProperty('--topbar-height', `${header.getBoundingClientRect().height}px`)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(header)
    return () => observer.disconnect()
  }, [user?.id, groups.length > 0])

  const today = localDate(new Date())
  const month = allMonths ? 'all' : selectedMonth
  const activeGroup = groups.find((group) => group.id === activeGroupId) || null
  const members = groupInfo?.members || []
  const filterCategories = typeFilter === 'income'
    ? incomeCategories
    : typeFilter === 'expense'
      ? Object.keys(categoryMeta)
      : [...Object.keys(categoryMeta), ...incomeCategories]
  const monthLabel = new Date(`${selectedMonth}-01T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
  const memberOptions = ledgerMemberOptions(members, transactions)
  const visibleTransactions = filterLedger(transactions, { type: typeFilter, categories: selectedCategories, members: selectedMembers, search })
  const hasColumnFilters = selectedCategories !== null || selectedMembers !== null
  const monthIncome = transactions.reduce((total, item) => total + (item.type === 'income' ? Number(item.amount) : 0), 0)
  const monthExpense = transactions.reduce((total, item) => total + (item.type === 'income' ? 0 : Number(item.amount)), 0)

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
    setSelectedCategories(null)
    setSelectedMembers(null)
  }, [activeGroupId])

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
    const requestId = ++ledgerRequest.current
    if (!user || !activeGroupId) {
      setTransactions([])
      setGroupBalance(0)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/groups/${activeGroupId}/ledger?month=${encodeURIComponent(monthToLoad)}`)
      const data = await readJson(response)
      if (requestId !== ledgerRequest.current) return
      setTransactions(data.expenses)
      setGroupBalance(Number(data.balance) || 0)
    } catch (loadError) {
      if (requestId !== ledgerRequest.current) return
      setError(loadError.message || '无法连接账本服务。')
      if (loadError.message.includes('登录')) setUser(null)
    } finally {
      if (requestId === ledgerRequest.current) setLoading(false)
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
      const expense = {
          date: form.get('date'),
          time: form.get('time') || null,
          merchant: form.get('category'),
          productName: form.get('productName'),
          note: form.get('note'),
          category: form.get('category'),
          amount: form.get('amount'),
          payerId: form.get('payerId'),
          type: entryType,
      }
      let result = await saveExpense(activeGroupId, expense)
      while (result.duplicates) {
        const details = result.duplicates.map(describeDuplicate).join('\n')
        if (!window.confirm(`发现可能重复的账单：\n${details}\n\n仍要保存吗？`)) return
        result = await saveExpense(activeGroupId, expense, result.duplicates.map((item) => item.id))
      }
      setShowModal(false)
      const expenseMonth = result.expense.date.slice(0, 7)
      if (allMonths) await loadLedger(month)
      else if (expenseMonth !== selectedMonth) setSelectedMonth(expenseMonth)
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
    if (allMonths) return
    const date = new Date(`${selectedMonth}-01T12:00:00`)
    date.setMonth(date.getMonth() + offset)
    setSelectedMonth(localMonth(date))
  }

  function selectTransactionType(type) {
    if (type === typeFilter) return
    setSelectedCategories(null)
    setTypeFilter(type)
  }

  function closeGroupEntry() {
    setGroupEntryMode(null)
    document.getElementById('group-add-trigger')?.focus()
  }

  if (authLoading) return <main className="account-page"><div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div><div className="account-loading">正在连接 CoRec…</div></main>
  if (!user) return <AuthScreen onAuthenticated={async () => { await loadProfile() }} />
  if (!groups.length) return <GroupPanel user={user} groups={groups} activeGroup={null} onChanged={async (group) => { await loadProfile(group?.id) }} fullScreen />

  return (
    <div className="app-shell">
      <main className="main-content">
        <header ref={topbarRef} className="topbar">
          <div className="brand"><span className="brand-mark">co</span><span>CoRec</span></div>
          <nav className="main-tabs" aria-label="主页面"><button className={activePage === 'ledger' ? 'main-tab active' : 'main-tab'} onClick={() => setActivePage('ledger')}><BookOpen size={16} />账本</button><button className={activePage === 'tasks' ? 'main-tab active' : 'main-tab'} onClick={() => setActivePage('tasks')}><CheckSquare size={16} />任务</button><button className={activePage === 'chat' ? 'main-tab active' : 'main-tab'} onClick={() => setActivePage('chat')}><MessageSquare size={16} />Chat</button></nav>
          <div className="account-actions">
            <label className="group-select-wrap"><select aria-label="切换群组" value={activeGroupId || ''} onChange={(event) => setActiveGroupId(Number(event.target.value))}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <button type="button" className="icon-button" title="群组设置" aria-label="群组设置" onClick={() => setShowGroupPanel(true)}><UsersRound size={18} /></button>
            <GroupAddMenu onSelect={setGroupEntryMode} />
            <span className="account-user" title={user.username}>{user.displayName}</span>
            <button type="button" className="icon-button" title="修改个人名字" aria-label="修改个人名字" onClick={() => { setProfileName(user.displayName); setProfileError(''); setShowProfilePanel(true) }}><UserRound size={18} /></button>
            <button type="button" className="icon-button" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={18} /></button>
          </div>
        </header>

        {activePage === 'ledger' ? <>
        <section className="month-toolbar">
          <div className="month-picker">
            <button className="round-button" aria-label="上个月" onClick={() => shiftMonth(-1)} disabled={allMonths}><ArrowLeft size={16} /></button>
            <span>{monthLabel}</span>
            <button className="round-button" aria-label="下个月" onClick={() => shiftMonth(1)} disabled={allMonths}><ArrowRight size={16} /></button>
            <button type="button" className="month-scope-button" aria-pressed={allMonths} onClick={() => setAllMonths((current) => !current)}>全部账单</button>
          </div>
        </section>

        <section className="balance-summary" aria-label="账本余额">
          <div className="balance-primary"><span>累计结余</span><strong className={groupBalance < 0 ? 'negative-balance' : ''}>{groupBalance < 0 ? '− ' : ''}¥{formatMoney(Math.abs(groupBalance))}</strong><small>累计收入减累计支出</small></div>
          <div className="balance-stat"><span>{allMonths ? '全部收入' : '本月收入'}</span><strong className="income-text">+ ¥{formatMoney(monthIncome)}</strong></div>
          <div className="balance-stat"><span>{allMonths ? '全部支出' : '本月支出'}</span><strong>− ¥{formatMoney(monthExpense)}</strong></div>
        </section>

        <section className="ledger-section panel">
          <div className="section-header"><div><h2>账单明细</h2><p>{activeGroup?.name} 的共同账单</p></div><span className="ledger-count" aria-live="polite">{visibleTransactions.length === transactions.length ? `${transactions.length} 笔` : `${visibleTransactions.length} / ${transactions.length} 笔`}</span></div>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="ledger-controls">
            <div className="ledger-filter-group">
              <div className="filter-tabs" role="group" aria-label="账单类型">
                {[['all', '全部'], ['expense', '支出'], ['income', '收入']].map(([value, label]) => (
                  <button type="button" key={value} className="filter-tab" aria-pressed={typeFilter === value} onClick={() => selectTransactionType(value)}>{label}</button>
                ))}
              </div>
              {hasColumnFilters && <button type="button" className="clear-ledger-filters" onClick={() => { setSelectedCategories(null); setSelectedMembers(null) }}>清除分类与成员筛选</button>}
            </div>
            <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="按商品名筛选" aria-label="按商品名筛选" /></label>
          </div>
          <div className="transactions-list">
            <div className="transaction-header"><span>日期</span><span className="transaction-header-icon" /><LedgerColumnFilter key={`category:${activeGroupId}:${typeFilter}`} label="分类" options={filterCategories.map((category) => ({ value: category, label: category }))} selected={selectedCategories} onChange={setSelectedCategories} /><span>商品</span><span>商家</span><LedgerColumnFilter key={`member:${activeGroupId}`} label="成员" options={memberOptions} selected={selectedMembers} onChange={setSelectedMembers} align="right" /><span className="transaction-header-amount">金额</span><span /></div>
            {loading ? <div className="empty-state">正在加载账本…</div> : visibleTransactions.length ? visibleTransactions.map((item) => <TransactionRow key={item.id} item={item} today={today} onDelete={deleteTransaction} onOpen={setSelectedTransaction} />) : <div className="empty-state">{transactions.length ? <>没有找到相关账单<div>调整分类、成员或商品名筛选试试</div></> : <>{allMonths ? '还没有账单' : '这个月还没有账单'}<div>记下群组的第一笔共同支出</div></>}</div>}
          </div>
          <button className="load-more" onClick={() => setShowModal(true)}><Plus size={16} />添加一笔新账单</button>
        </section>
        {!allMonths && <LedgerCalendar key={`${activeGroupId}:${selectedMonth}`} month={selectedMonth} transactions={transactions} today={today} loading={loading} />}
        <LedgerCharts groupId={activeGroupId} month={month} />
        </> : activePage === 'tasks' ? <TasksPage key={activeGroupId} groupId={activeGroupId} groupName={activeGroup?.name || ''} members={members} user={user} role={activeGroup?.role} /> : <ChatPage key={activeGroupId} groupId={activeGroupId} groupName={activeGroup?.name || ''} members={members} user={user} onExpenseSaved={() => loadLedger(month)} />}
      </main>

      {selectedTransaction && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedTransaction(null)}><section className="expense-modal transaction-detail" role="dialog" aria-modal="true" aria-labelledby="transaction-detail-title"><div className="modal-head"><h2 id="transaction-detail-title">账单详情</h2><button type="button" className="close-button" onClick={() => setSelectedTransaction(null)} aria-label="关闭"><X size={19} /></button></div><dl>{[['类型', selectedTransaction.type === 'income' ? '收入' : '支出'], ['金额', `¥${formatMoney(selectedTransaction.amount)}`], ['分类', selectedTransaction.category], ['商品名', selectedTransaction.productName || '未填写'], ['商家', selectedTransaction.merchant && selectedTransaction.merchant !== selectedTransaction.category ? selectedTransaction.merchant : '未填写'], ['日期', selectedTransaction.date], ['时间', selectedTransaction.time || '未记录'], [selectedTransaction.type === 'income' ? '收入归属' : '付款人', selectedTransaction.payer], ['备注', selectedTransaction.note || '无']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section></div>}

      {showModal && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowModal(false)}>
        <form className={`expense-modal ${entryType === 'income' ? 'income-entry' : ''}`} onSubmit={addTransaction}>
          <div className="modal-head"><div><p className="eyebrow">{entryType === 'income' ? 'NEW INCOME' : 'NEW EXPENSE'}</p><h2>{entryType === 'income' ? '记一笔收入' : '记一笔共同支出'}</h2></div><button type="button" className="close-button" onClick={() => setShowModal(false)} aria-label="关闭"><X size={19} /></button></div>
          <div className="entry-type-switch" role="group" aria-label="账目类型"><button type="button" className={entryType === 'expense' ? 'active' : ''} onClick={() => { setEntryType('expense'); setEntryCategory('餐饮') }}>支出</button><button type="button" className={entryType === 'income' ? 'active income' : ''} onClick={() => { setEntryType('income'); setEntryCategory(incomeCategories[0]) }}>收入</button></div>
          <label className="amount-field"><span>金额</span><div><i>¥</i><input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" autoFocus required /></div></label>
          <div className="form-grid">
            <label><span>分类</span><select name="category" value={entryCategory} onChange={(event) => setEntryCategory(event.target.value)}>{(entryType === 'income' ? incomeCategories : Object.keys(categoryMeta)).map((item) => <option key={item}>{item}</option>)}</select></label>
            <label><span>{entryType === 'income' ? '收入归属' : '谁支付'}</span><select name="payerId" defaultValue={user.id}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>
            <label><span>日期</span><input name="date" type="date" defaultValue={today} required /></label>
            <label><span>时间</span><input name="time" type="time" defaultValue={`${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`} required /></label>
            <label><span>商品名 <em>选填</em></span><input name="productName" placeholder="输入商品名" maxLength="100" /></label>
          </div>
          <label><span>备注 <em>选填</em></span><input name="note" placeholder={entryType === 'income' ? '补充收入说明' : '写点这笔支出的来由'} maxLength="250" /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button className="primary-button modal-submit" type="submit" disabled={saving || !members.length}><Plus size={18} />{saving ? '保存中…' : entryType === 'income' ? '保存这笔收入' : '保存这笔支出'}</button>
        </form>
      </div>}
      {showGroupPanel && <GroupPanel user={user} groups={groups} activeGroup={activeGroup} onChanged={async (group) => { await loadProfile(group?.id) }} onClose={() => setShowGroupPanel(false)} />}
      {groupEntryMode && <GroupEntryDialog key={groupEntryMode} mode={groupEntryMode} groups={groups} onChanged={async (group) => { await loadProfile(group?.id) }} onClose={closeGroupEntry} />}
      {showProfilePanel && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowProfilePanel(false)}><section className="group-panel profile-modal"><div className="group-panel-heading"><div className="account-icon"><UserRound size={20} /></div><div><p className="eyebrow">PERSONAL PROFILE</p><h2>修改个人名字</h2><p>这个名字会显示在群组成员和账单中。</p></div><button className="close-button" onClick={() => setShowProfilePanel(false)} aria-label="关闭"><X size={19} /></button></div><form className="account-form profile-form" onSubmit={updateDisplayName}><label><span>名字</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} minLength="1" maxLength="32" autoComplete="name" required /></label>{profileError && <div className="error-banner" role="alert">{profileError}</div>}<button className="primary-button account-submit" type="submit" disabled={profileSaving}>{profileSaving ? '保存中…' : '保存名字'}</button></form></section></div>}
    </div>
  )
}

function TransactionRow({ item, today, onDelete, onOpen }) {
  const isIncome = item.type === 'income'
  const meta = (isIncome ? incomeCategoryMeta : categoryMeta)[item.category] || categoryMeta['餐饮']
  const Icon = meta.icon
  const date = formatDate(item.date, today)
  const avatar = Number(item.payerId) % 2 === 0 ? 'blue' : 'coral'
  const initials = item.payer?.slice(0, 1) || '?'
  const title = item.productName || '-'
  const merchant = item.merchant && item.merchant !== item.category ? item.merchant : '-'
  return <div className={`transaction-row ${isIncome ? 'income-row' : ''}`}><div className="date-block"><strong>{date.date}</strong><span>{date.weekday}{item.time ? ` ${item.time}` : ''}</span></div><div className="transaction-icon" style={{ background: meta.soft, color: meta.color }}><Icon size={19} /></div><div className="transaction-merchant" title={item.category}><strong>{item.category}</strong></div><button type="button" className="transaction-copy transaction-open" onClick={() => onOpen(item)} aria-label={`查看${item.productName || item.category}账单详情`} title={title}><strong>{title}</strong></button><div className="transaction-merchant" title={merchant}><strong>{merchant}</strong></div><div className="transaction-payer"><span className={`avatar avatar-${avatar}`}>{initials}</span><span>{item.payer}</span></div><strong className={isIncome ? 'transaction-amount income' : 'transaction-amount'}>{isIncome ? '+' : '−'} ¥{formatMoney(item.amount)}</strong><button className="row-more" aria-label={`${item.productName || item.category}删除账单`} onClick={() => onDelete(item.id)} title="删除账单"><Trash2 size={16} /></button></div>
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return `${month}-${String(lastDay).padStart(2, '0')}`
}

function addUtcDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function makeBuckets(from, to, granularity) {
  let cursor = from
  if (granularity === 'week') {
    const weekday = (new Date(`${from}T00:00:00Z`).getUTCDay() + 6) % 7
    cursor = addUtcDays(from, -weekday)
  } else if (granularity === 'month') {
    cursor = `${from.slice(0, 7)}-01`
  }
  const buckets = []
  while (cursor <= to) {
    buckets.push(cursor)
    if (granularity === 'day') cursor = addUtcDays(cursor, 1)
    else if (granularity === 'week') cursor = addUtcDays(cursor, 7)
    else {
      const date = new Date(`${cursor}T00:00:00Z`)
      date.setUTCMonth(date.getUTCMonth() + 1)
      cursor = date.toISOString().slice(0, 10)
    }
  }
  return buckets
}

function formatBucketLabel(value, granularity) {
  if (granularity === 'month') return value.slice(0, 7).replace('-', '/')
  const date = new Date(`${value}T00:00:00Z`)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

function formatAxisMoney(value) {
  if (value >= 100000) return `${Math.round(value / 10000)}万`
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
  return Math.round(value).toLocaleString('zh-CN')
}

function PieChart({ categories, total }) {
  const slices = categories.map((item) => ({ ...item, color: categoryMeta[item.category]?.color || '#9ba69e' }))
  let angle = -90
  const paths = slices.map((slice) => {
    const sweep = slice.amount / total * 360
    const start = angle * Math.PI / 180
    const end = (angle + sweep) * Math.PI / 180
    angle += sweep
    const outerStart = [110 + 86 * Math.cos(start), 110 + 86 * Math.sin(start)]
    const outerEnd = [110 + 86 * Math.cos(end), 110 + 86 * Math.sin(end)]
    const innerEnd = [110 + 50 * Math.cos(end), 110 + 50 * Math.sin(end)]
    const innerStart = [110 + 50 * Math.cos(start), 110 + 50 * Math.sin(start)]
    const largeArc = sweep > 180 ? 1 : 0
    return { ...slice, d: `M ${outerStart[0]} ${outerStart[1]} A 86 86 0 ${largeArc} 1 ${outerEnd[0]} ${outerEnd[1]} L ${innerEnd[0]} ${innerEnd[1]} A 50 50 0 ${largeArc} 0 ${innerStart[0]} ${innerStart[1]} Z` }
  })
  return <div className="pie-chart-wrap">
    <svg className="pie-chart" viewBox="0 0 220 220" role="img" aria-label={`支出分类总额 ¥${formatMoney(total)}`}>
      {slices.length === 1 ? <><circle cx="110" cy="110" r="86" fill={slices[0].color} /><circle cx="110" cy="110" r="50" fill="#fffefa" /></> : paths.map((slice) => <path key={slice.category} d={slice.d} fill={slice.color} stroke="#fffefa" strokeWidth="2"><title>{slice.category} ¥{formatMoney(slice.amount)}</title></path>)}
      <text x="110" y="104" textAnchor="middle" className="pie-center-label">支出</text>
      <text x="110" y="127" textAnchor="middle" className="pie-center-total">¥{formatMoney(total)}</text>
    </svg>
    <div className="pie-legend">{slices.map((slice) => <div className="pie-legend-row" key={slice.category}><span className="pie-legend-name"><i style={{ background: slice.color }} />{slice.category}</span><strong>¥{formatMoney(slice.amount)}</strong><small>{Math.round(slice.amount / total * 100)}%</small></div>)}</div>
  </div>
}

function TrendChart({ timeline, from, to, granularity }) {
  const buckets = makeBuckets(from, to, granularity)
  const byDate = new Map(timeline.map((item) => [`${item.date}:${item.type}`, item.amount]))
  const points = buckets.map((date) => ({
    date,
    income: byDate.get(`${date}:income`) || 0,
    expense: byDate.get(`${date}:expense`) || 0,
  }))
  const maximum = Math.max(0, ...points.flatMap((item) => [item.income, item.expense]))
  const roughStep = maximum / 4 || 1
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const step = Math.ceil(roughStep / magnitude) * magnitude
  const axisMaximum = step * 4
  const left = 48
  const right = 12
  const top = 14
  const bottom = 34
  const width = 640 - left - right
  const height = 230 - top - bottom
  const pointAt = (index, value) => ({
    x: left + (points.length > 1 ? index / (points.length - 1) : 0.5) * width,
    y: top + (1 - value / axisMaximum) * height,
  })
  const seriesPoints = (key) => points.map((item, index) => pointAt(index, item[key]))
  const incomePoints = seriesPoints('income')
  const expensePoints = seriesPoints('expense')
  const xLabels = [...new Set([0, Math.round((points.length - 1) / 4), Math.round((points.length - 1) / 2), Math.round((points.length - 1) * 3 / 4), points.length - 1])]
  const hasData = timeline.length > 0
  return <div className="trend-chart-wrap">
    {!hasData ? <div className="chart-empty">所选时间范围没有收支记录</div> : <svg className="trend-chart" viewBox="0 0 640 230" role="img" aria-label={`按${granularity === 'day' ? '日' : granularity === 'week' ? '周' : '月'}统计的收入与支出`}>
      {[0, 1, 2, 3, 4].map((tick) => {
        const y = top + height * tick / 4
        const value = axisMaximum * (4 - tick) / 4
        return <g key={tick}><line x1={left} y1={y} x2={left + width} y2={y} className="chart-grid-line" /><text x={left - 8} y={y + 4} textAnchor="end" className="chart-axis-label">{formatAxisMoney(value)}</text></g>
      })}
      <polyline points={incomePoints.map((point) => `${point.x},${point.y}`).join(' ')} className="trend-line income-line" />
      <polyline points={expensePoints.map((point) => `${point.x},${point.y}`).join(' ')} className="trend-line expense-line" />
      {incomePoints.map((point, index) => <circle key={`i-${points[index].date}`} cx={point.x} cy={point.y} r="2.5" className="trend-point income-point"><title>{formatBucketLabel(points[index].date, granularity)} 收入 ¥{formatMoney(points[index].income)}</title></circle>)}
      {expensePoints.map((point, index) => <circle key={`e-${points[index].date}`} cx={point.x} cy={point.y} r="2.5" className="trend-point expense-point"><title>{formatBucketLabel(points[index].date, granularity)} 支出 ¥{formatMoney(points[index].expense)}</title></circle>)}
      {xLabels.map((index) => <text key={index} x={pointAt(index, 0).x} y={top + height + 23} textAnchor="middle" className="chart-axis-label">{formatBucketLabel(points[index].date, granularity)}</text>)}
    </svg>}
  </div>
}

function LedgerCharts({ groupId, month }) {
  const allMonths = month === 'all'
  const [from, setFrom] = useState(allMonths ? '2000-01-01' : `${month}-01`)
  const [to, setTo] = useState(allMonths ? localDate(new Date()) : monthEnd(month))
  const [granularity, setGranularity] = useState('day')
  const [analytics, setAnalytics] = useState({ categories: [], timeline: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const rangeValid = Boolean(from && to && from <= to)

  useEffect(() => {
    setFrom(allMonths ? '2000-01-01' : `${month}-01`)
    setTo(allMonths ? localDate(new Date()) : monthEnd(month))
  }, [month, allMonths])

  useEffect(() => {
    if (!rangeValid) {
      setError('结束日期需晚于或等于开始日期。')
      return
    }
    let current = true
    const query = new URLSearchParams({ from, to, granularity })
    setLoading(true)
    setError('')
    fetch(`/api/groups/${groupId}/analytics?${query}`).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '加载统计数据失败。')
      if (current) setAnalytics(data)
    }).catch((loadError) => {
      if (current) setError(loadError.message || '加载统计数据失败。')
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [groupId, from, to, granularity, rangeValid])

  const categories = analytics.categories || []
  const totalExpense = categories.reduce((sum, item) => sum + Number(item.amount), 0)
  const monthLabel = allMonths ? '全部时间' : `${from} 至 ${to}`
  return <section className="analytics-section" aria-label="收支统计">
    <div className="analytics-toolbar">
      <div><p className="eyebrow">LEDGER ANALYTICS</p><h2>收支统计</h2></div>
      <div className="analytics-controls">
        <div className="date-range-control">
          <label><span>开始日期</span><input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} aria-label="统计开始日期" /></label>
          <label><span>结束日期</span><input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} aria-label="统计结束日期" /></label>
        </div>
        <div className="granularity-control" role="group" aria-label="时间颗粒度">{[['day', '日'], ['week', '周'], ['month', '月']].map(([value, label]) => <button type="button" key={value} className={granularity === value ? 'active' : ''} aria-pressed={granularity === value} onClick={() => setGranularity(value)}>{label}</button>)}</div>
      </div>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className={`chart-grid ${loading ? 'charts-loading' : ''}`}>
      <article className="chart-panel">
        <header className="chart-panel-heading"><div><h3>支出分类</h3><p>{monthLabel}</p></div><span>{categories.length} 类</span></header>
        {totalExpense > 0 ? <PieChart categories={categories} total={totalExpense} /> : <div className="chart-empty">所选时间范围没有支出记录</div>}
      </article>
      <article className="chart-panel">
        <header className="chart-panel-heading"><div><h3>收支趋势</h3><p>{monthLabel}</p></div><span>{granularity === 'day' ? '按日' : granularity === 'week' ? '按周' : '按月'}</span></header>
        <div className="chart-legend"><span><i className="legend-income" />收入</span><span><i className="legend-expense" />支出</span></div>
        <TrendChart timeline={analytics.timeline || []} from={from} to={to} granularity={granularity} />
      </article>
    </div>
  </section>
}

createRoot(document.getElementById('root')).render(<App />)
