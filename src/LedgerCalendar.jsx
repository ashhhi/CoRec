import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { CalendarDays, X } from 'lucide-react'
import { entryLabel, entrySign } from '../server/ledger-protocol.js'

const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const money = (cents) => (Math.abs(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function DayRecordsDialog({ date, transactions, onClose }) {
  const headingId = useId()
  const dialog = useRef(null)
  const close = useRef(null)
  const dateLabel = new Date(`${date}T12:00:00Z`).toLocaleDateString('zh-CN', { timeZone:'Asia/Hong_Kong', year:'numeric',month:'long',day:'numeric',weekday:'long' })
  const records = transactions.filter((item)=>item.date === date).sort((a,b)=>(b.time || '').localeCompare(a.time || '') || b.id-a.id)
  const income = records.reduce((sum,item)=>sum+(item.type === 'income' ? Math.round(Number(item.amount)*100) : 0),0)
  const expense = records.reduce((sum,item)=>sum+(item.type === 'expense' ? Math.round(Number(item.amount)*100) : 0),0)
  const net = income-expense

  useEffect(()=>{
    const previous = document.activeElement
    close.current?.focus()
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const items = [...dialog.current.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
        const first=items[0],last=items.at(-1)
        if (event.shiftKey && document.activeElement===first) { event.preventDefault();last?.focus() }
        else if (!event.shiftKey && document.activeElement===last) { event.preventDefault();first?.focus() }
      }
    }
    document.addEventListener('keydown',keydown)
    return ()=>{document.removeEventListener('keydown',keydown);previous?.focus()}
  },[onClose])

  return <div className="modal-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose()}}>
    <section ref={dialog} className="expense-modal calendar-day-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <div className="modal-head"><div><p className="eyebrow">DAILY LEDGER</p><h2 id={headingId}>{dateLabel}</h2><p className="calendar-day-count">当天全部记录 · {records.length} 笔</p></div><button ref={close} type="button" className="close-button" aria-label="关闭当天记录" onClick={onClose}><X size={19} /></button></div>
      <div className="calendar-day-summary"><span>支出<strong className="calendar-expense">− ¥{money(expense)}</strong></span><span>收入<strong className="calendar-income">+ ¥{money(income)}</strong></span><span>合计<strong className={net<0 ? 'calendar-expense' : net>0 ? 'calendar-income' : ''}>{net<0 ? '− ' : net>0 ? '+ ' : ''}¥{money(net)}</strong></span></div>
      {records.length ? <div className="calendar-day-records" tabIndex={0} role="region" aria-label="当天账单记录">
        {records.map((item)=><article className="calendar-record" key={item.id}>
          <div className="calendar-record-heading"><span>{item.time || '未记录时间'} · {entryLabel(item)} · {item.category}</span><strong className={item.type==='transfer' ? 'calendar-transfer' : item.type==='income' ? 'calendar-income' : 'calendar-expense'}>{entrySign(item)} ¥{money(Math.round(Number(item.amount)*100))}</strong></div>
          <h3>{item.type==='transfer' ? entryLabel(item) : item.productName || item.merchant || item.category}</h3>
          <dl><div><dt>商品</dt><dd>{item.productName || '未填写'}</dd></div><div><dt>商家</dt><dd>{item.merchant && item.merchant!==item.category ? item.merchant : '未填写'}</dd></div><div><dt>{item.type==='transfer' ? '经办成员' : item.type==='income' ? '收入归属' : '付款成员'}</dt><dd>{item.payer || '未记录'}</dd></div><div><dt>备注</dt><dd>{item.note || '无'}</dd></div></dl>
        </article>)}
      </div> : <div className="empty-state">这一天没有账单记录</div>}
    </section>
  </div>
}

export default function LedgerCalendar({ month, transactions, today, loading }) {
  const headingId = useId()
  const [selectedDay,setSelectedDay]=useState(null)
  const closeDay=useCallback(()=>setSelectedDay(null),[])
  const [year, monthNumber] = month.split('-').map(Number)
  const first = new Date(Date.UTC(year, monthNumber - 1, 1))
  const offset = (first.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const weekCount = Math.ceil((offset + daysInMonth) / 7)
  const daily = new Map()
  for (const item of transactions) {
    if (!item.date?.startsWith(`${month}-`)) continue
    const totals = daily.get(item.date) || { income: 0, expense: 0, transfers: 0 }
    if (item.type === 'transfer') totals.transfers++
    else totals[item.type === 'income' ? 'income' : 'expense'] += Math.round(Number(item.amount) * 100)
    daily.set(item.date, totals)
  }

  return <section className="ledger-calendar panel" aria-labelledby={headingId} aria-busy={loading}>
    <div className="calendar-heading">
      <div><h2 id={headingId}><CalendarDays size={18} />收支日历</h2><p>{year}年{monthNumber}月 · 按本月全部账单汇总，合计 = 收入 − 支出，存款转账不计入收支</p></div>
      {loading && <span role="status">正在更新…</span>}
    </div>
    <p className="calendar-scroll-hint">左右滑动查看完整月历</p>
    <div className="calendar-scroll" tabIndex={0} role="region" aria-label={`${year}年${monthNumber}月每日收支`}>
      <table className="calendar-table">
        <thead><tr>{weekdays.map((day, index) => <th key={day} scope="col" className={index > 4 ? 'calendar-weekend' : undefined}>{day}</th>)}</tr></thead>
        <tbody>{Array.from({ length: weekCount }, (_, week) => <tr key={week}>
          {Array.from({ length: 7 }, (_, weekday) => {
            const date = new Date(Date.UTC(year, monthNumber - 1, week * 7 + weekday - offset + 1))
            const key = date.toISOString().slice(0, 10)
            const inMonth = date.getUTCMonth() === monthNumber - 1
            const isToday = key === today
            const { income, expense, transfers } = daily.get(key) || { income: 0, expense: 0, transfers: 0 }
            const net = income - expense
            return <td key={key} className={`${inMonth ? 'calendar-day' : 'calendar-outside'}${isToday && inMonth ? ' calendar-today' : ''}${weekday > 4 ? ' calendar-weekend-day' : ''}`}>
              {inMonth && <button type="button" className="calendar-day-open" disabled={loading} aria-label={`查看${monthNumber}月${date.getUTCDate()}日全部账单`} aria-haspopup="dialog" onClick={()=>setSelectedDay(key)} />}
              <time dateTime={key} className="calendar-date" aria-current={isToday ? 'date' : undefined}>{date.getUTCDate()}{!inMonth && date.getUTCDate() === 1 ? '日' : ''}</time>
              {inMonth && <dl className={`calendar-totals${!income && !expense && !transfers ? ' calendar-no-entries' : ''}`}>
                <div className="calendar-expense"><dt>支出</dt><dd>{loading ? '—' : `− ¥${money(expense)}`}</dd></div>
                <div className="calendar-income"><dt>收入</dt><dd>{loading ? '—' : `+ ¥${money(income)}`}</dd></div>
                <div className={`calendar-net${net < 0 ? ' is-negative' : net > 0 ? ' is-positive' : ''}`}><dt>合计</dt><dd>{loading ? '—' : `${net < 0 ? '− ' : net > 0 ? '+ ' : ''}¥${money(net)}`}</dd></div>
                {transfers > 0 && <div className="calendar-transfer"><dt>存款转账</dt><dd>{transfers}笔</dd></div>}
              </dl>}
            </td>
          })}
        </tr>)}</tbody>
      </table>
    </div>
    {selectedDay && <DayRecordsDialog date={selectedDay} transactions={transactions} onClose={closeDay} />}
  </section>
}
