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
    return [Array.from({length:51},(_,i)=>({id:100-i,actor_name:'Ash',group_id:7,details:'{}',created_at:'2026-11-26T08:00:00.000Z'}))]
  }}
  registerAuditRoutes({get:(path,...handlers)=>{routes.get=handlers},post:(path,...handlers)=>{routes.post=handlers}},{pool,requireAuth,requireGroupMember})
  for(const handlers of Object.values(routes))assert.deepEqual(handlers.slice(0,2),[requireAuth,requireGroupMember])
  const response={set(){return this},json(data){this.data=data}}
  await routes.get.at(-1)({query:{},group:{id:7},user:{id:3}},response)
  assert.equal(response.data.items.length,50)
  assert.equal(response.data.nextCursor,'51')
})
