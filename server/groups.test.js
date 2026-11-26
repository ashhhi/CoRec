import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import mysql from 'mysql2/promise'
import { ensureGroupSchema, GroupError, registerGroupRoutes } from './groups.js'
import { ensureQqGroupSchema } from './qq-group.js'

// Each run creates and drops its own database. Never use the application's database.
const configured = process.env.COREC_TEST_MYSQL_SOCKET || process.env.COREC_TEST_MYSQL_URL
test('group membership and permissions with MySQL', { skip: !configured }, async (t) => {
  const config = process.env.COREC_TEST_MYSQL_SOCKET
    ? { socketPath: process.env.COREC_TEST_MYSQL_SOCKET, user: 'root' }
    : process.env.COREC_TEST_MYSQL_URL
  const admin = await mysql.createConnection(config)
  const database = `corec_groups_test_${randomBytes(8).toString('hex')}`
  let pool
  let server
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    pool = mysql.createPool(typeof config === 'string' ? { uri: config, database, connectionLimit: 5 } : { ...config, database, connectionLimit: 5 })
    // Optional compatibility setting allows exercising routes on a local MySQL 5.7.
    const schemaQuery = (sql) => pool.query(process.env.COREC_TEST_MYSQL_LEGACY === 'true'
      ? sql.replaceAll('utf8mb4_0900_ai_ci', 'utf8mb4_unicode_ci').replace(/CONSTRAINT expenses_amount_positive CHECK \(amount_cents > 0\),/, '') : sql)
    const schemaPool = { query: schemaQuery }
    const schema = await readFile(new URL('../db/init.sql', import.meta.url), 'utf8')
    for (const statement of schema.split(';').filter((sql) => sql.trim())) await schemaQuery(statement)
    for (let id = 1; id <= 12; id++) {
      await pool.execute('INSERT INTO accounts (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)', [id, `user${id}`, `Member ${id}`, 'test'])
    }
    await pool.query('DROP TABLE group_invitations')
    await pool.query('DROP TABLE group_join_requests')
    await pool.query("ALTER TABLE group_members MODIFY role ENUM('owner', 'member') NOT NULL DEFAULT 'member'")
    const [legacyGroup] = await pool.execute('INSERT INTO ledger_groups (name, invite_code, created_by) VALUES (?, ?, 1)', ['Existing group', '0'.repeat(16)])
    await pool.execute("INSERT INTO group_members (group_id, user_id, role) VALUES (?, 1, 'owner'), (?, 3, 'member')", [legacyGroup.insertId, legacyGroup.insertId])
    await ensureGroupSchema(schemaPool)
    await ensureGroupSchema(schemaPool)
    await ensureQqGroupSchema(schemaPool)
    await pool.query(`CREATE TABLE qq_bind_codes (
      code_hash CHAR(64) PRIMARY KEY, user_id INT UNSIGNED NOT NULL, group_id INT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE)`)
    await pool.query(`CREATE TABLE qq_bindings (
      openid VARCHAR(128) PRIMARY KEY, user_id INT UNSIGNED NOT NULL UNIQUE, group_id INT UNSIGNED NOT NULL,
      FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE)`)
    await pool.query(`CREATE TABLE qq_conversations (
      openid VARCHAR(128) PRIMARY KEY, state JSON NOT NULL,
      FOREIGN KEY (openid) REFERENCES qq_bindings(openid) ON DELETE CASCADE)`)
    const app = express()
    app.use(express.json())
    const requireAuth = (req, res, next) => {
      const id = Number(req.get('X-Test-User'))
      if (!id) return res.status(401).json({ error: 'Sign in' })
      req.user = { id }
      next()
    }
    registerGroupRoutes(app, { pool, requireAuth, invitePattern: /^[A-F0-9]{16}$/, usernamePattern: /^[\p{L}\p{N}_.-]{2,32}$/u })
    app.use((error, req, res, next) => res.status(error instanceof GroupError ? error.status : 500).json({ error: error.message }))
    server = await new Promise((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)) })
    const base = `http://127.0.0.1:${server.address().port}`
    const api = async (userId, method, path, body) => {
      const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Test-User': String(userId) }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, ...await response.json() }
    }
    const group = async () => {
      const code = randomBytes(8).toString('hex').toUpperCase()
      const [result] = await pool.execute('INSERT INTO ledger_groups (name, invite_code, created_by) VALUES (?, ?, 1)', ['Test group', code])
      const id = result.insertId
      await pool.execute("INSERT INTO group_members (group_id, user_id, role) VALUES (?, 1, 'owner'), (?, 2, 'admin'), (?, 3, 'member'), (?, 4, 'admin')", [id, id, id, id])
      return { id, code }
    }
    const role = async (groupId, userId) => (await pool.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]))[0][0]?.role

    await t.test('schema upgrade preserves existing owners and members', async () => {
      assert.equal(await role(legacyGroup.insertId, 1), 'owner')
      assert.equal(await role(legacyGroup.insertId, 3), 'member')
      assert.equal((await api(1, 'PATCH', `/groups/${legacyGroup.insertId}/members/3`, { role: 'admin' })).status, 200)
      assert.equal(await role(legacyGroup.insertId, 3), 'admin')
    })

    await t.test('only current owners and administrators can rename their group', async () => {
      const g = await group()
      const other = await group()
      assert.equal((await api(0, 'PATCH', `/groups/${g.id}`, { name: 'Unauthorized' })).status, 401)
      for (const actor of [3, 5]) assert.equal((await api(actor, 'PATCH', `/groups/${g.id}`, { name: 'Unauthorized' })).status, 403)
      for (const name of ['', '   ', 'a'.repeat(81), null, {}, []]) {
        assert.equal((await api(1, 'PATCH', `/groups/${g.id}`, { name })).status, 400)
      }
      const updated = await api(1, 'PATCH', `/groups/${g.id}`, { name: '  一起去看海  ' })
      assert.equal(updated.status, 200)
      assert.equal(updated.group.name, '一起去看海')
      assert.equal((await api(3, 'GET', '/group-access')).memberships.find((item) => item.id === g.id).name, '一起去看海')
      const longest = 'a'.repeat(80)
      assert.equal((await api(2, 'PATCH', `/groups/${g.id}`, { name: longest })).status, 200)
      assert.equal((await pool.execute('SELECT name FROM ledger_groups WHERE id = ?', [g.id]))[0][0].name, longest)
      assert.equal((await pool.execute('SELECT name FROM ledger_groups WHERE id = ?', [other.id]))[0][0].name, 'Test group')
      await api(1, 'PATCH', `/groups/${g.id}/members/2`, { role: 'member' })
      assert.equal((await api(2, 'PATCH', `/groups/${g.id}`, { name: 'Former admin' })).status, 403)
      await api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 3 })
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}`, { name: 'Former owner' })).status, 403)
      assert.equal((await api(3, 'PATCH', `/groups/${g.id}`, { name: '新群主命名' })).status, 200)
      assert.equal((await api(3, 'GET', '/group-access')).memberships.find((item) => item.id === g.id).name, '新群主命名')
    })

    await t.test('invite codes create applications and approval alone grants membership', async () => {
      const g = await group()
      for (let attempt = 0; attempt < 2; attempt++) assert.equal((await api(5, 'POST', '/groups/join', { inviteCode: g.code })).status, 202)
      assert.equal(await role(g.id, 5), undefined)
      assert.equal((await api(5, 'GET', `/groups/${g.id}/access`)).status, 403)
      const inbox = await api(5, 'GET', '/group-access')
      assert.equal(inbox.requests.find((item) => item.groupId === g.id).status, 'pending')
      assert.equal((await api(3, 'POST', `/groups/${g.id}/requests/5`, { action: 'approve' })).status, 403)
      assert.equal((await api(2, 'POST', `/groups/${g.id}/requests/5`, { action: 'reject' })).status, 200)
      assert.equal((await api(5, 'GET', '/group-access')).requests.find((item) => item.groupId === g.id).status, 'rejected')
      assert.equal((await api(5, 'POST', '/groups/join', { inviteCode: g.code })).status, 202)
      assert.equal((await api(2, 'POST', `/groups/${g.id}/requests/5`, { action: 'approve' })).status, 200)
      assert.equal(await role(g.id, 5), 'member')
      assert.equal((await api(1, 'POST', `/groups/${g.id}/requests/5`, { action: 'approve' })).status, 409)
      assert.equal((await api(5, 'POST', '/groups/join', { inviteCode: g.code })).status, 409)
      assert.equal((await api(5, 'GET', '/group-access')).requests.some((item) => item.groupId === g.id), false)
    })

    await t.test('applicants can withdraw only their own applications', async () => {
      const g = await group()
      await api(5, 'POST', '/groups/join', { inviteCode: g.code })
      await api(6, 'DELETE', `/group-requests/${g.id}`)
      assert.equal((await api(1, 'GET', `/groups/${g.id}/access`)).requests.length, 1)
      assert.equal((await api(5, 'DELETE', `/group-requests/${g.id}`)).status, 200)
      assert.equal((await api(1, 'GET', `/groups/${g.id}/access`)).requests.length, 0)
    })

    await t.test('direct invitations require manager permission and recipient acceptance', async () => {
      const g = await group()
      assert.equal((await api(3, 'POST', `/groups/${g.id}/invitations`, { username: 'user5' })).status, 403)
      assert.equal((await api(2, 'POST', `/groups/${g.id}/invitations`, { username: 'user5' })).status, 201)
      assert.equal(await role(g.id, 5), undefined)
      assert.equal((await api(6, 'POST', `/group-invitations/${g.id}`, { action: 'accept' })).status, 404)
      assert.equal((await api(5, 'GET', '/group-access')).invitations.some((item) => item.groupId === g.id), true)
      assert.equal((await api(5, 'POST', `/group-invitations/${g.id}`, { action: 'accept' })).status, 200)
      assert.equal(await role(g.id, 5), 'member')
      assert.equal((await api(5, 'POST', `/group-invitations/${g.id}`, { action: 'accept' })).status, 404)
      await api(1, 'POST', `/groups/${g.id}/invitations`, { username: 'user6' })
      assert.equal((await api(6, 'POST', `/group-invitations/${g.id}`, { action: 'decline' })).status, 200)
      assert.equal(await role(g.id, 6), undefined)
      await api(1, 'POST', `/groups/${g.id}/invitations`, { username: 'user6' })
      assert.equal((await api(2, 'DELETE', `/groups/${g.id}/invitations/6`)).status, 200)
      assert.equal((await api(6, 'POST', `/group-invitations/${g.id}`, { action: 'accept' })).status, 404)
    })

    await t.test('only the owner can appoint and demote administrators', async () => {
      const g = await group()
      assert.equal((await api(2, 'PATCH', `/groups/${g.id}/members/3`, { role: 'admin' })).status, 403)
      assert.equal((await api(3, 'PATCH', `/groups/${g.id}/members/3`, { role: 'admin' })).status, 403)
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}/members/3`, { role: 'owner' })).status, 400)
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}/members/1`, { role: 'member' })).status, 403)
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}/members/3`, { role: 'admin' })).status, 200)
      assert.equal(await role(g.id, 3), 'admin')
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}/members/3`, { role: 'member' })).status, 200)
      assert.equal(await role(g.id, 3), 'member')
      assert.equal((await api(3, 'POST', `/groups/${g.id}/invitations`, { username: 'user5' })).status, 403)
    })

    await t.test('removing members obeys role hierarchy', async () => {
      const g = await group()
      for (const id of [1, 2, 4]) assert.equal((await api(2, 'DELETE', `/groups/${g.id}/members/${id}`)).status, 403)
      assert.equal((await api(3, 'DELETE', `/groups/${g.id}/members/2`)).status, 403)
      assert.equal((await api(2, 'DELETE', `/groups/${g.id}/members/3`)).status, 200)
      assert.equal(await role(g.id, 3), undefined)
      assert.equal((await api(3, 'GET', `/groups/${g.id}/access`)).status, 403)
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}/members/4`)).status, 200)
      assert.equal(await role(g.id, 4), undefined)
    })

    await t.test('leaving clears QQ identities and codes while preserving expenses and other groups', async () => {
      const g = await group()
      const other = await group()
      const openid = `private-${g.id}`
      await pool.execute('INSERT INTO qq_bindings (openid, user_id, group_id) VALUES (?, 3, ?)', [openid, g.id])
      await pool.execute('INSERT INTO qq_conversations (openid, state) VALUES (?, ?)', [openid, '{"messages":[]}'])
      await pool.execute('INSERT INTO qq_bind_codes (code_hash, user_id, group_id, expires_at) VALUES (?, 3, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE)), (?, 3, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', ['a'.repeat(64), g.id, 'b'.repeat(64), other.id])
      for (const id of [g.id, other.id]) {
        await pool.execute('INSERT INTO qq_group_links (group_id, group_openid) VALUES (?, ?)', [id, `qq-${id}`])
        await pool.execute('INSERT INTO qq_group_members (group_id, user_id, member_openid) VALUES (?, 3, ?)', [id, `member-${id}`])
      }
      const requestHash = 'e'.repeat(64)
      await pool.execute('INSERT INTO qq_group_bind_requests (request_hash, group_openid, member_openid, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', [requestHash, `qq-${g.id}`, `member-${g.id}`])
      await pool.execute('INSERT INTO qq_group_bind_claims (confirm_hash, request_hash, group_id, user_id) VALUES (?, ?, ?, 3)', ['f'.repeat(64), requestHash, g.id])
      await pool.execute("INSERT INTO expenses (group_id, date, merchant, category, amount_cents, payer_user_id, payer, created_by) VALUES (?, '2026-11-26', 'Test', '其他', 3000, 3, 'Member 3', 3)", [g.id])
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}/membership`)).status, 409)
      assert.equal((await api(3, 'DELETE', `/groups/${g.id}/membership`)).status, 200)
      assert.equal(await role(g.id, 3), undefined)
      assert.equal(await role(other.id, 3), 'member')
      assert.equal((await pool.execute('SELECT * FROM qq_bindings WHERE user_id = 3'))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM qq_conversations WHERE openid = ?', [openid]))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM qq_bind_codes WHERE group_id = ?', [g.id]))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM qq_bind_codes WHERE group_id = ?', [other.id]))[0].length, 1)
      assert.equal((await pool.execute('SELECT * FROM qq_group_members WHERE group_id = ?', [g.id]))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM qq_group_members WHERE group_id = ?', [other.id]))[0].length, 1)
      assert.equal((await pool.execute('SELECT * FROM qq_group_bind_requests WHERE request_hash = ?', [requestHash]))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM qq_group_bind_claims WHERE group_id = ?', [g.id]))[0].length, 0)
      assert.equal((await pool.execute('SELECT * FROM expenses WHERE group_id = ?', [g.id]))[0].length, 1)
      assert.equal((await api(2, 'DELETE', `/groups/${g.id}/membership`)).status, 200)
      assert.equal((await api(2, 'POST', `/groups/${g.id}/invitations`, { username: 'user5' })).status, 403)
    })

    await t.test('ownership transfers atomically and the former owner can leave', async () => {
      const g = await group()
      assert.equal((await api(2, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 3 })).status, 403)
      assert.equal((await api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 1 })).status, 400)
      assert.equal((await api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 12 })).status, 404)
      assert.equal(await role(g.id, 1), 'owner')
      assert.equal((await api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 3 })).status, 200)
      assert.equal(await role(g.id, 1), 'member')
      assert.equal(await role(g.id, 3), 'owner')
      assert.equal((await pool.execute('SELECT created_by FROM ledger_groups WHERE id = ?', [g.id]))[0][0].created_by, 3)
      assert.equal((await pool.execute("SELECT user_id FROM group_members WHERE group_id = ? AND role = 'owner'", [g.id]))[0].length, 1)
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}`)).status, 403)
      assert.equal((await api(1, 'PATCH', `/groups/${g.id}/members/2`, { role: 'member' })).status, 403)
      assert.equal((await api(3, 'PATCH', `/groups/${g.id}/members/2`, { role: 'member' })).status, 200)
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}/membership`)).status, 200)
    })

    await t.test('concurrent approvals add one membership and report the stale action', async () => {
      const g = await group()
      await api(5, 'POST', '/groups/join', { inviteCode: g.code })
      const responses = await Promise.all([api(1, 'POST', `/groups/${g.id}/requests/5`, { action: 'approve' }), api(2, 'POST', `/groups/${g.id}/requests/5`, { action: 'approve' })])
      assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409])
      assert.equal(await role(g.id, 5), 'member')
    })

    await t.test('concurrent ownership transfers leave exactly one owner', async () => {
      const g = await group()
      const results = await Promise.all([
        api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 2 }),
        api(1, 'POST', `/groups/${g.id}/transfer-owner`, { userId: 3 }),
      ])
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 403])
      const [owners] = await pool.execute("SELECT user_id FROM group_members WHERE group_id = ? AND role = 'owner'", [g.id])
      assert.equal(owners.length, 1)
      assert.equal(await role(g.id, 1), 'member')
      assert.equal((await pool.execute('SELECT created_by FROM ledger_groups WHERE id = ?', [g.id]))[0][0].created_by, owners[0].user_id)
    })

    await t.test('only the current owner can dissolve a group and its dependent data', async () => {
      const g = await group()
      const other = await group()
      await api(5, 'POST', '/groups/join', { inviteCode: g.code })
      await api(2, 'POST', `/groups/${g.id}/invitations`, { username: 'user6' })
      const openid = `disband-${g.id}`
      await pool.execute('INSERT INTO qq_group_links (group_id, group_openid) VALUES (?, ?)', [g.id, openid])
      await pool.execute('INSERT INTO qq_group_members (group_id, user_id, member_openid) VALUES (?, 1, ?)', [g.id, openid])
      await pool.execute('INSERT INTO qq_group_bind_requests (request_hash, group_openid, member_openid, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', ['c'.repeat(64), openid, openid])
      await pool.execute('INSERT INTO qq_group_bind_claims (confirm_hash, request_hash, group_id, user_id) VALUES (?, ?, ?, 1)', ['d'.repeat(64), 'c'.repeat(64), g.id])
      await pool.execute('INSERT INTO qq_bindings (openid, user_id, group_id) VALUES (?, 1, ?)', [openid, g.id])
      await pool.execute("INSERT INTO expenses (group_id, date, merchant, category, amount_cents, payer_user_id, payer, created_by) VALUES (?, '2026-11-26', 'Test', '其他', 3000, 1, 'Member 1', 1)", [g.id])
      for (const actor of [2, 3, 5, 12]) assert.equal((await api(actor, 'DELETE', `/groups/${g.id}`)).status, 403)
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}`)).status, 200)
      for (const table of ['group_members', 'expenses', 'qq_group_links', 'qq_group_members', 'qq_group_bind_claims', 'qq_bindings', 'group_join_requests', 'group_invitations']) {
        assert.equal((await pool.execute(`SELECT * FROM ${table} WHERE group_id = ?`, [g.id]))[0].length, 0, table)
      }
      assert.equal((await pool.execute('SELECT * FROM qq_group_bind_requests WHERE group_openid = ?', [openid]))[0].length, 0)
      assert.equal(await role(other.id, 1), 'owner')
      assert.equal((await api(1, 'DELETE', `/groups/${g.id}`)).status, 404)
    })
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    if (pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin.end()
  }
})
