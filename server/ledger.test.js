import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { GroupError } from './groups.js'
import { validateIncomeSavings } from './ledger-protocol.js'

const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
const routes = source.slice(source.indexOf('function validateExpenseInput('), source.indexOf('app.use((error, _request'))
const income = { type: 'income', category: '工资', amount: 3000, savingsAmount: 1000, date: '2026-11-26', payerId: 3, merchant: '工资' }
const expense = { ...income, type: 'expense', category: '餐饮', merchant: '餐饮', amount: 35, savingsAmount: 0 }

function setup({ duplicate = false, failInsert = 0, savings = 0, record } = {}) {
  const handlers = {}
  const writes = []
  const calls = []
  let committed = false
  const connection = {
    async beginTransaction() { calls.push('begin') },
    async commit() { committed = true; calls.push('commit') },
    async rollback() { writes.length = 0; calls.push('rollback') },
    release() { calls.push('release') },
    async execute(sql, params) {
      if (sql.includes('FROM ledger_groups')) return [[{ id: 1 }]]
      if (sql.includes('JOIN accounts a ON a.id=gm.user_id')) return [[{ id: 3, display_name: 'Ash' }]]
      if (sql.includes('FROM group_members')) return [[{ user_id: 3 }]]
      if (sql.includes('e.date=?')) return [duplicate ? [{ id: 88 }] : []]
      if (sql.includes('INSERT INTO expenses')) {
        if (failInsert === writes.length + 1) throw new Error('database unavailable')
        writes.push(params)
        return [{ insertId: writes.length }]
      }
      if (sql.includes('e.id IN')) return [writes.map((row, i) => ({ id: i + 1, amount_cents: row[9], income_savings_cents: row[10] }))]
      if (sql.includes('FROM expenses WHERE id=')) return [[record]]
      if (sql.includes('DELETE FROM expenses')) { calls.push('delete'); return [{ affectedRows: 1 }] }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
  const context = vm.createContext({ GroupError, validateIncomeSavings,
    categories: new Set(['餐饮']), incomeCategories: new Set(['工资']), datePattern: /^\d{4}-\d{2}-\d{2}$/,
    app: { post(path, ...callbacks) { handlers.post = callbacks.at(-1) }, delete(path, ...callbacks) { handlers.delete = callbacks.at(-1) } },
    requireAuth() {}, requireGroupMember() {}, hasCurrentQqGroupBinding: async () => true,
    pool: { async getConnection() { calls.push('connect'); return connection } },
    getAccountBalances: async () => ({ savingsCents: savings }),
    serializeExpense: (row) => ({ id: row.id, amount: row.amount_cents / 100, savingsAmount: row.income_savings_cents / 100 }),
  })
  vm.runInContext(routes, context)
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this }, json(data) { this.data = data } }
  return { writes, calls, response, committed: () => committed,
    post: (body, qqGroup = false) => handlers.post({ body, qqGroup, user: { id: 3 }, group: { id: 1 } }, response),
    remove: () => handlers.delete({ params: { id: 7 }, user: { id: 3 }, group: { id: 1 } }, response) }
}

test('income allocation and batch input validation reject invalid amounts before writing', async () => {
  for (const savingsAmount of [-1, 3001, 1.001, 'invalid']) {
    const app = setup()
    await assert.rejects(app.post({ expenses: [expense, { ...income, savingsAmount }] }), GroupError)
    assert.equal(app.calls.length, 0)
  }
  const app = setup()
  await assert.rejects(app.post({ expenses: [income, { ...expense, payerId: 4 }] }, true), /发送者/)
  assert.equal(app.calls.length, 0)
})

test('mixed batch saves income allocation once and returns every record', async () => {
  const app = setup()
  await app.post({ expenses: [income, expense, { ...income, savingsAmount: 3000 }] })
  assert.equal(app.response.statusCode, 201)
  assert.equal(app.response.data.expenses.length, 3)
  assert.deepEqual(app.writes.map((row) => [row[9], row[10]]), [[300000, 100000], [3500, 0], [300000, 300000]])
  assert.equal(app.committed(), true)
})

test('duplicates and database failures leave the whole batch unsaved', async () => {
  const duplicate = setup({ duplicate: true })
  await duplicate.post({ expenses: [income, expense] })
  assert.equal(duplicate.response.statusCode, 409)
  assert.equal(duplicate.writes.length, 0)
  const confirmed = setup({ duplicate: true })
  await confirmed.post({ expenses: [income, expense], confirmedDuplicateIds: [88] })
  assert.equal(confirmed.committed(), true)
  const failure = setup({ failInsert: 2 })
  await assert.rejects(failure.post({ expenses: [income, expense] }), /database unavailable/)
  assert.equal(failure.committed(), false)
  assert.equal(failure.writes.length, 0)
  assert.ok(failure.calls.includes('release'))
})

test('single entry API compatibility and savings withdrawal/deletion guards', async () => {
  const single = setup()
  await single.post(income)
  assert.equal(single.response.data.expense.savingsAmount, 1000)
  const withdrawal = setup()
  await assert.rejects(withdrawal.post({ expenses: [income, { ...expense, type: 'transfer', category: '存款', amount: 1001, transferDirection: 'from_savings' }] }), /余额不足/)
  assert.equal(withdrawal.writes.length, 0)
  const deletion = setup({ savings: 99999, record: { entry_type: 'income', income_savings_cents: 100000 } })
  await assert.rejects(deletion.remove(), /余额不足/)
  assert.equal(deletion.calls.includes('delete'), false)
})
