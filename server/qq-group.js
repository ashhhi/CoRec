import { createHash, randomBytes } from 'node:crypto'

export const groupCodePattern = /^[A-F0-9]{16}$/
export const qqOpenidPattern = /^[A-Za-z0-9_-]{1,128}$/
const newCode = () => randomBytes(8).toString('hex').toUpperCase()
const codeHash = (code) => createHash('sha256').update(code).digest('hex')

export async function ensureQqGroupSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_group_links (
    group_id INT UNSIGNED PRIMARY KEY,
    group_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_group_members (
    group_id INT UNSIGNED NOT NULL,
    member_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    state JSON NULL,
    state_updated_at DATETIME NULL,
    PRIMARY KEY (group_id, member_openid), UNIQUE KEY qq_group_member_account_idx (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES qq_group_links(group_id) ON DELETE CASCADE,
    FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_group_bind_requests (
    request_hash CHAR(64) PRIMARY KEY,
    group_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    member_openid VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX qq_group_request_expiry_idx (expires_at), INDEX qq_group_request_chat_idx (group_openid, member_openid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS qq_group_bind_claims (
    confirm_hash CHAR(64) PRIMARY KEY, request_hash CHAR(64) NOT NULL,
    group_id INT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL,
    UNIQUE KEY qq_group_claim_account_idx (request_hash, group_id, user_id),
    FOREIGN KEY (request_hash) REFERENCES qq_group_bind_requests(request_hash) ON DELETE CASCADE,
    FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`)
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

async function lockLedger(connection, groupId) {
  await connection.execute('SELECT id FROM ledger_groups WHERE id = ? FOR UPDATE', [groupId])
}

export async function requestGroupBinding(pool, groupOpenid, memberOpenid) {
  const code = newCode()
  await transaction(pool, async (connection) => {
    await connection.execute('DELETE FROM qq_group_bind_requests WHERE group_openid = ? AND member_openid = ?', [groupOpenid, memberOpenid])
    await connection.execute(`INSERT INTO qq_group_bind_requests (request_hash, group_openid, member_openid, expires_at)
      VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 MINUTE))`, [codeHash(code), groupOpenid, memberOpenid])
  })
  return code
}

async function checkGroupBinding(connection, groupId, userId, request) {
  const [[member]] = await connection.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? FOR UPDATE', [groupId, userId])
  if (!member) return '请先加入该 CoRec 群组。'

  const [[ledgerLink]] = await connection.execute('SELECT group_openid FROM qq_group_links WHERE group_id = ?', [groupId])
  if (ledgerLink && ledgerLink.group_openid !== request.group_openid) return '这个账本已绑定另一个 QQ 群。'
  const [[qqLink]] = await connection.execute('SELECT group_id FROM qq_group_links WHERE group_openid = ?', [request.group_openid])
  if (qqLink && qqLink.group_id !== groupId) return '这个 QQ 群已绑定另一个账本。'
  if (!qqLink && member.role !== 'owner') return '请先由该 CoRec 群组的创建者绑定 QQ 群。'

  const [identities] = await connection.execute(`SELECT member_openid, user_id FROM qq_group_members
    WHERE group_id = ? AND (member_openid = ? OR user_id = ?)`, [groupId, request.member_openid, userId])
  if (identities.some((identity) => identity.user_id !== userId || identity.member_openid !== request.member_openid)) {
    return 'QQ 群身份或 CoRec 账号已绑定，请先解除原绑定。'
  }
  return null
}

export async function claimGroupBinding(pool, groupId, userId, requestCode) {
  return transaction(pool, async (connection) => {
    await lockLedger(connection, groupId)
    const requestHash = codeHash(requestCode)
    const [[request]] = await connection.execute(`SELECT group_openid, member_openid FROM qq_group_bind_requests
      WHERE request_hash = ? AND expires_at > UTC_TIMESTAMP() FOR UPDATE`, [requestHash])
    if (!request) return { error: '请求码无效或已过期，请在 QQ 群里重新发送“绑定”。' }
    const error = await checkGroupBinding(connection, groupId, userId, request)
    if (error) return { error }

    const code = newCode()
    await connection.execute('DELETE FROM qq_group_bind_claims WHERE request_hash = ? AND group_id = ? AND user_id = ?', [requestHash, groupId, userId])
    await connection.execute(`INSERT INTO qq_group_bind_claims (confirm_hash, request_hash, group_id, user_id)
      VALUES (?, ?, ?, ?)`, [codeHash(code), requestHash, groupId, userId])
    return { code }
  })
}

export async function confirmGroupBinding(pool, groupOpenid, memberOpenid, code) {
  const confirmHash = codeHash(code)
  const [[claim]] = await pool.execute('SELECT group_id FROM qq_group_bind_claims WHERE confirm_hash = ?', [confirmHash])
  if (!claim) return false

  try {
    return await transaction(pool, async (connection) => {
      await lockLedger(connection, claim.group_id)
      const [[request]] = await connection.execute(`SELECT r.request_hash, r.group_openid, r.member_openid, c.group_id, c.user_id
        FROM qq_group_bind_claims c JOIN qq_group_bind_requests r ON r.request_hash = c.request_hash
        WHERE c.confirm_hash = ? AND r.group_openid = ? AND r.member_openid = ? AND r.expires_at > UTC_TIMESTAMP() FOR UPDATE`,
      [confirmHash, groupOpenid, memberOpenid])
      if (!request || await checkGroupBinding(connection, request.group_id, request.user_id, request)) return false

      const [[link]] = await connection.execute('SELECT group_id FROM qq_group_links WHERE group_id = ?', [request.group_id])
      if (!link) await connection.execute('INSERT INTO qq_group_links (group_id, group_openid) VALUES (?, ?)', [request.group_id, groupOpenid])

      const [[identity]] = await connection.execute('SELECT user_id FROM qq_group_members WHERE group_id = ? AND member_openid = ?', [request.group_id, memberOpenid])
      if (!identity) await connection.execute('INSERT INTO qq_group_members (group_id, member_openid, user_id) VALUES (?, ?, ?)', [request.group_id, memberOpenid, request.user_id])
      await connection.execute('DELETE FROM qq_group_bind_requests WHERE request_hash = ?', [request.request_hash])
      return true
    })
  } catch (error) {
    if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes(error.code)) return false
    throw error
  }
}

export async function getGroupBinding(pool, groupOpenid, memberOpenid) {
  const [[binding]] = await pool.execute(`SELECT b.group_id, b.user_id
    FROM qq_group_links l JOIN qq_group_members b ON b.group_id = l.group_id
    JOIN group_members gm ON gm.group_id = b.group_id AND gm.user_id = b.user_id
    WHERE l.group_openid = ? AND b.member_openid = ?`, [groupOpenid, memberOpenid])
  return binding
}

export async function getGroupBindingStatus(pool, groupId, userId) {
  const [[row]] = await pool.execute(`SELECT l.group_id, b.user_id
    FROM qq_group_links l LEFT JOIN qq_group_members b ON b.group_id = l.group_id AND b.user_id = ?
    WHERE l.group_id = ?`, [userId, groupId])
  return { linked: Boolean(row), memberBound: Boolean(row?.user_id) }
}

export async function removeGroupBinding(pool, groupId, userId, unlinkGroup) {
  return transaction(pool, async (connection) => {
    await lockLedger(connection, groupId)
    const [[member]] = await connection.execute('SELECT role FROM group_members WHERE group_id = ? AND user_id = ? FOR UPDATE', [groupId, userId])
    if (!member || (unlinkGroup && member.role !== 'owner')) return false

    if (unlinkGroup) {
      const [[link]] = await connection.execute('SELECT group_openid FROM qq_group_links WHERE group_id = ?', [groupId])
      if (link) await connection.execute('DELETE FROM qq_group_bind_requests WHERE group_openid = ?', [link.group_openid])
      await connection.execute('DELETE FROM qq_group_links WHERE group_id = ?', [groupId])
      await connection.execute('DELETE FROM qq_group_bind_claims WHERE group_id = ?', [groupId])
    } else {
      await connection.execute('DELETE FROM qq_group_members WHERE group_id = ? AND user_id = ?', [groupId, userId])
      await connection.execute('DELETE FROM qq_group_bind_claims WHERE group_id = ? AND user_id = ?', [groupId, userId])
    }
    return true
  })
}
