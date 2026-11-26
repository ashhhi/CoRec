import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { auditDetails, auditMiddleware, auditQuery, auditRequest, registerAuditRoutes } from './audit.js'

test('audit snapshots keep business changes and exclude credentials, QQ identities and images', () => {
  const details = auditDetails({ before: { amount:35, note:'午饭', payer:'Ash', password:'secret', openid:'private' },
    after: { amount:40, savingsAmount:10, recurrence:{ type:'weekly',weekdays:[1,5],time:'09:00' } },
    code:'binding-code', inviteCode:'invite', token:'secret', image:'data:image/png;base64,...', messages:[{content:'private chat'}], requestId:'secret' })
  assert.deepEqual(details, { before:{amount:35,note:'午饭',payer:'Ash'}, after:{amount:40,savingsAmount:10,recurrence:{type:'weekly',weekdays:[1,5],time:'09:00'}} })
})

test('history query always scopes to the current group or current actor and validates filters', () => {
  assert.deepEqual(auditQuery({actor:'8',category:'ledger',before:'52',from:'2026-11-26',to:'2026-11-26'},7,3), {
    conditions:['group_id=?','actor_id=?','category=?','created_at >= ?','created_at < ?','id < ?'],
    parameters:[7,8,'ledger','2026-11-25 16:00:00','2026-11-26 16:00:00','52'], mine:false,
  })
  assert.deepEqual(auditQuery({scope:'mine'},7,3).parameters,[3])
  for (const filters of [{scope:'other'},{category:'password'},{actor:'1 OR 1=1'},{before:'-1'},{from:'2026-02-30'}]) assert.throws(() => auditQuery(filters,7,3))
})

test('transactional audits keep actor snapshots and suppress duplicate request logs', async () => {
  const writes=[]
  const request={user:{id:3,displayName:'Ash'},group:{id:7,name:'一起去看海'},qqGroup:{},get:()=>'bot-token'}
  await auditRequest({execute:async(sql,params)=>{writes.push({sql,params})}},request,{category:'ledger',action:'编辑账单',entityId:12,details:{before:{amount:35},after:{amount:40}}})
  assert.equal(request.auditRecorded,true)
  assert.deepEqual(writes[0].params.slice(0,9),[7,'一起去看海',3,'Ash','ledger','编辑账单','12','qq-group','success'])
  assert.deepEqual(JSON.parse(writes[0].params[9]),{before:{amount:35},after:{amount:40}})
})

test('request fallback logs failed operations privately and never logs automatic reads', async () => {
  const writes=[]
  const middleware=auditMiddleware({execute:async(sql,params)=>{writes.push(params)}})
  const request={method:'PATCH',path:'/api/groups/7/expenses/12',user:{id:3,displayName:'Ash'},group:{id:7,name:'海'},get:()=>undefined,body:{password:'hidden'}}
  const response=new EventEmitter()
  response.statusCode=403
  middleware(request,response,()=>{})
  response.emit('finish')
  await new Promise(setImmediate)
  assert.equal(writes.length,1)
  assert.equal(writes[0][0],null)
  assert.equal(writes[0][8],'failed')
  assert.equal(writes[0][9].includes('hidden'),false)
  const polling=new EventEmitter()
  middleware({...request,method:'GET'},polling,()=>{})
  polling.emit('finish')
  assert.equal(writes.length,1)
})

test('history routes require authentication and group membership and paginate without exposing another group', async () => {
  const routes={}
  const requireAuth=()=>{},requireGroupMember=()=>{}
  const pool={execute:async(sql,params)=>{
    assert.equal(params[0],7)
    if(sql.includes('GROUP BY'))return [[]]
    if(sql.includes('COUNT(*)'))return [[{total:51}]]
    const limit = Number(/LIMIT (\d+)/.exec(sql)[1])
    return [Array.from({length:limit},(_,i)=>({id:100-i,actor_name:'Ash',group_id:7,details:'{}',created_at:'2026-11-26T08:00:00.000Z'}))]
  }}
  registerAuditRoutes({get:(path,...handlers)=>{routes.get=handlers},post:(path,...handlers)=>{routes.post=handlers}},{pool,requireAuth,requireGroupMember})
  for(const handlers of Object.values(routes))assert.deepEqual(handlers.slice(0,2),[requireAuth,requireGroupMember])
  const response={set(){return this},json(data){this.data=data}}
  await routes.get.at(-1)({query:{},group:{id:7,role:'owner'},user:{id:3}},response)
  assert.equal(response.data.items.length,20)
  assert.equal(response.data.total,51)
  assert.equal(response.data.page,1)
  assert.equal(response.data.pageSize,20)
})


test('only the current owner can read history, including personal history', async () => {
  let handler
  let queries = 0
  registerAuditRoutes({ get: (path, ...handlers) => { handler = handlers.at(-1) }, post() {} }, {
    pool: { execute: async () => { queries++; throw new Error('must not query history') } },
    requireAuth() {}, requireGroupMember() {},
  })
  for (const role of ['admin','member']) {
    for (const scope of ['group','mine']) {
      await assert.rejects(handler({ query:{scope}, group:{id:7,role}, user:{id:3} }, {}), (error) => error.status === 403)
    }
  }
  assert.equal(queries, 0)
})


test('history pagination validates sizes, applies offsets and clamps empty/out-of-range pages', async () => {
  let handler
  const queries = []
  const pool = {execute: async (sql, parameters) => {
    queries.push({sql,parameters})
    if (sql.includes('COUNT(*)')) return [[{total:23}]]
    return [[]]
  }}
  registerAuditRoutes({get: (path,...handlers) => {handler=handlers.at(-1)},post(){}}, {pool,requireAuth(){},requireGroupMember(){}})
  const response = {set(){return this},json(data){this.data=data}}
  for (const pageSize of [5,10,20,50]) {
    await handler({query:{page:'2',pageSize:String(pageSize)},group:{id:7,role:'owner'},user:{id:3}},response)
    const expectedPage = Math.min(2,Math.ceil(23/pageSize))
    assert.equal(response.data.page,expectedPage)
    assert.equal(response.data.pageSize,pageSize)
    assert.ok(queries.some(({sql}) => sql.includes(`LIMIT ${pageSize} OFFSET ${(expectedPage-1)*pageSize}`)))
  }
  for (const query of [{pageSize:'7'},{page:'0'},{page:'2.5'},{page:'NaN'}]) {
    await assert.rejects(handler({query,group:{id:7,role:'owner'},user:{id:3}},response), (error) => error.status===400)
  }
  await handler({query:{page:'99',pageSize:'10'},group:{id:7,role:'owner'},user:{id:3}},response)
  assert.equal(response.data.page,3)
})
