/**
 * Production → Shortage → Prime Item tab.
 * Approve / reject every shortage entry under the selected prime items.
 * Sets ims_shortage.is_approved (NULL pending / TRUE approved / FALSE rejected) + approval_remark; who / when → activity log.
 */
import { withTransaction } from "../../../../../config/db/db.js";
import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { PRIME_STATUSES, attachRmWireFromProduction, groupByPrimeItem, loadPrimeItemChildren, loadProductionShortages, primeKeyOf, primeStatusOf, primeStatusSql, slimPrimeGroup } from "../utils/primeItemShortage.js";
import { addPendingTooling } from "../models/primeTooling.model.js";

const ENTITY = "production_shortage";
const MAX_REMARK = 500;

function parsePrimeKeys(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((k) => canonicalCode(k)).filter(Boolean))];
}

/**
 * POST /shortage/prime-items/list — all statuses in ONE call; the screen filters Pending / Approved / Rejected itself.
 * Each prime item is grouped per status (a prime can have pending + approved entries at the same time),
 * so every returned row has `status` and a unique id like "pending-1234".
 */
export const getPrimeItems = async (req, res) => {
  try {
    const rows = await loadProductionShortages();

    const data = [];
    for (const status of PRIME_STATUSES) {
      const statusRows = rows.filter((r) => primeStatusOf(r) === status);
      for (const group of groupByPrimeItem(statusRows)) {
        data.push(slimPrimeGroup(group, { id: `${status}-${group.prime_key}`, status }));
      }
    }

    await attachRmWireFromProduction(data, { wireList: true });

    res.json({ success: true, data, total: data.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || "Failed to load prime items." });
  }
};

/** POST /shortage/prime-items/entries — body { prime_key, status? } — expand row only. */
export const getPrimeItemEntries = async (req, res) => {
  try {
    const primeKey = canonicalCode(req.body?.prime_key);
    if (!primeKey) return res.status(400).json({ success: false, message: "prime_key is required." });
    const status = String(req.body?.status || "").trim().toLowerCase();
    const data = await loadPrimeItemChildren(primeKey, PRIME_STATUSES.includes(status) ? status : null);
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load entries." });
  }
};

/**
 * Moves all shortage rows of the selected prime items from status `from` to `to`.
 * Only rows still in `from` are updated, so an already-actioned row is never overwritten.
 */
async function applyPrimeDecision(req, res, { from, to, action, verb, remarkRequired }) {
  try {
    const primeKeys = parsePrimeKeys(req.body?.prime_items);
    if (!primeKeys.length) {
      return res.status(400).json({ success: false, message: "Select at least one prime item." });
    }
    const remark = String(req.body?.remark ?? "").trim().slice(0, MAX_REMARK) || null;
    if (remarkRequired && !remark) {
      return res.status(400).json({ success: false, message: "Remark is required." });
    }

    // Prime mapping comes from the IMS item master, so children are resolved here, then locked by the UPDATE guard.
    const wanted = new Set(primeKeys);
    const rows = await loadProductionShortages([primeStatusSql(from)]);
    const ids = rows.filter((r) => wanted.has(primeKeyOf(r))).map((r) => r.id);
    if (!ids.length) {
      return res.status(400).json({
        success: false,
        message: `No ${from} shortage entries found for the selected prime items. Refresh and try again.`,
      });
    }

    const user = auditUserName(req) || "system";

    // Status + remark on the shortage row itself; who / when go to the activity log below.
    const updatedIds = await withTransaction(async (client) => {
      const out = await client.query(
        `UPDATE ${T.SHORTAGE}
         SET is_approved = $1, approval_remark = $2
         WHERE id = ANY($3::int[]) AND is_deleted = false AND ${primeStatusSql(from, "")}
         RETURNING id`,
        [to, remark, ids]
      );
      return (out.rows || []).map((r) => r.id);
    });

    const skipped = ids.length - updatedIds.length;

    // Shortage approved → each prime item goes to Tooling as pending
    if (to === true && updatedIds.length) {
      for (const key of primeKeys) await addPendingTooling(key, user);
    }

    await logActivity(req, {
      action,
      entity: ENTITY,
      entity_id: primeKeys.length === 1 ? primeKeys[0] : null,
      appType: "production",
      record: { prime_items: primeKeys, shortage_ids: updatedIds, is_approved: to, remark, by: user, at: new Date() },
      details: { prime_items: primeKeys, shortage_ids: updatedIds, is_approved: to, remark, skipped },
    });

    return res.json({
      success: true,
      message:
        `${updatedIds.length} shortage entr${updatedIds.length === 1 ? "y" : "ies"} ${verb}` +
        (skipped > 0 ? ` (${skipped} already actioned, skipped).` : "."),
      updated: updatedIds.length,
      skipped,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Action failed." });
  }
}

/** POST /shortage/prime-items/approve — body { prime_items: [], remark } (remark required) */
export const approvePrimeItems = (req, res) =>
  applyPrimeDecision(req, res, { from: "pending", to: true, action: "approve", verb: "approved", remarkRequired: true });

/** POST /shortage/prime-items/reject — body { prime_items: [], remark } (remark required) */
export const rejectPrimeItems = (req, res) =>
  applyPrimeDecision(req, res, { from: "pending", to: false, action: "reject", verb: "rejected", remarkRequired: true });

/** POST /shortage/prime-items/reset — rejected → pending again. body { prime_items: [], remark } (remark optional) */
export const resetPrimeItems = (req, res) =>
  applyPrimeDecision(req, res, { from: "rejected", to: null, action: "update", verb: "moved back to pending", remarkRequired: false });
