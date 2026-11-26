export class GroupError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const managesGroup = (role) => role === 'owner' || role === 'admin'

export async function ensureGroupSchema(pool) {
  const [[role]] = await pool.query("SHOW COLUMNS FROM group_members LIKE 'role'")
  if (!role.Type.includes("'admin'")) {
    await pool.query("ALTER TABLE group_members MODIFY role ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member'")
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS group_join_requests (
    group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
    status ENUM('pending', 'rejected') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS group_invitations (
    group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, invited_by INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
}

function validId(value) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new GroupError(400, '成员或群组编号无效。')
  return id
}

async function transaction(pool, run) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await run(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

async function lockGroup(connection, groupId) {
  const [[group]] = await connection.execute('SELECT id, name, created_by FROM ledger_groups WHERE id = ? FOR UPDATE', [groupId])
  if (!group) throw new GroupError(404, '群组不存在或已解散。')
  return group
}

async function memberRole(connection, groupId, userId) {
  const [[member]] = await connection.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])
  return member?.role
}

async function addMember(connection, groupId, userId) {
  if (await memberRole(connection, groupId, userId)) throw new GroupError(409, '该账号已经是群组成员。')
  await connection.execute("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')", [groupId, userId])
  await connection.execute('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?', [groupId, userId])
  await connection.execute('DELETE FROM group_invitations WHERE group_id = ? AND user_id = ?', [groupId, userId])
}

async function removeMember(connection, groupId, userId) {
  // Group chat identities and pending verification claims cascade from group_members.
  // Private bindings reference accounts instead, so remove them explicitly.
  await connection.execute('DELETE FROM qq_bind_codes WHERE group_id = ? AND user_id = ?', [groupId, userId])
  await connection.execute('DELETE FROM qq_bindings WHERE group_id = ? AND user_id = ?', [groupId, userId])
  await connection.execute(`DELETE r FROM qq_group_bind_requests r JOIN qq_group_bind_claims c ON c.request_hash = r.request_hash
    WHERE c.group_id = ? AND c.user_id = ?`, [groupId, userId])
  await connection.execute(`DELETE r FROM qq_group_bind_requests r
    JOIN qq_group_links l ON l.group_openid = r.group_openid
    JOIN qq_group_members m ON m.group_id = l.group_id AND m.member_openid = r.member_openid
    WHERE m.group_id = ? AND m.user_id = ?`, [groupId, userId])
  await connection.execute('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?', [groupId, userId])
  await connection.execute('DELETE FROM group_invitations WHERE group_id = ? AND (user_id = ? OR invited_by = ?)', [groupId, userId, userId])
  await connection.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])
}

