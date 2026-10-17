/**
 * Production → Tooling (Pending + Register).
 * Source of truth: prod_shortage (item_dcode = prime item dcode).
 *   approved NULL → Pending | true/false → Register (Yes/No)
 */
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { groupByPrimeItem, loadProductionShortages, primeStatusSql } from "../../shortage/utils/primeItemShortage.js";
import { listProdShortageTooling, resetToolingToPending, saveTooling, toolingOf } from "../../shortage/models/primeTooling.model.js";

const ENTITY = "production_tooling";
const MAX_REMARK = 500;

/** List row shape — keep small; add fields here when a screen needs them. */
function slimRow(g, extra = {}) {
  return {
    id: `tooling-${g.prime_key}`,
    prime_key: g.prime_key,
    prime_item_code: g.prime_item_code,
    prime_item_desc: g.prime_item_desc ?? null,
    total_qty: g.total_qty ?? 0,
    total_weight_kg: g.total_weight_kg ?? null,
    weight_missing: Boolean(g.weight_missing),
    ...extra,
  };
}

async function loadToolingList(surface) {
  const isRegister = surface === "register";
  const toolingRows = await listProdShortageTooling(isRegister);
  if (!toolingRows.length) return [];

  const groupMap = new Map(
    groupByPrimeItem(await loadProductionShortages([primeStatusSql("approved")])).map((g) => [Number(g.prime_key), g])
  );

  const out = [];
  for (const row of toolingRows) {
    const g = groupMap.get(Number(row.item_dcode));
    if (!g) continue;

    const tooling = toolingOf(row.approved);
    out.push(
      slimRow(g, {
        tooling: isRegister ? tooling : "pending",
        tooling_remark: isRegister ? row.remark ?? null : null,
      })
    );
  }

  out.sort((a, b) =>
    String(a.prime_item_code).localeCompare(String(b.prime_item_code), undefined, { numeric: true })
  );
  return out;
}

/** POST /tooling/list — body { surface: "pending" | "register" } */
export const getToolingList = async (req, res) => {
  try {
    const surface = String(req.body?.surface || "pending").trim().toLowerCase();
    const data = await loadToolingList(surface === "register" ? "register" : "pending");
    return res.json({ success: true, data, total: data.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Failed to load tooling queue." });
  }
};

/** POST /tooling/save — body { prime_key, tooling: true|false, remark } */
export const saveToolingDecision = async (req, res) => {
  try {
    const { prime_key, tooling, remark } = req.body || {};
    if (!prime_key || typeof tooling !== "boolean" || !String(remark || "").trim()) {
      return res.status(400).json({ success: false, message: "prime_key, tooling (true / false) and remark are required." });
    }

    const user = auditUserName(req);
    await saveTooling({ primeKey: prime_key, tooling, remark: String(remark).trim().slice(0, MAX_REMARK), user });

    await logActivity(req, {
      action: tooling ? "approve" : "reject",
      entity: ENTITY,
      entity_id: String(prime_key),
      appType: "production",
      record: { prime_key, tooling: tooling ? "yes" : "no", remark, by: user, at: new Date() },
      details: { prime_key, tooling: tooling ? "yes" : "no", remark },
    });

    return res.json({ success: true, message: `Tooling: ${tooling ? "Yes" : "No"}.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Action failed." });
  }
};

/** POST /tooling/delete — body { prime_key } — clears prod_shortage decision → Pending */
export const deleteToolingRegister = async (req, res) => {
  try {
    const prime_key = parsePositiveIntId(req.body?.prime_key ?? req.body?.id);
    if (!prime_key) {
      return res.status(400).json({ success: false, message: "prime_key is required." });
    }

    const user = auditUserName(req);
    const row = await resetToolingToPending(prime_key, user);
    if (!row) {
      return res.status(404).json({ success: false, message: "Register entry not found or already pending." });
    }

    await logActivity(req, {
      action: "delete",
      entity: ENTITY,
      entity_id: String(prime_key),
      appType: "production",
      record: { prime_key, by: user, at: new Date() },
      details: { prime_key, returned_to: "pending" },
    });

    return res.json({ success: true, message: "Tooling register entry removed. Item is pending again." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Delete failed." });
  }
};
