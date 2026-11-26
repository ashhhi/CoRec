import React from 'react'

export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, disabled = false, label = '记录' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <nav className="pagination" aria-label={`${label}分页`}>
    <label>每页<select aria-label={`${label}每页条数`} value={pageSize} disabled={disabled} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{[5,10,20,50].map((size) => <option key={size} value={size}>{size} 条</option>)}</select></label>
    <span>共 {total} 条</span>
    <div className="pagination-pages"><button type="button" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
      <label>第<select aria-label={`${label}页码`} value={page} disabled={disabled} onChange={(event) => onPageChange(Number(event.target.value))}>{Array.from({length:pages},(_,index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select>/ {pages} 页</label>
      <button type="button" disabled={disabled || page >= pages} onClick={() => onPageChange(page + 1)}>下一页</button></div>
  </nav>
}
