import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { taskInstructions, taskTimeNow } from './task-protocol.js'
import { savingsInstructions, transferDirections, validateIncomeSavings, incomeAllocationLabel, expenseValues, batchInstructions, ledgerTimeNow, resolveEntryTime, resolveEntryDate, ledgerTimeInstructions } from './ledger-protocol.js'

const categories=['餐饮','交通','娱乐','购物','居住','其他']
const incomeCategories=['工资','奖金','退款','其他收入']
const member={id:3,displayName:'Ash'}
const task={title:'交水电费',kind:'reminder',dueAt:'2099-01-01T15:00:00+08:00',target:'group'}
const expense={type:'expense',category:'餐饮',amount:35,date:'2026-11-26',payerName:'Ash'}

test('web Chat distinguishes task drafts, follow-up questions, actions and expenses',async()=>{
  const source=await readFile(new URL('../src/ChatPage.jsx',import.meta.url),'utf8')
  let answer={intent:'task',reply:'Task draft',task}
  const requests=[]
  const context=vm.createContext({categories,incomeCategories,taskInstructions,taskTimeNow,savingsInstructions,transferDirections,validateIncomeSavings,incomeAllocationLabel,expenseValues,batchInstructions,resolveEntryTime,resolveEntryDate,ledgerTimeInstructions,ledgerTimeNow:()=>'2026-11-26 16:42',AbortController,
    window:{setTimeout,clearTimeout},
    fetch:async(url,options)=>{
      const body=JSON.parse(options.body)
      requests.push(body)
      assert.ok(body.messages.reduce((size,item)=>size+item.content.length,0)<=5000)
      assert.ok(body.messages.every((item)=>item.content.length<=4000))
      assert.match(body.messages[0].content,/UTC\+8/)
      return Response.json({output_text:JSON.stringify(answer)})
    },
  })
  vm.runInContext(source.slice(source.indexOf('function extractJson('),source.indexOf('export default function ChatPage(')),context)
  const history=[{id:'user',role:'user',content:'明天下午3点提醒我交水电费'}]
  let result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.intent,'task');assert.equal(result.task.title,task.title);assert.equal(result.expense,undefined)
  answer={intent:'task',reply:'请问明天几点？',task:null}
  result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.task,null);assert.match(result.reply,/几点/)
  answer={intent:'task',taskAction:{id:123,status:'completed'}}
  result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.taskAction.id,123)
  answer={intent:'expense',reply:'Expense draft',expense}
  result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.expense.amount,35);assert.equal(result.expense.payerId,3)
  assert.equal(result.expense.time,'16:42')
  answer={expenses:[{...expense,date:undefined,time:null},{...expense,date:null,time:'09:15'}]}
  result=await context.parseExpense([{id:'now',role:'user',content:'午饭35元，9点15早餐35元'}],[member],member,1)
  assert.equal(result.expenses[0].date,'2026-11-26');assert.equal(result.expenses[0].time,'16:42')
  assert.equal(result.expenses[1].date,'2026-11-26');assert.equal(result.expenses[1].time,'09:15')
  answer={expenses:[{...expense,date:'2026-11-25',time:null},{...expense,time:'09:15'}]}
  result=await context.parseExpense([{id:'date',role:'user',content:'昨天午饭35，今天9点15早餐35'}],[member],member,1)
  assert.equal(result.expenses[0].date,'2026-11-25');assert.equal(result.expenses[0].time,'16:42')
  assert.equal(result.expenses[1].time,'09:15')
  answer={reply:'多笔账单',expenses:[{...expense,type:'income',category:'其他收入',amount:3000,savingsAmount:1000},expense]}
  result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.expenses.length,2);assert.equal(result.expenses[0].savingsAmount,1000)
  assert.equal(result.expense,null)
  const imageBatchCount=requests.length
  result=await context.parseExpense([{id:'image-batch',role:'user',content:'',image:'test-image'}],[member],member,1)
  assert.equal(result.expenses.length,2);assert.equal(requests.length,imageBatchCount+1)
  answer={expenses:[expense,{...expense,type:'income',category:'工资',amount:100,savingsAmount:200}]}
  result=await context.parseExpense(history,[member],member,1)
  assert.equal(result.expenses.length,0);assert.match(result.reply,/不能超过/)
  answer={intent:'task',task}
  const imageHistory=[{id:'image',role:'user',content:'',image:'test-image'}]
  const count=requests.length
  result=await context.parseExpense(imageHistory,[member],member,1)
  assert.equal(result.intent,'task');assert.equal(requests.length,count+1)
  const longHistory=Array.from({length:14},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:'x'.repeat(3000)}))
  await context.parseExpense(longHistory,[member],member,1)
})

