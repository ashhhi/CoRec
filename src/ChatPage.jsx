import React, { useEffect, useRef, useState } from 'react'
import { Bot, Check, Send, Trash2 } from 'lucide-react'

const categories = ['餐饮', '交通', '娱乐', '居家', '购物']
const incomeCategories = ['工资', '奖金', '退款', '其他收入']

function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function loadStored(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function extractJson(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('模型返回格式无法识别，请重试或换一个模型。')
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    throw new Error('模型没有返回有效的账单内容，请重试。')
  }
}

function validateExpense(value, members, user) {
  if (!value || typeof value !== 'object') return null
  const type = value.type === 'income' ? 'income' : 'expense'
  const amount = Number(value.amount)
  const date = typeof value.date === 'string' ? value.date : ''
  const dateValue = new Date(`${date}T00:00:00Z`)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(dateValue.valueOf()) && dateValue.toISOString().slice(0, 10) === date
  if (!validDate || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error('模型生成的金额或日期无效，请补充信息后重试。')
  const validCategories = type === 'income' ? incomeCategories : categories
  if (!validCategories.includes(value.category)) throw new Error('模型生成的账目分类无效，请补充信息后重试。')
  const requestedPayer = members.find((member) => member.displayName === value.payerName)
  const payer = requestedPayer || members.find((member) => member.id === user.id) || members[0]
  return {
    type,
    date,
    amount,
    category: value.category,
    merchant: typeof value.merchant === 'string' && value.merchant.trim() ? value.merchant.trim().slice(0, 100) : value.category,
    note: typeof value.note === 'string' ? value.note.slice(0, 250) : '',
    payerId: payer?.id,
    payerName: payer?.displayName || '',
  }
}

async function parseExpense(messages, members, user, groupId) {
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const systemPrompt = `你是 CoRec 的共同账本助手。今天是 ${todayIso}。当前群组成员：${members.map((member) => `${member.displayName} (id=${member.id})`).join('、')}。支出分类：${categories.join('、')}。收入分类：${incomeCategories.join('、')}。理解用户自然语言，并只返回一个 JSON 对象，不要 Markdown。格式：{"reply":"给用户的简短中文回复","expense":null}；若用户明确要求记账且信息足够，返回 expense 对象，字段为 {"type":"expense 或 income","date":"YYYY-MM-DD","amount":数字,"category":"分类","merchant":"可选账单名称","note":"备注","payerName":"群组成员显示名字"}。支出使用支出分类，收入使用收入分类；未提供账单名称时 merchant 可以省略，CoRec 会使用分类作为名称。相对日期按今天换算。付款人或收入归属必须从群组成员中选择；未提成员时使用 ${user.displayName}。金额、日期或分类不明确时先追问，不要生成草稿。不要声称账单已保存，CoRec 会在用户确认后保存。`
  const inputMessages = [{ role: 'system', content: systemPrompt }, ...messages.slice(-14).map(({ role, content }) => ({ role, content }))]
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 60000)
  let response
  try {
    response = await fetch(`/api/groups/${groupId}/llm/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: inputMessages }),
    })
  } finally {
    window.clearTimeout(timeout)
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message || data.error || `模型请求失败（HTTP ${response.status}）。`)
  const content = data.output_text || (data.output
    ? data.output.flatMap((item) => item.content || []).filter((item) => typeof item.text === 'string').map((item) => item.text).join('\n')
    : null) || data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('模型没有返回文本，请检查模型配置。')
  const result = extractJson(content)
  return { reply: typeof result.reply === 'string' ? result.reply : '我理解了。', expense: validateExpense(result.expense, members, user) }
}

export default function ChatPage({ groupId, groupName, members, user, onExpenseSaved }) {
  const chatStorageKey = `corec_chat_${user.id}_${groupId}`
  const [messages, setMessages] = useState(() => loadStored(chatStorageKey, []))
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState('')
  const [modelConfig, setModelConfig] = useState({ loading: true, configured: false, model: '' })
  const [error, setError] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => {
    localStorage.removeItem('corec_llm_profiles')
    localStorage.removeItem('corec_llm_active_profile')
  }, [])
  useEffect(() => { localStorage.setItem(chatStorageKey, JSON.stringify(messages)) }, [chatStorageKey, messages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages, loading])

  useEffect(() => {
    let current = true
    setModelConfig({ loading: true, configured: false, model: '' })
    fetch(`/api/groups/${groupId}/llm/config`).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法读取后端模型配置。')
      if (current) setModelConfig({ loading: false, ...data })
    }).catch((configError) => {
      if (current) setModelConfig({ loading: false, configured: false, model: '', error: configError.message })
    })
    return () => { current = false }
  }, [groupId])

  async function sendMessage(event) {
    event.preventDefault()
    const content = input.trim()
    if (!content || loading) return
    if (!modelConfig.configured) {
      setError(modelConfig.error || '后端还没有配置模型，请检查 .env 中的 LLM 配置。')
      return
    }
    const userMessage = { id: createId(), role: 'user', content }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setError('')
    setLoading(true)
    try {
      const result = await parseExpense(nextMessages, members, user, groupId)
      setMessages((current) => [...current, {
        id: createId(),
        role: 'assistant',
        content: result.reply,
        expense: result.expense ? { ...result.expense, saved: false } : null,
      }])
    } catch (requestError) {
      setError(requestError.name === 'AbortError'
        ? '模型响应超时，请检查配置或稍后重试。'
        : requestError instanceof TypeError
          ? '无法连接 CoRec 服务，请检查页面连接或稍后重试。'
          : requestError.message || '模型请求失败。')
    } finally {
      setLoading(false)
    }
  }

  function updateDraftPayer(messageId, payerId) {
    const payer = members.find((member) => member.id === Number(payerId))
    setMessages((current) => current.map((message) => message.id === messageId && message.expense
      ? { ...message, expense: { ...message.expense, payerId: payer?.id, payerName: payer?.displayName || '' } }
      : message))
  }

  async function confirmExpense(message) {
    setSavingId(message.id)
    setError('')
    try {
      const response = await fetch(`/api/groups/${groupId}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...message.expense, payerId: message.expense.payerId }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '保存账单失败。')
      const typeLabel = message.expense.type === 'income' ? '收入' : '支出'
      setMessages((current) => [...current.map((item) => item.id === message.id ? { ...item, expense: { ...item.expense, saved: true } } : item), {
        id: createId(), role: 'assistant', content: `已把这笔${typeLabel}记入 ${groupName}。`,
      }])
      await onExpenseSaved()
    } catch (saveError) {
      setError(saveError.message || '保存账单失败。')
    } finally {
      setSavingId('')
    }
  }

  function clearConversation() {
    if (!messages.length || window.confirm('清空这段群组对话？')) setMessages([])
  }

  return <section className="chat-page">
    <header className="chat-header"><div><p className="eyebrow">COREC CHAT</p><h1>Chat</h1><p>{groupName} · 账单助手</p></div><div className="chat-controls"><span className="model-label">{modelConfig.loading ? '读取模型配置…' : modelConfig.configured ? modelConfig.model : '模型未配置'}</span><button className="icon-button" onClick={clearConversation} title="清空对话" aria-label="清空对话"><Trash2 size={17} /></button></div></header>
    <div className="chat-thread">
      {!messages.length && <div className="chat-welcome"><div className="chat-welcome-icon"><Bot size={23} /></div><h2>今天这笔怎么记？</h2><p>描述金额、类型和成员，我会整理成账单草稿供你确认。</p><div className="chat-suggestions"><button onClick={() => setInput('刚才我和阿禾吃饭花了 168 元，记到餐饮里')}>晚餐 168 元，记到餐饮</button><button onClick={() => setInput('昨天我付了 36 元打车费，帮我记一笔')}>昨天打车 36 元</button><button onClick={() => setInput('我今天收到工资 8000 元，记一笔收入')}>收到工资 8000 元</button></div></div>}
      {messages.map((message) => {
        const isIncome = message.expense?.type === 'income'
        return <article className={`chat-message ${message.role}`} key={message.id}>
          <div className="message-avatar">{message.role === 'assistant' ? <Bot size={17} /> : user.displayName.slice(0, 1)}</div>
          <div className="message-content">
            <div className="message-author">{message.role === 'assistant' ? 'CoRec' : user.displayName}</div>
            <p className="message-text">{message.content}</p>
            {message.expense && <div className={message.expense.saved ? 'expense-draft saved' : 'expense-draft'}>
              <div className="draft-heading"><strong>{message.expense.saved ? `已记入${isIncome ? '收入' : '支出'}` : `待确认${isIncome ? '收入' : '支出'}`}</strong><span>{message.expense.category}</span></div>
              <div className="draft-main"><strong>{message.expense.merchant}</strong><b className={isIncome ? 'income-amount' : ''}>{isIncome ? '+' : '−'} ¥{Number(message.expense.amount).toFixed(2)}</b></div>
              <div className="draft-meta"><span>{message.expense.date}</span><span>{message.expense.note || '无备注'}</span></div>
              {!message.expense.saved && <div className="draft-actions"><label><span>{isIncome ? '收入归属' : '付款人'}</span><select value={message.expense.payerId} onChange={(event) => updateDraftPayer(message.id, event.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><button className="primary-button" onClick={() => confirmExpense(message)} disabled={savingId === message.id}><Check size={16} />{savingId === message.id ? '保存中…' : `确认${isIncome ? '收入' : '记账'}`}</button></div>}
            </div>}
          </div>
        </article>
      })}
      {loading && <div className="chat-typing"><span /><span /><span />正在整理账单…</div>}
      <div ref={bottomRef} />
    </div>
    <div className="chat-compose-area">{error && <div className="error-banner" role="alert">{error}</div>}{!modelConfig.loading && !modelConfig.configured && <div className="chat-key-notice">{modelConfig.error || '后端尚未配置模型，请在 .env 中填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 和 LLM_API_FORMAT。'}</div>}<form className="chat-compose" onSubmit={sendMessage}><textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }} placeholder="描述你要记录的账单…" rows={2} disabled={!modelConfig.configured || modelConfig.loading || loading} /><button className="send-button" type="submit" aria-label="发送" disabled={!input.trim() || loading || !modelConfig.configured || modelConfig.loading}><Send size={18} /></button></form><p className="chat-disclaimer">AI 会先生成账单草稿，确认后才写入群组账本。</p></div>

  </section>
}
