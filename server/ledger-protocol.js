export const transferDirections = { to_savings: '活动账户 → 存款账户', from_savings: '存款账户 → 活动账户' }

export function entryLabel(item) {
  return item.type === 'transfer' ? transferDirections[item.transferDirection] || '账户转账' : item.type === 'income' ? '收入' : '支出'
}

export function entrySign(item) {
  return item.type === 'transfer' ? '↔' : item.type === 'income' ? '+' : '−'
}

export function validateIncomeSavings(type, amount, savingsAmount = 0) {
  const saved = Number(savingsAmount)
  if (!Number.isFinite(saved) || saved < 0 || (type !== 'income' && saved !== 0)) {
    throw new Error('只有收入可以分配到存款账户，存款金额不能为负数。')
  }
  if (saved > Number(amount)) throw new Error('存入存款的金额不能超过这笔收入总额。')
  const cents = Math.round(saved * 100)
  if (Math.abs(saved * 100 - cents) > 0.00001) throw new Error('存款金额最多保留两位小数。')
  return cents / 100
}

export function incomeAllocationLabel(item) {
  if (item.type !== 'income') return ''
  const total = Math.round(Number(item.amount) * 100)
  const savings = Math.round(Number(item.savingsAmount || 0) * 100)
  return `活动账户 ¥${((total - savings) / 100).toFixed(2)} · 存款账户 ¥${(savings / 100).toFixed(2)}`
}

export function expenseValues(result) {
  const values = result.expenses == null ? (result.expense == null ? [] : [result.expense]) : result.expenses
  if (!Array.isArray(values) || values.length > 50 || values.some((value) => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('请每次提供不超过 50 笔完整账单。')
  }
  return values
}

export function batchInstructions() {
  return '一次可以记录多笔账单。统一用expenses数组返回每笔独立记录（单笔也用数组），最多50笔；信息不足时expenses为空数组并追问，不能只返回完整的部分而遗漏其他账目。一句话中多笔消费/收入、图片中的多笔交易按原顺序拆分，共用明确的日期/成员，各笔保留自己的类型、金额、分类、商家和收入分配。单张小票的总额和商品明细不能重复记账；默认按实际交易记一笔，只有明确要求按商品拆分时才逐项记录且合计必须等于实付。不得重复提取已经保存的历史账目，只处理本次请求及其未完成的补充信息。'
}

export function savingsInstructions() {
  return '收入支持直接入存款及拆分：income的amount是收入总额，savingsAmount是其中存入存款的金额，必须在0到amount之间，其余进入活动账户。未指定收入去向时savingsAmount为0；全部存入存款时等于amount。例如“收入3000，存入存款1000元”只返回一笔income，amount:3000,savingsAmount:1000，分类未明确时使用其他收入；“工资3000全部存入存款”返回income,amount:3000,savingsAmount:3000,category:工资。不得将同一收入的存款部分另外记为transfer，也不能把存款金额加到收入总额。expense和transfer的savingsAmount为0。独立的账户转账用type:transfer，category固定存款，transferDirection为to_savings（活动转存款）或from_savings（存款转活动）；如单独说“今天存入存款500元”是转账，不是新增收入。转账不计入收支。金额、日期、方向或收入与存款的关系不明确时追问。只记已发生或明确要求记账的款项，未来计划/提醒按任务处理。仅记账，不执行银行转账。'
}
