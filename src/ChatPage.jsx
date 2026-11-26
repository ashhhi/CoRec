import React, { useEffect, useRef, useState } from 'react'
import { Bot, Check, ImagePlus, LockKeyhole, Send, Trash2, X } from 'lucide-react'
import { describeDuplicate, saveExpenses } from './expenseApi.js'
import { entryLabel, entrySign, savingsInstructions, transferDirections, validateIncomeSavings, incomeAllocationLabel, expenseValues, batchInstructions, ledgerTimeNow, resolveEntryTime, resolveEntryDate, ledgerTimeInstructions } from '../server/ledger-protocol.js'
import { taskInstructions } from '../server/task-protocol.js'
import { taskApi, formatTaskTime, taskKindLabels, recurrenceLabel } from './tasksApi.js'

const categories = ['餐饮', '交通', '娱乐', '购物', '居住', '其他']
const incomeCategories = ['工资', '奖金', '退款', '其他收入']

function draftExpenses(message) {
  return message.expenses || (message.expense ? [message.expense] : [])
}

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

function validateExpense(value, members, user, defaultNow = ledgerTimeNow()) {
  if (!value || typeof value !== 'object') return null
  if (!['expense', 'income', 'transfer'].includes(value.type)) throw new Error('请问这笔账单是收入、支出还是存款转账？')
  const type = value.type
  const amount = Number(value.amount)
  const date = resolveEntryDate(value.date, defaultNow.slice(0, 10))
  const time = resolveEntryTime(value.time, defaultNow.slice(11))
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) throw new Error('请补充有效的账单金额。')
  const validCategories = type === 'transfer' ? ['存款'] : type === 'income' ? incomeCategories : categories
  if (type === 'transfer' && !Object.hasOwn(transferDirections,value.transferDirection)) throw new Error('请说明是活动账户转入存款，还是存款转回活动账户。')
  if (!validCategories.includes(value.category)) throw new Error('请补充这笔账单的分类。')
  const requestedPayer = members.find((member) => member.displayName === value.payerName)
  const payer = requestedPayer || members.find((member) => member.id === user.id) || members[0]
  return {
    type,
    transferDirection: type === 'transfer' ? value.transferDirection : null,
    savingsAmount: validateIncomeSavings(type, amount, value.savingsAmount),
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
  const now = ledgerTimeNow()
  const todayIso = now.slice(0, 10)
  const expensePrompt = `你是 CoRec 的共同账本助手。今天是 ${todayIso}，当前香港时间 ${now}（UTC+8）。当前群组成员：${members.map((member) => `${member.displayName} (id=${member.id})`).join('、')}。支出分类：${categories.join('、')}。收入分类：${incomeCategories.join('、')}。只返回一个 JSON 对象，不要 Markdown。格式：{"reply":"给用户的简短中文回复","expenses":[]}。用户上传图片时，默认用户希望提取图片中的账单并记账，除非用户明确提出其他用途。结合图片、文字和后续回答提取信息；若图片难以辨认，或收支类型、实际金额、分类无法确定，直接向用户询问缺失信息，expenses 必须为空数组，不要猜测金额，未提日期默认今天。信息齐全后返回 expenses 数组，每笔对象，字段为 {"type":"expense、income 或 transfer","savingsAmount":数字,"date":"YYYY-MM-DD或null","time":"HH:mm 或 null","amount":数字,"category":"分类","merchant":"商家名称，可省略","productName":"商品名，可省略","note":"备注","payerName":"群组成员显示名字"}。商家名称和商品名分别填写；merchant 只能填写明确出现的实际商家名称，不能填消费描述，例如“和阿禾吃饭”或“打车”，此类描述可放在 note。不要将商家名称填入商品名；商品名不明确时留空。支出使用支出分类，收入使用收入分类；未提供商家名称时 merchant 可以省略。相对日期按今天换算。付款人或收入归属必须从群组成员中选择；未提成员时使用 ${user.displayName}。文本记账也要在信息不足时追问。不要声称账单已保存，系统会负责保存。`
  const systemPrompt = `${expensePrompt}\n${ledgerTimeInstructions()}\n${savingsInstructions()}\n${batchInstructions()}\n${taskInstructions(now)}`
  const recent = messages.slice(-14)
  const lastImageId = [...recent].reverse().find((message) => message.image)?.id
  const inputMessages = [{ role: 'system', content: systemPrompt }, ...recent.map(({ id, role, content, image }) => ({ role, content: content || (image ? '请提取这张图片中的账单并记账；信息不足时询问缺失信息。' : ''), ...(id === lastImageId ? { image } : {}) }))]
  let remaining = 4600 - systemPrompt.length
  for (let index = inputMessages.length - 1; index > 0; index--) {
    inputMessages[index].content = inputMessages[index].content.slice(0, Math.max(0, Math.min(remaining, index === inputMessages.length - 1 ? 2400 : 120)))
    remaining -= inputMessages[index].content.length
  }
  async function requestModel(input) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 60000)
    let response
    try {
      response = await fetch(`/api/groups/${groupId}/llm/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CoRec-Source': 'chat' },
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
  if (isImageOnly && result.intent !== 'task' && !result.task && !result.taskAction && !result.expense && !result.expenses?.length && !asksForInformation(result.reply)) {
    const retryMessages = inputMessages.map((message, index) => index === 0 ? {
      ...message,
      content: `${message.content} 用户刚刚仅发送图片，即要求记账。不要只描述图片：如果图片中能确定收支类型、金额及分类，必须在 expenses 数组中填写每笔账目；否则 reply 必须明确询问无法确定的字段，expenses 为空数组。`,
    } : message)
    result = await requestModel(retryMessages)
    if (!result.expense && !result.expenses?.length && !asksForInformation(result.reply)) {
      result.reply = `${typeof result.reply === 'string' ? `${result.reply}\n` : ''}请补充这笔账单的收支类型、金额和分类，以便记账。`
    }
  }
  if (result.intent === 'task' || result.task || result.taskAction) return { intent: 'task', reply: result.reply || '请补充任务内容和时间。', task: result.task, taskAction: result.taskAction }
  try {
    const expenses = expenseValues(result).map((value) => validateExpense(value, members, user, now))
    return { reply: typeof result.reply === 'string' ? result.reply : '我理解了。', expenses, expense: expenses.length === 1 ? expenses[0] : null }
  } catch (validationError) {
    return { reply: validationError.message, expense: null, expenses: [] }
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
      if (result.intent === 'task') {
        if (result.taskAction) {
          const { task } = await taskApi(groupId, '/action', { method: 'POST', headers: { 'X-CoRec-Source': 'chat' }, body: result.taskAction })
          setMessages((current) => [...current, { id: createId(), role: 'assistant', content: `任务 #${task.id} 已${task.status === 'completed' ? '完成' : '取消'}。` }])
        } else setMessages((current) => [...current, { id: createId(), role: 'assistant', content: result.task ? '已整理好任务，请确认时间和内容后创建。' : result.reply, task: result.task || null }])
        return
      }
      const lastImageIndex = nextMessages.findLastIndex((message) => message.role === 'user' && message.image)
      const lastSavedIndex = nextMessages.findLastIndex((message) => ['saved', 'dismissed'].includes(message.expenseStatus) || message.expense?.saved || message.expense?.dismissed)
      const draft = { id: createId(), role: 'assistant', content: result.reply, expenses: result.expenses || [], expenseStatus: 'draft' }
      if (draft.expenses.length && lastImageIndex > lastSavedIndex) {
        let data
        try {
          data = await saveExpenses(groupId, draft.expenses)
          if (data.duplicates) {
            setMessages((current) => [...current, { ...draft, content: '发现可能重复的账单，这批尚未保存，请确认是否全部入账。', duplicates: data.duplicates }])
            return
          }
        } catch (saveError) {
          setMessages((current) => [...current, draft])
          setError(saveError.message || '保存账单失败，请确认后重试。')
          return
        }
        setMessages((current) => [...current, { ...draft, content: `已将 ${data.expenses.length} 笔账单记入 ${groupName}。`, expenses: data.expenses, expenseStatus: 'saved' }])
        try { await onExpenseSaved() } catch { setError('账单已保存，但刷新账本失败。') }
        return
      }
      setMessages((current) => [...current, draft])
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

  function updateDraftPayer(messageId, index, payerId) {
    const payer = members.find((member) => member.id === Number(payerId))
    setMessages((current) => current.map((message) => message.id === messageId
      ? { ...message, expenses: draftExpenses(message).map((expense, itemIndex) => itemIndex === index ? { ...expense, payerId: payer?.id, payerName: payer?.displayName || '' } : expense) }
      : message))
  }

  async function confirmTask(message) {
    setSavingId(message.id)
    setError('')
    try {
      const { task } = await taskApi(groupId, '', { method: 'POST', headers: { 'X-CoRec-Source': 'chat' }, body: { ...message.task, requestId: message.id } })
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, content: `已创建任务 #${task.id}，提醒及执行结果可在任务页面查看。`, task: { ...task, saved: true } } : item))
    } catch (error) { setError(error.message) } finally { setSavingId('') }
  }

  async function confirmExpenses(message) {
    if (savingId) return
    setSavingId(message.id)
    setError('')
    try {
      const expenses = draftExpenses(message).map((expense) => ({ ...expense, category: expense.type !== 'income' && expense.category === '居家' ? '居住' : expense.category }))
      const duplicates = message.duplicates || message.expense?.duplicates || []
      const result = await saveExpenses(groupId, expenses, duplicates.map((item) => item.id))
      if (result.duplicates) {
        setMessages((current) => current.map((item) => item.id === message.id ? { ...item, duplicates: result.duplicates } : item))
        return
      }
      setMessages((current) => [...current.map((item) => item.id === message.id ? { ...item, expenses: result.expenses, expense: undefined, expenseStatus: 'saved' } : item), {
        id: createId(), role: 'assistant', content: `已将 ${result.expenses.length} 笔账单记入 ${groupName}。`,
      }])
      try { await onExpenseSaved() } catch { setError('账单已保存，但刷新账本失败。') }
    } catch (saveError) {
      setError(saveError.message || '保存账单失败。')
    } finally {
      setSavingId('')
    }
  }

  async function recordChatAction(action) {
    const response = await fetch(`/api/groups/${groupId}/activity/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoRec-Source': 'chat' }, body: JSON.stringify({ action }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '操作记录保存失败。')
  }

  async function clearConversation() {
    if (!messages.length || loading || savingId || !window.confirm('清空这段群组对话？')) return
    try { await recordChatAction('clear-chat'); setMessages([]) }
    catch (error) { setError(error.message) }
  }

  async function dismissDraft(message, kind) {
    try {
      await recordChatAction(kind === 'task' ? 'cancel-task-draft' : 'cancel-ledger-draft')
      setMessages((current) => current.map((item) => item.id === message.id ? kind === 'task' ? { ...item, task: { ...item.task, dismissed: true } } : { ...item, expenseStatus: 'dismissed' } : item))
    } catch (error) { setError(error.message) }
  }

  return <section className="chat-page">
    <header className="chat-header"><div><p className="eyebrow">COREC CHAT</p><h1>Chat</h1><p>{groupName} · 账单与任务助手</p></div><div className="chat-controls"><button className="icon-button" onClick={clearConversation} title="清空对话" aria-label="清空对话"><Trash2 size={17} /></button></div></header>
    <div className="chat-thread">
      {!messages.length && <div className="chat-welcome"><div className="chat-welcome-icon"><Bot size={23} /></div><h2>记账、任务，都可以告诉我</h2><p>发送账单，或告诉我什么时候提醒你、定时生成什么内容。</p><div className="chat-suggestions"><button onClick={() => setInput('明天下午3点提醒我交水电费，在群里提醒')}>明天下午3点提醒交水电费</button><button onClick={() => setInput('今晚8点自动汇总本月账本收支，在群里告诉我结果')}>今晚8点汇总本月收支</button><button onClick={() => setInput('刚才我和阿禾吃饭花了 168 元，记到餐饮里')}>晚餐 168 元，记到餐饮</button><button onClick={() => setInput('昨天我付了 36 元打车费，帮我记一笔')}>昨天打车 36 元</button><button onClick={() => setInput('我今天收到工资 8000 元，记一笔收入')}>收到工资 8000 元</button></div></div>}
      {messages.map((message) => {
        return <article className={`chat-message ${message.role}`} key={message.id}>
          <div className="message-avatar">{message.role === 'assistant' ? <Bot size={17} /> : user.displayName.slice(0, 1)}</div>
          <div className="message-content">
            <div className="message-author">{message.role === 'assistant' ? 'CoRec' : user.displayName}</div>
            {message.image && <img className="chat-message-image" src={message.image} alt="上传的图片" />}
            {!message.image && message.hadImage && <p className="image-unavailable">图片未保存在本地</p>}
            {message.content && <p className="message-text">{message.content}</p>}
            {message.task && <div className={message.task.saved ? 'expense-draft saved' : 'expense-draft'}>
              <div className="draft-heading"><strong>{message.task.saved ? '已创建任务' : '任务草稿'}</strong><span>{taskKindLabels[message.task.kind] || '提醒事项'}</span></div>
              <p>{message.task.title}</p>
              {message.task.recurrence && <p>{recurrenceLabel(message.task.recurrence)}</p>}
              <p>{formatTaskTime(message.task.dueAt)} · {message.task.target === 'private' ? 'QQ 私聊' : 'QQ 群'}</p>
              {message.task.details && <p>{message.task.details}</p>}
              {!message.task.saved && !message.task.dismissed && <div className="draft-actions"><button type="button" className="confirm-draft" disabled={savingId === message.id} onClick={() => confirmTask(message)}><Check size={14} />{savingId === message.id ? '正在创建…' : '确认创建任务'}</button><button type="button" onClick={() => dismissDraft(message, 'task')}>取消</button></div>}
              {message.task.dismissed && <p>已取消草稿</p>}
            </div>}
            {draftExpenses(message).length > 0 && <ExpenseDrafts message={message} members={members} saving={Boolean(savingId)}
              onPayerChange={(index, payerId) => updateDraftPayer(message.id, index, payerId)}
              onConfirm={() => confirmExpenses(message)}
              onDismiss={() => dismissDraft(message, 'ledger')} />}
          </div>
        </article>
      })}
      {loading && <div className="chat-typing"><span /><span /><span />正在理解你的安排…</div>}
      <div ref={bottomRef} />
    </div>
    <div className="chat-compose-area">{error && <div className="error-banner" role="alert">{error}</div>}{!modelConfig.loading && !modelConfig.configured && <div className="chat-key-notice">{modelConfig.error || '后端尚未配置模型，请在 .env 中填写 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 和 LLM_API_FORMAT。'}</div>}
      <form className="chat-compose" onSubmit={sendMessage}>
        <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={selectImage} hidden />
        {image && <div className="chat-image-preview"><img src={image} alt="待发送图片" /><button type="button" onClick={() => setImage('')} aria-label="移除图片" title="移除图片"><X size={15} /></button></div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit() } }} placeholder="描述账单，或告诉我什么时候做什么…" rows={2} disabled={!modelConfig.configured || modelConfig.loading || loading} />
        <div className="chat-compose-actions"><button className="attach-button" type="button" onClick={() => imageInputRef.current?.click()} disabled={!modelConfig.configured || modelConfig.loading || loading || readingImage} aria-label="添加图片" title="添加图片"><ImagePlus size={19} /></button><button className="send-button" type="submit" aria-label="发送" title="发送" disabled={(!input.trim() && !image) || readingImage || loading || !modelConfig.configured || modelConfig.loading}><Send size={18} /></button></div>
      </form><p className="chat-disclaimer">图片账单信息完整时自动入账，发现可能重复时需要确认。</p></div>

  </section>
}


function ExpenseDrafts({ message, members, saving, onPayerChange, onConfirm, onDismiss }) {
  const expenses = draftExpenses(message)
  const saved = message.expenseStatus === 'saved' || message.expense?.saved
  const dismissed = message.expenseStatus === 'dismissed' || message.expense?.dismissed
  const duplicates = message.duplicates || message.expense?.duplicates || []
  const editable = !saved && !dismissed
  return <div className={saved ? 'expense-draft saved' : 'expense-draft'}>
    <div className="draft-heading"><strong>{saved ? '已记入账本' : dismissed ? '已取消入账' : duplicates.length ? '可能重复 · 整批尚未保存' : '待确认账单'}</strong><span>共 {expenses.length} 笔</span></div>
    {expenses.map((expense, index) => {
      const isIncome = expense.type === 'income'
      const isTransfer = expense.type === 'transfer'
      return <div className="batch-expense-item" key={index}>
        <div className="draft-heading"><strong>{index + 1}. {entryLabel(expense)}</strong><span className={isTransfer ? 'savings-draft-category' : undefined}>{isTransfer && <LockKeyhole size={12} />}{expense.category}</span></div>
        <div className="draft-main"><strong>{isTransfer ? entryLabel(expense) : expense.productName || expense.merchant || expense.category}</strong><b className={isTransfer ? 'savings-amount' : isIncome ? 'income-amount' : ''}>{entrySign(expense)} ¥{Number(expense.amount).toFixed(2)}</b></div>
        {isIncome && <p className="income-allocation">{Number(expense.savingsAmount) > 0 && <LockKeyhole size={12} />}{incomeAllocationLabel(expense)}</p>}
        {expense.merchant && expense.merchant !== expense.category && <div className="draft-meta"><span>商家：{expense.merchant}</span></div>}
        <div className="draft-meta"><span>{expense.date}{expense.time ? ` ${expense.time}` : ''}</span><span>{expense.note || '无备注'}</span></div>
        {editable ? <div className="draft-actions"><label><span>{isTransfer ? '经办成员' : isIncome ? '收入归属' : '付款人'}</span><select value={expense.payerId} disabled={saving} onChange={(event) => onPayerChange(index, event.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label></div> : <div className="draft-meta"><span>{expense.payer || expense.payerName || members.find((member) => member.id === expense.payerId)?.displayName}</span></div>}
      </div>
    })}
    {editable && duplicates.length > 0 && <div className="duplicate-list"><strong>已有相似账单</strong>{duplicates.map((item) => <div key={item.id}>{describeDuplicate(item)}</div>)}</div>}
    {editable && <div className="draft-actions"><button type="button" className="duplicate-cancel" disabled={saving} onClick={onDismiss}>取消</button><button type="button" className="primary-button" disabled={saving || !members.length} onClick={onConfirm}><Check size={16} />{saving ? '保存中…' : duplicates.length ? '仍然全部入账' : `确认入账${expenses.length > 1 ? `（${expenses.length} 笔）` : ''}`}</button></div>}
  </div>
}
