import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, Filter } from 'lucide-react'

export default function LedgerColumnFilter({ label, options, selected, onChange, align = 'left' }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState([])
  const [search, setSearch] = useState('')
  const root = useRef(null)
  const trigger = useRef(null)
  const id = useId()
  const filtered = selected !== null
  const visibleOptions = options.filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))

  useEffect(() => {
    if (!open) return
    function outside(event) {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    function keydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', keydown)
    }
  }, [open])

  function toggle() {
    if (!open) {
      setDraft(selected ?? options.map((option) => option.value))
      setSearch('')
    }
    setOpen((value) => !value)
  }

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  function apply() {
    onChange(options.every((option) => draft.includes(option.value)) ? null : draft)
    close()
  }

  return <div ref={root} className={`ledger-column-filter align-${align}`}>
    <button ref={trigger} type="button" className={`column-filter-trigger${filtered ? ' is-filtered' : ''}`} onClick={toggle}
      aria-label={`${label}筛选${filtered ? `，已选 ${selected.length} 项` : '，全部'}`} aria-expanded={open} aria-controls={open ? id : undefined}>
      <span>{label}</span>{filtered ? <Filter size={12} /> : <ChevronDown size={12} />}
    </button>
    {open && <div id={id} className="column-filter-popup" role="group" aria-label={`${label}多选筛选`}>
      <div className="column-filter-heading"><strong>筛选{label}</strong><span>可多选</span></div>
      <input className="column-filter-search" aria-label={`搜索${label}选项`} placeholder={`搜索${label}`} value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
      <div className="column-filter-tools"><button type="button" onClick={() => setDraft(options.map((option) => option.value))}>全选</button><button type="button" onClick={() => setDraft([])}>清空</button></div>
      <div className="column-filter-options">
        {visibleOptions.map((option) => <label key={option.value}>
          <input type="checkbox" checked={draft.includes(option.value)} onChange={(event) => setDraft((values) => event.target.checked ? [...values, option.value] : values.filter((value) => value !== option.value))} />
          <span>{option.label}</span>
        </label>)}
        {!visibleOptions.length && <p>没有匹配的选项</p>}
      </div>
      <div className="column-filter-footer"><button type="button" onClick={close}>取消</button><button type="button" className="column-filter-apply" onClick={apply}>确定</button></div>
    </div>}
  </div>
}
