import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import mysql from 'mysql2/promise'
import { GroupError } from './groups.js'
import { ensureQqGroupSchema } from './qq-group.js'
import { ensureTaskSchema, createTask, updateTask, registerTaskRoutes, processDueTask, deliverTask, validateTask } from './tasks.js'
import { sendTaskNotification } from './qq-api.js'

test('QQ scheduled notifications use the proactive API and require acknowledgement', async () => {
  const originalFetch=globalThis.fetch
  const originalAppId=process.env.QQ_BOT_APP_ID
  const originalSecret=process.env.QQ_BOT_CLIENT_SECRET
  process.env.QQ_BOT_APP_ID='test-app'
  process.env.QQ_BOT_CLIENT_SECRET='test-secret'
  let accepted=true
  const requests=[]
  globalThis.fetch=async (url,options)=>{
    if(String(url).endsWith('/app/getAppAccessToken')) return Response.json({access_token:'test-token',expires_in:3600})
    requests.push({url:String(url),body:JSON.parse(options.body)})
    return Response.json(accepted?{id:'message-test'}:{code:304064,message:'Not authorized'})
  }
  try {
    await sendTaskNotification({target:'group',target_openid:'test-group'},'Test reminder')
    assert.equal(requests[0].url,'https://api.bot.qq.com/v2/groups/test-group/messages')
    assert.deepEqual(requests[0].body,{msg_type:0,content:'Test reminder'})
    accepted=false
    await assert.rejects(()=>sendTaskNotification({target:'private',target_openid:'test-user'},'Private reminder'),/QQ 未确认发送成功/)
    assert.equal(requests[1].url,'https://api.bot.qq.com/v2/users/test-user/messages')
  } finally {
    globalThis.fetch=originalFetch
    if(originalAppId===undefined) delete process.env.QQ_BOT_APP_ID;else process.env.QQ_BOT_APP_ID=originalAppId
    if(originalSecret===undefined) delete process.env.QQ_BOT_CLIENT_SECRET;else process.env.QQ_BOT_CLIENT_SECRET=originalSecret
  }
})

test('task validation requires a valid future time and supported work', () => {
  const base = { title:'提醒测试', dueAt:'2099-01-01T12:00:00+08:00' }
  assert.equal(validateTask(base).dueAt, '2099-01-01 04:00:00')
  assert.equal(validateTask({ title:'无定时待办' }).dueAt, null)
  for (const dueAt of ['2020-01-01T00:00:00Z','2099-02-30T12:00:00+08:00','2099-01-01T12:00:00','wrong']) assert.throws(() => validateTask({...base,dueAt}), GroupError)
  assert.throws(() => validateTask({...base,kind:'shell'}), GroupError)
  assert.throws(() => validateTask({...base,kind:'generate_text',dueAt:null}), GroupError)
  assert.throws(() => validateTask({...base,title:' '}), GroupError)
})

