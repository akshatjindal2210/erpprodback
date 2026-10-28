/**
 * Tooling Yes/No after shortage approve — stored on prod_job_card
 * (tooling_approved NULL = pending; true/false = register Yes/No).
 */
import { listJobCardsForTooling, resetJobCardToolingToPending, saveJobCardTooling } from "../../jc/models/jobCard.model.js";

export const toolingOf = (approved) => (approved === true ? "yes" : approved === false ? "no" : "pending");

/** Job cards for Tooling Pending (NULL) or Register (Yes/No decided). */
export async function listProdShortageTooling(register) {
  return listJobCardsForTooling(register);
}

/** Register delete → back to Pending (tooling cleared, card kept). */
export async function resetToolingToPending(primeKey, user) {
  const row = await resetJobCardToolingToPending({ primeKey, user });
  return row ? { item_dcode: Number(row.itemdcode) } : null;
}

/** @deprecated — tooling now rides on the job card; kept as no-op for any leftover callers. */
export async function addPendingTooling(_primeKey, _user) {
  // Shortage approval is joined from ims_shortage; tooling stays NULL (pending) on the job card.
}

export async function saveTooling({ primeKey, tooling, remark, user }) {
  return saveJobCardTooling({ primeKey, tooling, remark, user });
}

/** Attach tooling status onto prime-item list groups (from job cards). */
export async function attachTooling(groups = [], { withRemark = true } = {}) {
  if (!groups.length) return groups;
  const keys = [...new Set(groups.map((g) => Number(g.prime_key)).filter(Boolean))];
  if (!keys.length) return groups;

  const { default: dbQuery } = await import("../../../../../config/db/db.js");
  const { PRODUCTION_TABLES: T } = await import("../../../../../config/db/dbTables.js");
  const rows = await dbQuery(
    `SELECT DISTINCT ON (itemdcode)
        itemdcode AS prime_item_dcode, tooling_approved AS approved, tooling_remark AS remark,
        tooling_by, tooling_at
     FROM ${T.JC}
     WHERE is_deleted = false AND itemdcode = ANY($1::int[])
     ORDER BY itemdcode, docno DESC`,
    [keys]
  );
  const byItem = new Map(rows.map((r) => [Number(r.prime_item_dcode), r]));

  for (const g of groups) {
    const row = byItem.get(Number(g.prime_key));
    const shortageApproved = g.status === "accepted";
    g.tooling = shortageApproved ? toolingOf(row?.approved) : null;
    if (withRemark && shortageApproved) {
      g.tooling_remark = row?.remark ?? null;
      g.tooling_by = row?.tooling_by ?? null;
      g.tooling_by_name = row?.tooling_by ?? null;
      g.tooling_at = row?.tooling_at ?? null;
    }
  }
  return groups;
}
