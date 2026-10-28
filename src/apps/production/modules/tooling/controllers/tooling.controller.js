/**
 * Production → Tooling (Pending + Register).
 * Source of truth: prod_job_card.tooling_approved (per prime, latest card).
 *   Pending: tooling_approved IS NULL | Register: true/false (+ remark, by, at)
 */
import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { parsePositiveIntId } from "../../../../core/lib/utils/query/parseId.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { issueQtyKg } from "../../jc/jobCard.config.js";
import { loadQtyItemsByShortageIds } from "../../jc/models/jobCard.model.js";
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

function primeGweight(itemMap, itemdcode) {
  const w = itemMap.get(canonicalCode(itemdcode))?.gweight;
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function loadToolingList(surface) {
  const isRegister = surface === "register";
  const toolingRows = await listProdShortageTooling(isRegister);
  if (!toolingRows.length) return [];

  const { itemMap } = await getImsMapsSafe();
  const cards = toolingRows.map((r) => ({
    docno: r.docno,
    itemdcode: r.item_dcode,
  }));
  const qtyByDoc = await loadQtyItemsByShortageIds(cards);

  const out = [];
  for (const row of toolingRows) {
    const primeKey = Number(row.item_dcode);
    const info = itemMap.get(canonicalCode(primeKey)) || {};
    const { qty = 0 } = qtyByDoc.get(row.docno) || {};
    const gweight = primeGweight(itemMap, primeKey);
    const total_weight_kg = issueQtyKg(gweight, qty);
    const tooling = toolingOf(row.approved);

    out.push(
      slimRow(
        {
          prime_key: primeKey,
          prime_item_code: info.item_code || String(primeKey),
          prime_item_desc: info.item_desc ?? null,
          total_qty: qty,
          total_weight_kg,
          weight_missing: total_weight_kg == null,
        },
        {
          tooling: isRegister ? tooling : "pending",
          tooling_remark: isRegister ? row.remark ?? null : null,
          tooling_by: isRegister ? row.tooling_by ?? null : null,
          tooling_by_name: isRegister ? row.tooling_by ?? null : null,
          tooling_at: isRegister ? row.tooling_at ?? null : null,
        }
      )
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

/** POST /tooling/save — body { prime_key, tooling: true|false, remark? } — remark optional */
export const saveToolingDecision = async (req, res) => {
  try {
    const { prime_key, tooling, remark } = req.body || {};
    if (!prime_key || typeof tooling !== "boolean") {
      return res.status(400).json({ success: false, message: "prime_key and tooling (true / false) are required." });
    }

    const remarkText = String(remark || "").trim().slice(0, MAX_REMARK) || null;
    const user = auditUserName(req);
    const saved = await saveTooling({ primeKey: prime_key, tooling, remark: remarkText, user });
    if (!saved) {
      return res.status(404).json({
        success: false,
        message: "No shortage-approved job card found for this prime item. Approve shortage first.",
      });
    }

    await logActivity(req, {
      action: tooling ? "approve" : "reject",
      entity: ENTITY,
      entity_id: String(prime_key),
      appType: "production",
      record: { prime_key, tooling: tooling ? "yes" : "no", remark: remarkText, by: user, at: new Date() },
      details: { prime_key, tooling: tooling ? "yes" : "no", remark: remarkText },
    });

    return res.json({ success: true, message: `Tooling: ${tooling ? "Yes" : "No"}.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || "Action failed." });
  }
};

/** POST /tooling/delete — body { prime_key } — clears tooling decision on job card → Pending */
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
