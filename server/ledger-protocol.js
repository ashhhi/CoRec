export const transferDirections = { to_savings: '活动账户 → 存款账户', from_savings: '存款账户 → 活动账户' }

export function entryLabel(item) {
  return item.type === 'transfer' ? transferDirections[item.transferDirection] || '账户转账' : item.type === 'income' ? '收入' : '支出'
}

export function entrySign(item) {
  return item.type === 'transfer' ? '↔' : item.type === 'income' ? '+' : '−'
}

export function savingsInstructions() {
  return '支持存款分类及账户转账，expense.type可为transfer，category固定存款，transferDirection必须是to_savings（活动转存款）或from_savings（存款转活动）。例如今天存入存款500元是to_savings；从存款取出200元是from_savings。转账不是收入或支出，不可重复记录。金额、日期、方向不明确时追问。只记录已发生或明确要求记账的转账；未来存取钱计划和提醒应按任务处理，不能提前记账。仅记录账本，不执行银行转账。'
}