export function registerGroupRoutes(app, { pool, requireAuth, invitePattern, usernamePattern }) {
  const withGroup = (request, roles, run) => transaction(pool, async (connection) => {
    const group = await lockGroup(connection, validId(request.params.groupId))
    const role = await memberRole(connection, group.id, request.user.id)
    if (!role || (roles && !roles.includes(role))) throw new GroupError(403, '你没有执行此操作的权限。')
    if (role === 'owner' && group.created_by !== request.user.id) throw new GroupError(403, '只有当前群主可以执行此操作。')
    return run(connection, group, role)
  })

  app.patch('/api/groups/:groupId', requireAuth, async (request, response) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
    if (!name || name.length > 80) throw new GroupError(400, '群组名称需为 1 到 80 个字符。')
    const group = await withGroup(request, ['owner', 'admin'], async (connection, group, role) => {
      await connection.execute('UPDATE ledger_groups SET name = ? WHERE id = ?', [name, group.id])
      return { id: group.id, name, role }
    })
    response.json({ group })
  })

  app.post('/api/groups/join', requireAuth, async (request, response) => {
    const inviteCode = typeof request.body?.inviteCode === 'string' ? request.body.inviteCode.trim().toUpperCase() : ''
    if (!invitePattern.test(inviteCode)) throw new GroupError(400, '请输入有效的邀请码。')
    const result = await transaction(pool, async (connection) => {
      const [[group]] = await connection.execute('SELECT id, name FROM ledger_groups WHERE invite_code = ? FOR UPDATE', [inviteCode])
      if (!group) throw new GroupError(404, '没有找到这个群组，请检查邀请码。')
      if (await memberRole(connection, group.id, request.user.id)) throw new GroupError(409, '你已经在这个群组里了。')
      await connection.execute(`INSERT INTO group_join_requests (group_id, user_id) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE created_at = IF(status = 'pending', created_at, CURRENT_TIMESTAMP), status = 'pending'`, [group.id, request.user.id])
      return { groupId: group.id, groupName: group.name, status: 'pending' }
    })
    response.status(202).json({ request: result })
  })

  app.get('/api/group-access', requireAuth, async (request, response) => {
    const [requests] = await pool.execute(`SELECT r.group_id AS groupId, g.name AS groupName, r.status, r.created_at AS createdAt
      FROM group_join_requests r JOIN ledger_groups g ON g.id = r.group_id WHERE r.user_id = ? ORDER BY r.created_at DESC`, [request.user.id])
    const [invitations] = await pool.execute(`SELECT i.group_id AS groupId, g.name AS groupName, a.display_name AS invitedBy, i.created_at AS createdAt
      FROM group_invitations i JOIN ledger_groups g ON g.id = i.group_id JOIN accounts a ON a.id = i.invited_by
      WHERE i.user_id = ? ORDER BY i.created_at DESC`, [request.user.id])
    const [memberships] = await pool.execute(`SELECT gm.group_id AS id, gm.role, g.name
      FROM group_members gm JOIN ledger_groups g ON g.id = gm.group_id WHERE gm.user_id = ? ORDER BY gm.group_id`, [request.user.id])
    response.set('Cache-Control', 'no-store').json({ requests, invitations, memberships })
  })

  app.delete('/api/group-requests/:groupId', requireAuth, async (request, response) => {
    await transaction(pool, async (connection) => {
      const groupId = validId(request.params.groupId)
      await lockGroup(connection, groupId)
      await connection.execute('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?', [groupId, request.user.id])
    })
    response.json({ ok: true })
  })

  app.post('/api/group-invitations/:groupId', requireAuth, async (request, response) => {
    const action = request.body?.action
    if (!['accept', 'decline'].includes(action)) throw new GroupError(400, '请选择接受或拒绝邀请。')
    const group = await transaction(pool, async (connection) => {
      const group = await lockGroup(connection, validId(request.params.groupId))
      const [[invitation]] = await connection.execute('SELECT user_id FROM group_invitations WHERE group_id = ? AND user_id = ?', [group.id, request.user.id])
      if (!invitation) throw new GroupError(404, '邀请已失效。')
      if (action === 'accept') await addMember(connection, group.id, request.user.id)
      else await connection.execute('DELETE FROM group_invitations WHERE group_id = ? AND user_id = ?', [group.id, request.user.id])
      return { id: group.id, name: group.name, role: 'member' }
    })
    response.json({ ok: true, ...(action === 'accept' ? { group } : {}) })
  })

  app.get('/api/groups/:groupId/access', requireAuth, async (request, response) => {
    const result = await withGroup(request, ['owner', 'admin'], async (connection, group) => {
      const [requests] = await connection.execute(`SELECT r.user_id AS userId, a.username, a.display_name AS displayName, r.created_at AS createdAt
        FROM group_join_requests r JOIN accounts a ON a.id = r.user_id
        WHERE r.group_id = ? AND r.status = 'pending' ORDER BY r.created_at, r.user_id`, [group.id])
      const [invitations] = await connection.execute(`SELECT i.user_id AS userId, a.username, a.display_name AS displayName
        FROM group_invitations i JOIN accounts a ON a.id = i.user_id WHERE i.group_id = ? ORDER BY i.created_at, i.user_id`, [group.id])
      return { requests, invitations }
    })
    response.set('Cache-Control', 'no-store').json(result)
  })

  app.post('/api/groups/:groupId/requests/:userId', requireAuth, async (request, response) => {
    const userId = validId(request.params.userId)
    const action = request.body?.action
    if (!['approve', 'reject'].includes(action)) throw new GroupError(400, '请选择通过或拒绝申请。')
    await withGroup(request, ['owner', 'admin'], async (connection, group) => {
      const [[application]] = await connection.execute("SELECT user_id FROM group_join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'", [group.id, userId])
      if (!application) throw new GroupError(409, '该申请已被处理或撤回。')
      if (action === 'approve') await addMember(connection, group.id, userId)
      else await connection.execute("UPDATE group_join_requests SET status = 'rejected' WHERE group_id = ? AND user_id = ?", [group.id, userId])
    })
    response.json({ ok: true })
  })

  app.post('/api/groups/:groupId/invitations', requireAuth, async (request, response) => {
    const username = typeof request.body?.username === 'string' ? request.body.username.trim() : ''
    if (!usernamePattern.test(username)) throw new GroupError(400, '请输入有效的 CoRec 账号。')
    await withGroup(request, ['owner', 'admin'], async (connection, group) => {
      const [[user]] = await connection.execute('SELECT id FROM accounts WHERE username = ?', [username])
      if (!user) throw new GroupError(404, '没有找到该 CoRec 账号。')
      if (await memberRole(connection, group.id, user.id)) throw new GroupError(409, '该账号已经是群组成员。')
      await connection.execute(`INSERT INTO group_invitations (group_id, user_id, invited_by) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE invited_by = VALUES(invited_by), created_at = CURRENT_TIMESTAMP`, [group.id, user.id, request.user.id])
    })
    response.status(201).json({ ok: true })
  })

  app.delete('/api/groups/:groupId/invitations/:userId', requireAuth, async (request, response) => {
    const userId = validId(request.params.userId)
    await withGroup(request, ['owner', 'admin'], (connection, group) => connection.execute('DELETE FROM group_invitations WHERE group_id = ? AND user_id = ?', [group.id, userId]))
    response.json({ ok: true })
  })

  app.patch('/api/groups/:groupId/members/:userId', requireAuth, async (request, response) => {
    const userId = validId(request.params.userId)
    const role = request.body?.role
    if (!['admin', 'member'].includes(role)) throw new GroupError(400, '只能设置管理员或普通成员。')
    await withGroup(request, ['owner'], async (connection, group) => {
      const targetRole = await memberRole(connection, group.id, userId)
      if (!targetRole) throw new GroupError(404, '该成员已离开群组。')
      if (targetRole === 'owner' || userId === group.created_by) throw new GroupError(403, '不能修改群主的角色。')
      await connection.execute('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [role, group.id, userId])
    })
    response.json({ ok: true })
  })

  app.post('/api/groups/:groupId/transfer-owner', requireAuth, async (request, response) => {
    const userId = validId(request.body?.userId)
    await withGroup(request, ['owner'], async (connection, group) => {
      if (userId === request.user.id) throw new GroupError(400, '请选择其他成员接任群主。')
      if (!await memberRole(connection, group.id, userId)) throw new GroupError(404, '新群主必须是当前群组成员。')
      await connection.execute("UPDATE group_members SET role = 'member' WHERE group_id = ? AND user_id = ?", [group.id, request.user.id])
      await connection.execute("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?", [group.id, userId])
      await connection.execute('UPDATE ledger_groups SET created_by = ? WHERE id = ?', [userId, group.id])
    })
    response.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/members/:userId', requireAuth, async (request, response) => {
    const userId = validId(request.params.userId)
    await withGroup(request, ['owner', 'admin'], async (connection, group, role) => {
      const targetRole = await memberRole(connection, group.id, userId)
      if (!targetRole) throw new GroupError(404, '该成员已离开群组。')
      if (userId === request.user.id || targetRole === 'owner' || userId === group.created_by) throw new GroupError(403, '不能移除自己或群主。')
      if (role === 'admin' && targetRole !== 'member') throw new GroupError(403, '管理员只能移除普通成员。')
      await removeMember(connection, group.id, userId)
    })
    response.json({ ok: true })
  })

  app.delete('/api/groups/:groupId/membership', requireAuth, async (request, response) => {
    await withGroup(request, null, async (connection, group, role) => {
      if (role === 'owner' || group.created_by === request.user.id) throw new GroupError(409, '请先转让群主，或解散群组。')
      await removeMember(connection, group.id, request.user.id)
    })
    response.json({ ok: true })
  })

  app.delete('/api/groups/:groupId', requireAuth, async (request, response) => {
    await withGroup(request, ['owner'], async (connection, group) => {
      await connection.execute(`DELETE r FROM qq_group_bind_requests r
        JOIN qq_group_links l ON l.group_openid = r.group_openid WHERE l.group_id = ?`, [group.id])
      await connection.execute('DELETE FROM ledger_groups WHERE id = ?', [group.id])
    })
    response.json({ ok: true })
  })
}