const configured = process.env.COREC_TEST_MYSQL_SOCKET || process.env.COREC_TEST_MYSQL_URL
test('task lifecycle, scheduling and delivery with MySQL', {skip:!configured}, async (t) => {
  const config = process.env.COREC_TEST_MYSQL_SOCKET ? { socketPath:process.env.COREC_TEST_MYSQL_SOCKET,user:'root' } : process.env.COREC_TEST_MYSQL_URL
  const admin = await mysql.createConnection(config)
  const database = `corec_tasks_test_${randomBytes(8).toString('hex')}`
  let pool, server
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    pool = mysql.createPool(typeof config === 'string' ? {uri:config,database,connectionLimit:8,dateStrings:true} : {...config,database,connectionLimit:8,dateStrings:true})
    const schemaPool = { query: (sql) => pool.query(process.env.COREC_TEST_MYSQL_LEGACY === 'true' ? sql.replaceAll('utf8mb4_0900_ai_ci','utf8mb4_unicode_ci').replace(/CONSTRAINT expenses_amount_positive CHECK \(amount_cents > 0\),/,'') : sql) }
    const schema = await readFile(new URL('../db/init.sql', import.meta.url),'utf8')
    // The task schema is applied below after all QQ tables exist.
    for (const sql of schema.split(';').filter((sql) => sql.trim() && !sql.includes('CREATE TABLE IF NOT EXISTS tasks'))) await schemaPool.query(sql)
    await ensureQqGroupSchema(schemaPool)
    await pool.query(`CREATE TABLE qq_bindings (openid VARCHAR(128) PRIMARY KEY,user_id INT UNSIGNED NOT NULL,group_id INT UNSIGNED NOT NULL)`)
    await ensureTaskSchema(schemaPool)
    await ensureTaskSchema(schemaPool)
    for (let id=1;id<=5;id++) await pool.execute('INSERT INTO accounts (id,username,display_name,password_hash) VALUES (?,?,?,?)',[id,`taskuser${id}`,`User ${id}`,'test'])
    await pool.query("INSERT INTO ledger_groups (id,name,invite_code,created_by) VALUES (1,'Tasks','1111111111111111',1),(2,'Other','2222222222222222',5)")
    await pool.query("INSERT INTO group_members (group_id,user_id,role) VALUES (1,1,'owner'),(1,2,'admin'),(1,3,'member'),(1,4,'member'),(2,5,'owner')")
    await pool.query("INSERT INTO qq_group_links (group_id,group_openid) VALUES (1,'group-one'),(2,'group-two')")
    await pool.query("INSERT INTO qq_bindings (openid,user_id,group_id) VALUES ('private-three',3,1)")
    const app=express()
    app.use(express.json())
    const requireAuth = (req,res,next) => { req.user={id:Number(req.get('X-Test-User'))}; next() }
    const requireGroupMember = async (req,res,next) => {
      const [[member]]=await pool.execute('SELECT role FROM group_members WHERE group_id=? AND user_id=?',[req.params.groupId,req.user.id])
      if (!member) return res.status(403).json({error:'Not a member'})
      req.group={id:Number(req.params.groupId),role:member.role};next()
    }
    registerTaskRoutes(app,{pool,requireAuth,requireGroupMember})
    app.use((error,req,res,next)=>res.status(error instanceof GroupError?error.status:500).json({error:error.message}))
    server=await new Promise((resolve)=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening))})
    const api=async (userId,method,path,body)=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${path}`,{method,headers:{'Content-Type':'application/json','X-Test-User':String(userId)},...(body?{body:JSON.stringify(body)}:{})})
      return {status:response.status,...await response.json()}
    }
    const future=()=>new Date(Date.now()+3600000).toISOString()
    const make=async (body={})=>createTask(pool,1,3,{title:'Test reminder',dueAt:future(),...body})
    const due=async (id)=>pool.execute('UPDATE tasks SET due_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?',[id])
    const row=async (id)=>(await pool.execute('SELECT * FROM tasks WHERE id=?',[id]))[0][0]
    const clear=async ()=>pool.query('DELETE FROM tasks')
    let sends=[]
    const deps={generate:async()=> 'Generated plan',send:async(task,content)=>sends.push({id:task.id,openid:task.target_openid,content})}

    await t.test('create is idempotent even when the original due time has passed',async()=>{
      await clear()
      const a=await make({requestId:'same-request'})
      await due(a.id)
      const b=await createTask(pool,1,3,{title:'ignored',dueAt:'2000-01-01T00:00:00Z',requestId:'same-request'})
      assert.equal(a.id,b.id)
      assert.equal((await row(a.id)).target_openid,'group-one')
    })

    await t.test('group scope and task mutation permissions are enforced',async()=>{
      await clear()
      const task=await make()
      assert.equal((await api(5,'GET','1/tasks')).status,403)
      assert.equal((await api(5,'POST','2/tasks/action',{id:task.id,status:'completed'})).status,404)
      assert.equal((await api(4,'POST','1/tasks/action',{id:task.id,status:'completed'})).status,403)
      assert.equal((await api(2,'POST','1/tasks/action',{id:task.id,status:'completed'})).status,200)
      assert.equal((await api(3,'GET','1/tasks')).tasks[0].status,'completed')
      await assert.rejects(()=>make({assigneeId:5}),GroupError)
      await assert.rejects(()=>createTask(pool,1,5,{title:'No access'}),GroupError)
    })

    await t.test('a due reminder waits for confirmation and is delivered once',async()=>{
      await clear();sends=[]
      const task=await make();await due(task.id)
      assert.equal(await processDueTask(pool,deps),true)
      const waiting=await row(task.id)
      assert.equal(waiting.status,'waiting');assert.equal(waiting.completed_at,null)
      assert.equal(await deliverTask(pool,deps),true)
      assert.equal((await row(task.id)).delivery_status,'sent')
      assert.match(sends[0].content,/完成任务/)
      assert.equal(await processDueTask(pool,deps),false)
      assert.equal(await deliverTask(pool,deps),false)
      assert.equal(sends.length,1)
      await updateTask(pool,1,3,task.id,{status:'completed'})
      assert.equal((await row(task.id)).status,'completed')
    })

    await t.test('unscheduled and cancelled tasks are never dispatched',async()=>{
      await clear()
      await make({dueAt:null})
      const task=await make();await due(task.id)
      await updateTask(pool,1,3,task.id,{status:'cancelled'})
      assert.equal(await processDueTask(pool,deps),false)
      assert.equal(await deliverTask(pool,deps),false)
    })

    await t.test('cancelling running work prevents its result and notification from being committed',async()=>{
      await clear();sends=[]
      const task=await make({kind:'generate_text'});await due(task.id)
      let resolveGeneration,started
      const ready=new Promise((resolve)=>{started=resolve})
      const generation=new Promise((resolve)=>{resolveGeneration=resolve})
      const work=processDueTask(pool,{...deps,generate:async()=>{started();return generation}})
      await ready
      await updateTask(pool,1,3,task.id,{status:'cancelled'})
      resolveGeneration('Late result')
      await work
      assert.equal((await row(task.id)).status,'cancelled')
      assert.equal((await row(task.id)).result,null)
      assert.equal(await deliverTask(pool,deps),false)
      assert.equal(sends.length,0)
    })

    await t.test('marking a reminder complete before sending suppresses its pending notice',async()=>{
      await clear()
      const task=await make();await due(task.id);await processDueTask(pool,deps)
      await updateTask(pool,1,3,task.id,{status:'completed'})
      assert.equal(await deliverTask(pool,deps),false)
    })

    await t.test('automatic text work records its actual result before delivery',async()=>{
      await clear();sends=[]
      const task=await make({kind:'generate_text',details:'Write a packing list'});await due(task.id)
      await processDueTask(pool,deps)
      const result=await row(task.id)
      assert.equal(result.status,'completed');assert.equal(result.result,'Generated plan');assert.ok(result.completed_at)
      await deliverTask(pool,deps)
      assert.match(sends[0].content,/自动任务已完成/)
      assert.match(sends[0].content,/Generated plan/)
    })

    await t.test('execution failures are recorded and reported without false completion',async()=>{
      await clear();sends=[]
      const task=await make({kind:'generate_text'});await due(task.id)
      await processDueTask(pool,{...deps,generate:async()=>{throw new Error('Model unavailable')}})
      assert.equal((await row(task.id)).status,'failed')
      assert.equal((await row(task.id)).completed_at,null)
      await deliverTask(pool,deps)
      assert.match(sends[0].content,/执行失败/)
      assert.doesNotMatch(sends[0].content,/已完成/)
    })

    await t.test('ledger summaries use only the current group and current month',async()=>{
      await clear()
      await pool.query(`INSERT INTO expenses (group_id,date,merchant,category,amount_cents,payer_user_id,payer,created_by)
        VALUES (1,DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00')),'Test','餐饮',1234,3,'User 3',3),
        (2,DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+08:00')),'Secret','购物',999999,5,'User 5',5),
        (1,'2000-01-01','Old','购物',888888,3,'User 3',3)`)
      const task=await make({kind:'ledger_summary'});await due(task.id);await processDueTask(pool,deps)
      const result=(await row(task.id)).result
      assert.match(result,/12\.34/);assert.doesNotMatch(result,/9999\.99|8888\.88|Secret/)
    })

    await t.test('delivery retries are bounded and can be manually retried',async()=>{
      await clear()
      const task=await make();await due(task.id);await processDueTask(pool,deps)
      const failing={...deps,send:async()=>{throw new Error('QQ refused proactive messages')}}
      for(let i=1;i<=3;i++){
        await deliverTask(pool,failing)
        const r=await row(task.id)
        assert.equal(r.delivery_attempts,i)
        assert.equal(r.delivery_status,i<3?'pending':'failed')
        if(i<3) await pool.execute('UPDATE tasks SET delivery_after=UTC_TIMESTAMP() WHERE id=?',[task.id])
      }
      assert.equal((await row(task.id)).status,'waiting')
      await updateTask(pool,1,3,task.id,{action:'retry-delivery'})
      await deliverTask(pool,deps)
      assert.equal((await row(task.id)).delivery_status,'sent')
    })

    await t.test('overdue tasks and expired execution leases recover after restart',async()=>{
      await clear()
      const task=await make({kind:'generate_text'});await due(task.id)
      await pool.execute("UPDATE tasks SET status='running',lease_token='old-worker',lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?",[task.id])
      await processDueTask(pool,deps)
      assert.equal((await row(task.id)).status,'completed')
      await pool.execute("UPDATE tasks SET delivery_status='sending',lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE id=?",[task.id])
      await deliverTask(pool,deps)
      assert.equal((await row(task.id)).delivery_status,'sent')
    })

    await t.test('concurrent workers execute and deliver only one claim',async()=>{
      await clear();sends=[]
      let runs=0
      const task=await make({kind:'generate_text'});await due(task.id)
      const work={...deps,generate:async()=>{runs++;return 'Once'}}
      await Promise.all([processDueTask(pool,work),processDueTask(pool,work)])
      assert.equal(runs,1)
      await Promise.all([deliverTask(pool,deps),deliverTask(pool,deps)])
      assert.equal(sends.length,1)
    })

    await t.test('rebinding cannot redirect existing reminders without explicit rescheduling',async()=>{
      await clear();sends=[]
      const task=await make();await due(task.id)
      await pool.query("UPDATE qq_group_links SET group_openid='replacement-group' WHERE group_id=1")
      await processDueTask(pool,deps)
      assert.equal((await row(task.id)).status,'failed')
      await deliverTask(pool,deps);assert.equal(sends.length,0)
      await pool.execute("UPDATE tasks SET delivery_status='failed',lease_token=NULL WHERE id=?",[task.id])
      await updateTask(pool,1,3,task.id,{action:'reschedule',dueAt:future()})
      assert.equal((await row(task.id)).target_openid,'replacement-group')
      await pool.query("UPDATE qq_group_links SET group_openid='group-one' WHERE group_id=1")
    })

    await t.test('private reminders need the assignee binding to this ledger',async()=>{
      await clear();sends=[]
      await assert.rejects(()=>make({target:'private',assigneeId:4}),GroupError)
      const task=await make({target:'private'});await due(task.id);await processDueTask(pool,deps);await deliverTask(pool,deps)
      assert.equal(sends[0].openid,'private-three')
    })

    await t.test('QQ commands recheck revoked group identities inside the write transaction',async()=>{
      await clear()
      await pool.query("INSERT INTO qq_group_members (group_id,member_openid,user_id) VALUES (1,'member-three',3)")
      const qqGroup={groupOpenid:'group-one',memberOpenid:'member-three'}
      const task=await createTask(pool,1,3,{title:'QQ-created task',dueAt:future()},qqGroup)
      await pool.query("DELETE FROM qq_group_members WHERE group_id=1 AND member_openid='member-three'")
      await assert.rejects(()=>createTask(pool,1,3,{title:'Revoked identity'},qqGroup),/QQ 群绑定已失效/)
      await assert.rejects(()=>updateTask(pool,1,3,task.id,{status:'completed'},qqGroup),/QQ 群绑定已失效/)
      assert.equal((await row(task.id)).status,'pending')
    })

    await t.test('a member leaving stops pending work and notifications',async()=>{
      await clear();sends=[]
      const task=await make({assigneeId:4});await due(task.id)
      await pool.query('DELETE FROM group_members WHERE group_id=1 AND user_id=4')
      await processDueTask(pool,deps)
      assert.equal((await row(task.id)).status,'failed')
      await deliverTask(pool,deps);assert.equal(sends.length,0)
    })

    await t.test('rescheduling clears prior results and dissolution cascades tasks',async()=>{
      await clear()
      const task=await make();await due(task.id);await processDueTask(pool,deps)
      await updateTask(pool,1,3,task.id,{action:'reschedule',dueAt:future()})
      const r=await row(task.id)
      assert.equal(r.status,'pending');assert.equal(r.delivery_status,'none');assert.equal(r.result,null)
      await pool.query('DELETE FROM ledger_groups WHERE id=1')
      assert.equal(await row(task.id),undefined)
    })
  } finally {
    if(server) await new Promise((resolve)=>server.close(resolve))
    if(pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin.end()
  }
})
