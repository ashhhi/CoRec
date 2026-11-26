export function payerKey(item) {
  return item.payerId != null ? `id:${item.payerId}` : `name:${item.payer || '未记录成员'}`
}

export function ledgerMemberOptions(members, transactions) {
  const options = new Map(members.map((member) => [`id:${member.id}`, member.displayName]))
  for (const item of transactions) {
    const key = payerKey(item)
    if (!options.has(key)) options.set(key, item.payer || '未记录成员')
  }
  const labels = [...options.values()]
  return [...options].map(([value, label]) => ({
    value,
    label: labels.filter((name) => name === label).length > 1 && value.startsWith('id:') ? `${label}（ID ${value.slice(3)}）` : label,
  }))
}

export function filterLedger(transactions, { type, categories, members, search }) {
  const term = search.trim().toLocaleLowerCase()
  return transactions.filter((item) => (
    (type === 'all' || item.type === type)
    && (categories === null || categories.includes(item.category))
    && (members === null || members.includes(payerKey(item)))
    && (!term || (item.productName || '').toLocaleLowerCase().includes(term))
  ))
}
