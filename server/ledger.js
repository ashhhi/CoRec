export async function getAccountBalances(connection, groupId) {
  const [[row]] = await connection.execute(`SELECT
    COALESCE(SUM(CASE WHEN entry_type='income' THEN CAST(amount_cents AS SIGNED) - CAST(income_savings_cents AS SIGNED)
      WHEN entry_type='expense' THEN -CAST(amount_cents AS SIGNED)
      WHEN entry_type='transfer' AND transfer_direction='to_savings' THEN -CAST(amount_cents AS SIGNED)
      WHEN entry_type='transfer' AND transfer_direction='from_savings' THEN CAST(amount_cents AS SIGNED)
      ELSE 0 END),0) AS activity_cents,
    COALESCE(SUM(CASE WHEN entry_type='income' THEN CAST(income_savings_cents AS SIGNED)
      WHEN entry_type='transfer' AND transfer_direction='to_savings' THEN CAST(amount_cents AS SIGNED)
      WHEN entry_type='transfer' AND transfer_direction='from_savings' THEN -CAST(amount_cents AS SIGNED)
      ELSE 0 END),0) AS savings_cents
    FROM expenses WHERE group_id=?`, [groupId])
  return { activityCents: Number(row.activity_cents), savingsCents: Number(row.savings_cents) }
}
