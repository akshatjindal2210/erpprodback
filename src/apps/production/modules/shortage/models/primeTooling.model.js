/**
 * Tooling Yes/No after shortage approve — table prod_shortage (one row per prime item).
 */
import dbQuery from "../../../../../config/db/db.js";
import { PRODUCTION_TABLES as T } from "../../../../../config/db/dbTables.js";

export const toolingOf = (approved) => (approved === true ? "yes" : approved === false ? "no" : "pending");

/** prod_shortage rows for Tooling Pending (NULL) or Register (Yes/No decided). */
export async function listProdShortageTooling(register) {
  const where = register ? "approved IS NOT NULL" : "approved IS NULL";
  return dbQuery(`SELECT item_dcode, approved, remark FROM ${T.SHORTAGE} WHERE ${where} ORDER BY item_dcode`);
}

/** Register delete → back to Pending (approved + remark cleared, row kept). */
export async function resetToolingToPending(primeKey, user) {
  const [row] = await dbQuery(
    `UPDATE ${T.SHORTAGE}
     SET approved = NULL, remark = NULL, updated_by = $2, updated_at = NOW()
     WHERE item_dcode = $1 AND approved IS NOT NULL
     RETURNING item_dcode`,
    [Number(primeKey), user ?? null]
  );
  return row ?? null;
}

export async function attachTooling(groups = [], { withRemark = true } = {}) {
  const keys = [...new Set(groups.map((g) => Number(g.prime_key)).filter(Boolean))];
  const rows = keys.length
    ? await dbQuery(`SELECT item_dcode, approved, remark FROM ${T.SHORTAGE} WHERE item_dcode = ANY($1::int[])`, [keys])
    : [];
  const byItem = new Map(rows.map((r) => [Number(r.item_dcode), r]));

  for (const g of groups) {
    const row = byItem.get(Number(g.prime_key));
    const shortageApproved = g.status === "approved";
    g.tooling = shortageApproved ? toolingOf(row?.approved) : null;
    if (withRemark && shortageApproved) g.tooling_remark = row?.remark ?? null;
  }
  return groups;
}

export async function addPendingTooling(primeKey, user) {
  await dbQuery(
    `INSERT INTO ${T.SHORTAGE} (item_dcode, approved, created_by) VALUES ($1, NULL, $2)
     ON CONFLICT (item_dcode) DO NOTHING`,
    [Number(primeKey), user]
  );
}

export async function saveTooling({ primeKey, tooling, remark, user }) {
  await dbQuery(
    `INSERT INTO ${T.SHORTAGE} (item_dcode, approved, remark, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_dcode) DO UPDATE
       SET approved = EXCLUDED.approved, remark = EXCLUDED.remark, updated_by = $4, updated_at = NOW()`,
    [Number(primeKey), tooling, remark, user]
  );
}
