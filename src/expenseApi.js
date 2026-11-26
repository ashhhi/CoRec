import { entryLabel, incomeAllocationLabel } from '../server/ledger-protocol.js'
export async function saveExpense(groupId, expense, confirmedDuplicateIds = []) {
  return submitExpenses(groupId, expense, confirmedDuplicateIds)
}

export async function saveExpenses(groupId, expenses, confirmedDuplicateIds = []) {
  return submitExpenses(groupId, { expenses }, confirmedDuplicateIds)
}

export async function updateExpense(groupId, id, expense, confirmedDuplicateIds = []) {
  return submitExpenses(groupId, expense, confirmedDuplicateIds, id)
}

async function submitExpenses(groupId, fields, confirmedDuplicateIds, id) {
  const response = await fetch(`/api/groups/${groupId}/expenses${id ? `/${id}` : ''}`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(!id && Array.isArray(fields.expenses) ? { 'X-CoRec-Source': 'chat' } : {}) },
    body: JSON.stringify({ ...fields, confirmedDuplicateIds }),
  })
  const data = await response.json()
  if (response.status === 409 && data.code === 'POSSIBLE_DUPLICATE') return { duplicates: data.duplicates }
  if (!response.ok) throw new Error(data.error || '保存账单失败。')
  return data
}

export function describeDuplicate(item) {
  const name = item.productName || (item.merchant !== item.category ? item.merchant : '') || item.category
  return [item.date, item.time, item.type === 'transfer' ? entryLabel(item) : item.category, name !== item.category ? name : '', `¥${Number(item.amount).toFixed(2)}`, incomeAllocationLabel(item), item.payer].filter(Boolean).join(' · ')
}
