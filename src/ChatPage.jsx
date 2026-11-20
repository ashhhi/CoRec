import React, { useEffect, useRef, useState } from 'react'
import { Bot, Check, ImagePlus, Send, Trash2, X } from 'lucide-react'
import { describeDuplicate, saveExpense } from './expenseApi.js'

const categories = ['餐饮', '交通', '娱乐', '购物', '居住', '其他']
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
  if (!['expense', 'income'].includes(value.type)) throw new Error('请问这笔账单是收入还是支出？')
  const type = value.type
  const amount = Number(value.amount)
  const date = typeof value.date === 'string' ? value.date : ''
  const time = typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) ? value.time : null
  const dateValue = new Date(`${date}T00:00:00Z`)
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(dateValue.valueOf()) && dateValue.toISOString().slice(0, 10) === date
  if (!validDate || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error('请补充有效的账单日期和金额。')
  const validCategories = type === 'income' ? incomeCategories : categories
  if (!validCategories.includes(value.category)) throw new Error('请补充这笔账单的分类。')
  const requestedPayer = members.find((member) => member.displayName === value.payerName)
  const payer = requestedPayer || members.find((member) => member.id === user.id) || members[0]
  return {
    type,
    date,
    time,
    amount,
    category: value.category,
    merchant: typeof value.merchant === 'string' && value.merchant.trim() ? value.merchant.trim().slice(0, 100) : value.category,
    productName: typeof value.productName === 'string' ? value.productName.trim().slice(0, 100) : '',
    note: typeof value.note === 'string' ? value.note.slice(0, 250) : '',
    payerId: payer?.id,
    payerName: payer?.displayName || '',
  }
}