test('QQ Chat routes task requests and retains accounting responses',async()=>{
  const source=await readFile(new URL('./qq-bot.js',import.meta.url),'utf8')
  let answer={intent:'task',task}
  const context=vm.createContext({categories,incomeCategories,taskInstructions,taskTimeNow,savingsInstructions,transferDirections,validateIncomeSavings,incomeAllocationLabel,expenseValues,batchInstructions,resolveEntryTime,resolveEntryDate,ledgerTimeInstructions,ledgerTimeNow:()=>'2026-11-26 16:42',process:{env:{TZ:'Asia/Hong_Kong'}},
    corecRequest:async(binding,path,body)=>{
      assert.equal(path,'llm/chat')
      assert.ok(body.messages.reduce((size,item)=>size+item.content.length,0)<=5000)
      return {output_text:JSON.stringify(answer)}
    },
  })
  vm.runInContext(source.slice(source.indexOf('function extractJson('),source.indexOf('async function handleMessage(')),context)
  const binding={group_id:1,user_id:3}
  const chat={groupOpenid:'group-one',openid:'member-three'}
  const history=[{role:'user',content:'明天下午3点提醒我交水电费'}]
  assert.equal(context.classifyMessage({content:history[0].content},'GROUP_MESSAGE_CREATE').mode,'task')
  assert.equal(context.classifyMessage({content:'完成任务 123'},'GROUP_MESSAGE_CREATE').mode,'task')
  let result=await context.parseMessage(binding,history,chat)
  assert.equal(result.intent,'task');assert.equal(result.task.title,task.title)
  answer={intent:'task',reply:'请补充时间',task:null}
  result=await context.parseMessage(binding,history,chat)
  assert.equal(result.task,null);assert.match(result.reply,/时间/)
  answer={intent:'expense',reply:'',expense}
  result=await context.parseMessage(binding,history,chat)
  assert.equal(result.expense.amount,35)
  assert.equal(result.expense.payerId,3)
  assert.equal(result.expense.time,'16:42')
  answer={expenses:[{...expense,date:undefined,time:null},{...expense,date:null,time:'09:15'}]}
  result=await context.parseMessage(binding,[{role:'user',content:'午饭35元，9点15早餐35元'}],chat)
  assert.equal(result.expenses[0].date,'2026-11-26');assert.equal(result.expenses[0].time,'16:42')
  assert.equal(result.expenses[1].date,'2026-11-26');assert.equal(result.expenses[1].time,'09:15')
  answer={expenses:[{...expense,date:'2026-11-25',time:null},{...expense,time:'09:15'}]}
  result=await context.parseMessage(binding,[{role:'user',content:'昨天午饭35，今天9点15早餐35'}],chat)
  assert.equal(result.expenses[0].date,'2026-11-25');assert.equal(result.expenses[0].time,'16:42')
  assert.equal(result.expenses[1].time,'09:15')
  answer={expenses:[{...expense,type:'income',category:'工资',amount:3000,savingsAmount:3000},expense]}
  result=await context.parseMessage(binding,history,chat)
  assert.equal(result.expenses.length,2);assert.equal(result.expenses[0].savingsAmount,3000)
  answer={expenses:[expense,{...expense,savingsAmount:10}]}
  result=await context.parseMessage(binding,history,chat)
  assert.equal(result.expenses.length,0);assert.match(result.reply,/只有收入/)
})


test('ledger time uses Hong Kong timezone across midnight', () => {
  assert.equal(ledgerTimeNow(new Date('2026-11-25T16:42:00Z')), '2026-11-26 00:42')
  assert.equal(resolveEntryDate(null, '2026-11-26'), '2026-11-26')
  assert.equal(resolveEntryDate('2026-11-25', '2026-11-26'), '2026-11-25')
  assert.throws(() => resolveEntryDate('2026-02-30', '2026-11-26'), /有效的账单日期/)
  assert.equal(resolveEntryTime(null, '16:42'), '16:42')
  assert.equal(resolveEntryTime('00:00', '16:42'), '00:00')
  assert.throws(() => resolveEntryTime('25:00', '16:42'), /有效的账单时间/)
})
