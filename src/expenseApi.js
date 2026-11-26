import { entryLabel } from '../server/ledger-protocol.js'
export async function saveExpense(groupId, expense, confirmedDuplicateIds = []) {
  const { duplicates, saved, dismissed, ...fields } = expense
  const response = await fetch(`/api/groups/${groupId}/expenses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...fields, confirmedDuplicateIds }),
  })
  const data = await response.json()
  if (response.status === 409 && data.code === 'POSSIBLE_DUPLICATE') return { duplicates: data.duplicates }
  if (!response.ok) throw new Error(data.error || '保存账单失败。')
  return data
}

export function describeDuplicate(item) {
  const name = item.productName || (item.merchant !== item.category ? item.merchant : '') || item.category
  return [item.date, item.time, item.type === 'transfer' ? entryLabel(item) : item.category, name !== item.category ? name : '', `¥${Number(item.amount).toFixed(2)}`, item.payer].filter(Boolean).join(' · ')
}