async function parseExpense(messages, members, user, groupId) {
  const today = new Date()
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const systemPrompt = `你是 CoRec 的共同账本助手。今天是 ${todayIso}。当前群组成员：${members.map((member) => `${member.displayName} (id=${member.id})`).join('、')}。支出分类：${categories.join('、')}。收入分类：${incomeCategories.join('、')}。只返回一个 JSON 对象，不要 Markdown。格式：{"reply":"给用户的简短中文回复","expense":null}。用户上传图片时，默认用户希望提取图片中的账单并记账，除非用户明确提出其他用途。结合图片、文字和后续回答提取信息；若图片难以辨认，或收支类型、实际金额、日期、分类无法确定，直接向用户询问缺失信息，expense 必须为 null，不要猜测金额或日期。信息齐全后返回 expense 对象，字段为 {"type":"expense 或 income","date":"YYYY-MM-DD","time":"HH:mm 或 null","amount":数字,"category":"分类","merchant":"商家名称，可省略","productName":"商品名，可省略","note":"备注","payerName":"群组成员显示名字"}。商家名称和商品名分别填写；merchant 只能填写明确出现的实际商家名称，不能填消费描述，例如“和阿禾吃饭”或“打车”，此类描述可放在 note。不要将商家名称填入商品名；商品名不明确时留空。仅在图片或用户明确提供时间时填写 24 小时制 time，否则填 null。支出使用支出分类，收入使用收入分类；未提供商家名称时 merchant 可以省略。相对日期按今天换算。付款人或收入归属必须从群组成员中选择；未提成员时使用 ${user.displayName}。文本记账也要在信息不足时追问。不要声称账单已保存，系统会负责保存。`
  const recent = messages.slice(-14)
  const lastImageId = [...recent].reverse().find((message) => message.image)?.id
  const inputMessages = [{ role: 'system', content: systemPrompt }, ...recent.map(({ id, role, content, image }) => ({ role, content: content || (image ? '请提取这张图片中的账单并记账；信息不足时询问缺失信息。' : ''), ...(id === lastImageId ? { image } : {}) }))]
  async function requestModel(input) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 60000)
    let response
    try {
      response = await fetch(`/api/groups/${groupId}/llm/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: input }),
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
    return extractJson(content)
  }
  let result = await requestModel(inputMessages)
  const latestMessage = messages[messages.length - 1]
  const isImageOnly = Boolean(latestMessage?.image && !latestMessage.content.trim())
  const asksForInformation = (reply) => typeof reply === 'string' && /[?？]|请(?:问|补充|提供|确认|告知|说明|填写)|能否|是否/.test(reply)
  if (isImageOnly && !result.expense && !asksForInformation(result.reply)) {
    const retryMessages = inputMessages.map((message, index) => index === 0 ? {
      ...message,
      content: `${message.content} 用户刚刚仅发送图片，即要求记账。不要只描述图片：如果图片中能确定收支类型、金额、日期及分类，必须在 expense 中填写这些字段；否则 reply 必须明确询问无法确定的字段，expense 为 null。`,
    } : message)
    result = await requestModel(retryMessages)
    if (!result.expense && !asksForInformation(result.reply)) {
      result.reply = `${typeof result.reply === 'string' ? `${result.reply}\n` : ''}请补充这笔账单的收支类型、金额、日期和分类，以便记账。`
    }
  }
  try {
    return { reply: typeof result.reply === 'string' ? result.reply : '我理解了。', expense: validateExpense(result.expense, members, user) }
  } catch (validationError) {
    return { reply: validationError.message, expense: null }
  }
}

export default function ChatPage({ groupId, groupName, members, user, onExpenseSaved }) {
  const chatStorageKey = `corec_chat_${user.id}_${groupId}`
  const [messages, setMessages] = useState(() => loadStored(chatStorageKey, []))
  const [input, setInput] = useState('')
  const [image, setImage] = useState('')
  const [readingImage, setReadingImage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [savingId, setSavingId] = useState('')
  const [modelConfig, setModelConfig] = useState({ loading: true, configured: false })
  const [error, setError] = useState('')
  const bottomRef = useRef(null)
  const imageInputRef = useRef(null)

  useEffect(() => {
    localStorage.removeItem('corec_llm_profiles')
    localStorage.removeItem('corec_llm_active_profile')
  }, [])
  useEffect(() => {
    try { localStorage.setItem(chatStorageKey, JSON.stringify(messages.map(({ image: storedImage, ...message }) => ({ ...message, ...(storedImage ? { hadImage: true } : {}) })))) } catch { /* Storage may be unavailable or full. */ }
  }, [chatStorageKey, messages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages, loading])

  useEffect(() => {
    let current = true
    setModelConfig({ loading: true, configured: false })
    fetch(`/api/groups/${groupId}/llm/config`).then(async (response) => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法读取后端模型配置。')
      if (current) setModelConfig({ loading: false, ...data })
    }).catch((configError) => {
      if (current) setModelConfig({ loading: false, configured: false, error: configError.message })
    })
    return () => { current = false }
  }, [groupId])

  function selectImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      setError('请选择不超过 4 MB 的 JPEG、PNG、WebP 或 GIF 图片。')
      return
    }
    setReadingImage(true)
    setError('')
    const reader = new FileReader()
    reader.onload = () => { setImage(reader.result); setReadingImage(false) }
    reader.onerror = () => { setError('读取图片失败，请重试。'); setReadingImage(false) }
    reader.readAsDataURL(file)
  }

  async function sendMessage(event) {
    event.preventDefault()
    const content = input.trim()
    if ((!content && !image) || loading || readingImage) return
    if (!modelConfig.configured) {
      setError(modelConfig.error || '后端还没有配置模型，请检查 .env 中的 LLM 配置。')
      return
    }
    const userMessage = { id: createId(), role: 'user', content, ...(image ? { image } : {}) }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInput('')
    setImage('')
    setError('')
    setLoading(true)
    try {
      const result = await parseExpense(nextMessages, members, user, groupId)
      const lastImageIndex = nextMessages.findLastIndex((message) => message.role === 'user' && message.image)
      const lastSavedIndex = nextMessages.findLastIndex((message) => message.expense?.saved || message.expense?.dismissed)
      if (result.expense && lastImageIndex > lastSavedIndex) {
        try {
          const data = await saveExpense(groupId, result.expense)
          if (data.duplicates) {
            setMessages((current) => [...current, { id: createId(), role: 'assistant', content: '发现可能重复的账单，请确认是否继续入账。', expense: { ...result.expense, saved: false, duplicates: data.duplicates } }])
            return
          }
        } catch (saveError) {
          setMessages((current) => [...current, { id: createId(), role: 'assistant', content: result.reply, expense: { ...result.expense, saved: false } }])
          setError(saveError.message || '保存账单失败，请确认后重试。')
          return
        }
        const typeLabel = result.expense.type === 'income' ? '收入' : '支出'
        setMessages((current) => [...current, {
          id: createId(), role: 'assistant', content: `已把这笔${typeLabel}记入 ${groupName}。`, expense: { ...result.expense, saved: true },
        }])
        try { await onExpenseSaved() } catch { setError('账单已保存，但刷新账本失败。') }
        return
      }
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
      const expense = { ...message.expense, category: message.expense.type !== 'income' && message.expense.category === '居家' ? '居住' : message.expense.category, payerId: message.expense.payerId }
      const result = await saveExpense(groupId, expense, (message.expense.duplicates || []).map((item) => item.id))
      if (result.duplicates) {
        setMessages((current) => current.map((item) => item.id === message.id ? { ...item, expense: { ...item.expense, duplicates: result.duplicates } } : item))
        return
      }
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
    <header className="chat-header"><div><p className="eyebrow">COREC CHAT</p><h1>Chat</h1><p>{groupName} · 账单助手</p></div><div className="chat-controls"><button className="icon-button" onClick={clearConversation} title="清空对话" aria-label="清空对话"><Trash2 size={17} /></button></div></header>
    <div className="chat-thread">
      {!messages.length && <div className="chat-welcome"><div className="chat-welcome-icon"><Bot size={23} /></div><h2>今天这笔怎么记？</h2><p>描述金额、类型和成员，我会整理成账单草稿供你确认。</p><div className="chat-suggestions"><button onClick={() => setInput('刚才我和阿禾吃饭花了 168 元，记到餐饮里')}>晚餐 168 元，记到餐饮</button><button onClick={() => setInput('昨天我付了 36 元打车费，帮我记一笔')}>昨天打车 36 元</button><button onClick={() => setInput('我今天收到工资 8000 元，记一笔收入')}>收到工资 8000 元</button></div></div>}
      {messages.map((message) => {
        const isIncome = message.expense?.type === 'income'
        return <article className={`chat-message ${message.role}`} key={message.id}>
          <div className="message-avatar">{message.role === 'assistant' ? <Bot size={17} /> : user.displayName.slice(0, 1)}</div>
          <div className="message-content">
            <div className="message-author">{message.role === 'assistant' ? 'CoRec' : user.displayName}</div>
            {message.image && <img className="chat-message-image" src={message.image} alt="上传的图片" />}
            {!message.image && message.hadImage && <p className="image-unavailable">图片未保存在本地</p>}
            {message.content && <p className="message-text">{message.content}</p>}
            {message.expense && <div className={message.expense.saved ? 'expense-draft saved' : 'expense-draft'}>
              <div className="draft-heading"><strong>{message.expense.saved ? `已记入${isIncome ? '收入' : '支出'}` : message.expense.dismissed ? '已取消入账' : message.expense.duplicates ? '可能重复' : `待确认${isIncome ? '收入' : '支出'}`}</strong><span>{message.expense.category}</span></div>
              <div className="draft-main"><strong>{message.expense.productName || message.expense.merchant || message.expense.category}</strong><b className={isIncome ? 'income-amount' : ''}>{isIncome ? '+' : '−'} ¥{Number(message.expense.amount).toFixed(2)}</b></div>
              {message.expense.merchant && message.expense.merchant !== message.expense.category && <div className="draft-meta"><span>商家：{message.expense.merchant}</span></div>}
              <div className="draft-meta"><span>{message.expense.date}{message.expense.time ? ` ${message.expense.time}` : ''}</span><span>{message.expense.note || '无备注'}</span></div>
              {!message.expense.saved && !message.expense.dismissed && message.expense.duplicates && <div className="duplicate-list"><strong>已有相似账单</strong>{message.expense.duplicates.map((item) => <div key={item.id}>{describeDuplicate(item)}</div>)}</div>}
              {!message.expense.saved && !message.expense.dismissed && <div className="draft-actions"><label><span>{isIncome ? '收入归属' : '付款人'}</span><select value={message.expense.payerId} onChange={(event) => updateDraftPayer(message.id, event.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>{message.expense.duplicates && <button type="button" className="duplicate-cancel" onClick={() => setMessages((current) => current.map((item) => item.id === message.id ? { ...item, expense: { ...item.expense, dismissed: true } } : item))} disabled={savingId === message.id}>取消</button>}<button className="primary-button" onClick={() => confirmExpense(message)} disabled={savingId === message.id}><Check size={16} />{savingId === message.id ? '保存中…' : message.expense.duplicates ? '仍然入账' : `确认${isIncome ? '收入' : '记账'}`}</button></div>}
            </div>}
          </div>
        </article>
      })}
      {loading && <div className="chat-typing"><span /><span /><span />正在整理账单…</div>}
      <div ref={bottomRef} />
    </div>
    <div className="chat-compose-area">{error && <div className="error-banner" role="alert">{error}</div>}{!modelConfig.loading && !modelConfig.configured && <div className="chat-key-notice">{modelConfig.error || '后端尚未配置模型，请在 .env 中填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 和 LLM_API_FORMAT。'}</div>}
      <form className="chat-compose" onSubmit={sendMessage}>
        <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={selectImage} hidden />
        {image && <div className="chat-image-preview"><img src={image} alt="待发送图片" /><button type="button" onClick={() => setImage('')} aria-label="移除图片" title="移除图片"><X size={15} /></button></div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }} placeholder="描述你要记录的账单…" rows={2} disabled={!modelConfig.configured || modelConfig.loading || loading} />
        <div className="chat-compose-actions"><button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={!modelConfig.configured || modelConfig.loading || loading || readingImage} aria-label="添加图片" title="添加图片"><ImagePlus size={19} /></button><button className="send-button" type="submit" aria-label="发送" title="发送" disabled={(!input.trim() && !image) || readingImage || loading || !modelConfig.configured || modelConfig.loading}><Send size={18} /></button></div>
      </form><p className="chat-disclaimer">图片账单信息完整时自动入账，发现可能重复时需要确认。</p></div>

  </section>
}
