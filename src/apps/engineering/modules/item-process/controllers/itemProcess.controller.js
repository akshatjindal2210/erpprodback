import {
  PROCESS_TYPE, PROCESS_TYPE_KEY, findPlans, loadStages, findPrimeIdsByItems,
  savePrime, deletePrime, saveFg, deleteFg, setPlanApproval,
} from "../models/itemProcess.model.js";
import { rmItemMap, labelStageRm } from "../../../../rmstore/modules/production/utils/erpItems.js";
import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as R } from "../../../../../config/db/dbTables.js";
import { getImsMapsSafe, canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";
import { extractListParams } from "../../../../core/lib/utils/query/queryHelper.js";
import { auditUserName, normalizeApprovedInput } from "../../../../core/lib/utils/auth/approval.js";

/**
 * Prime / Finish Process Master — saved in eng_item_process only (item names from IMS). Item RM is only read for default RM.
 * Row sent to the UI (same shape for both types):
 *   { id, type: "prime" | "fg", item_dcode, item_code, item_desc,
 *     prime_item_code, prime_item_desc,   ← FG: its prime item, live from IMS (not stored)
 *     rm_items,                    ← prime item's RM from Item RM (production), DB order — pre-selected on RM wire processes
 *     process,                     ← DB JSON as stored
 *     prime_process, fg_process,   ← { id, stages (names live), created_by, ... } for the forms
 *     created_by_name, created_at, updated_by_name, updated_at }
 */

/**
 * Prime item → its Item RM (rmstore_master_production) RM list, in the stored order (serial = priority).
 * Read only, for the form's default RM — nothing is linked or written there.
 */
async function primeItemRm(primeItems, rmMap) {
  const dcodes = [...new Set(primeItems.map(Number).filter(Boolean))];
  if (!dcodes.length) return new Map();
  const rows = await dbQuery(
    `SELECT item_dcode, rm_items FROM ${R.MASTER_PRODUCTION} WHERE item_dcode = ANY($1::int[]) AND is_deleted = false`,
    [dcodes]
  );
  return new Map(
    rows.map((r) => [
      Number(r.item_dcode),
      (Array.isArray(r.rm_items) ? r.rm_items : []).map((rm) => {
        const live = rmMap.get(canonicalCode(rm.rm_item_dcode));
        return {
          rm_item_dcode: Number(rm.rm_item_dcode),
          rm_item_code: live?.item_code || rm.rm_item_code || `RM ${rm.rm_item_dcode}`,
          rm_item_desc: live?.item_desc ?? rm.rm_item_desc ?? null,
        };
      }),
    ])
  );
}

const send = (res, err) => res.status(err.statusCode || 500).json({ success: false, message: err.message });

async function toViews(rows, type) {
  if (!rows.length) return [];
  const [{ itemMap }, rmMap] = await Promise.all([getImsMapsSafe(), rmItemMap()]);
  const item = (dcode) => itemMap.get(canonicalCode(dcode)) || {};
  // Prime → itself; FG → its prime item, live from IMS (primitemdcode, else itself)
  const primeItems = rows.map((r) =>
    type === PROCESS_TYPE.PRIME ? Number(r.item_dcode) : Number(item(r.item_dcode).primitemdcode) || Number(r.item_dcode)
  );
  const [primeIdByItem, rmByItem] = await Promise.all([
    findPrimeIdsByItems(primeItems, { approvedOnly: false }),
    primeItemRm(primeItems, rmMap),
  ]);
  const primeIdOf = (r, i) => (type === PROCESS_TYPE.PRIME ? r.id : primeIdByItem.get(primeItems[i])) || null;
  const stageMap = await loadStages(rows.flatMap((r, i) => [r.id, primeIdOf(r, i)]));
  const plan = async (id) => {
    const p = id && stageMap.get(Number(id));
    return p?.stages.length ? { id: Number(id), ...p, stages: await labelStageRm(p.stages, rmMap) } : null;
  };

  return Promise.all(
    rows.map(async (r, i) => {
      const primeItem = primeItems[i];
      const primeId = primeIdOf(r, i);
      return {
        id: r.id ? Number(r.id) : null,
        type: PROCESS_TYPE_KEY[type],
        item_dcode: Number(r.item_dcode),
        item_code: item(r.item_dcode).item_code || null,
        item_desc: item(r.item_dcode).item_desc || null,
        prime_item_code: item(primeItem).item_code || null,
        prime_item_desc: item(primeItem).item_desc || null,
        rm_items: rmByItem.get(primeItem) || [],
        process: r.process || null,
        prime_process: await plan(primeId),
        fg_process: type === PROCESS_TYPE.FG && r.id ? await plan(r.id) : null,
        is_approved: r.is_approved === true,
        approved_by_name: r.approved_by || null,
        approved_at: r.approved_at || null,
        created_by_name: r.created_by || null,
        created_at: r.created_at || null,
        updated_by_name: r.updated_by || null,
        updated_at: r.updated_at || null,
      };
    })
  );
}

/** One controller set per type — Prime and Finish Process Master routes. */
function itemProcessController(type) {
  const isPrime = type === PROCESS_TYPE.PRIME;
  const entity = isPrime ? "eng_prime_item_master" : "eng_finish_process_master";
  const label = isPrime ? "Prime process" : "Finish process";
  const log = (req, action, entity_id, details, record = null) =>
    logActivity(req, { action, entity, entity_id: String(entity_id), details, record }).catch(() => {});

  const list = async (req, res) => {
    try {
      const params = extractListParams(req.body || {});
      const page = Math.max(1, Number(params.page) || 1);
      const limit = Math.max(1, Number(params.limit) || 100);
      const data = await toViews(await findPlans({ type }), type);
      const start = (page - 1) * limit;
      return res.json({ success: true, data: data.slice(start, start + limit), total: data.length, page, limit });
    } catch (err) {
      return send(res, err);
    }
  };

  /**
   * `{ id }` → that row. `{ item_dcode }` → the item's row (form picked an item).
   * Item without a row yet → draft (id null) with its prime item's RM (+ for FG its prime, for the locked Prime block).
   */
  const get = async (req, res) => {
    try {
      const { id, item_dcode } = req.body || {};
      if (!id && !item_dcode) return res.status(400).json({ success: false, message: "id or item_dcode is required." });
      let [row] = await findPlans(id ? { type, id } : { type, item_dcode });
      if (!row && id) return res.status(404).json({ success: false, message: `${label} not found.` });
      if (!row) row = { id: null, item_dcode: Number(item_dcode), process: null };
      const [data] = await toViews([row], type);
      return res.json({ success: true, data });
    } catch (err) {
      return send(res, err);
    }
  };

  /** Create + update — one active row per (type, item). Body `{ item_dcode, process: { stages } }`. */
  const save = async (req, res) => {
    try {
      const { item_dcode } = req.body || {};
      const processJson = req.body?.process;
      if (!Array.isArray(processJson?.stages) || !processJson.stages.length) {
        return res.status(400).json({ success: false, message: "Add at least one stage." });
      }
      const input = { item_dcode, processJson, user: auditUserName(req) };
      const out = isPrime ? await savePrime(input) : await saveFg(input);
      const [row] = await findPlans({ type, id: out.id });
      log(req, out.created ? "create" : "update", out.id, { item_dcode: row.item_dcode, process: row.process }, row);
      const [data] = await toViews([row], type);
      return res.json({
        success: true,
        data,
        toast_type: "success",
        message: `${label} ${out.created ? "saved" : "updated"}.`,
      });
    } catch (err) {
      return send(res, err);
    }
  };

  const remove = async (req, res) => {
    try {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ success: false, message: "id is required." });
      const [existing] = await findPlans({ type, id });
      const user = auditUserName(req);
      await (isPrime ? deletePrime({ id, user }) : deleteFg({ id, user }));
      log(req, "delete", id, { item_dcode: existing?.item_dcode ?? null }, existing);
      return res.json({ success: true, toast_type: "success", message: `${label} deleted.` });
    } catch (err) {
      return send(res, err);
    }
  };

  /** POST /approve — body { id, approved?: true | false } (default approve). */
  const approve = async (req, res) => {
    try {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ success: false, message: "id is required." });
      const approved = normalizeApprovedInput(req.body?.approved);
      if (approved !== true && approved !== false) {
        return res.status(400).json({ success: false, message: "approved must be true or false." });
      }
      const user = auditUserName(req) || "system";
      await setPlanApproval({ type, id, approved, user });
      const [row] = await findPlans({ type, id });
      log(req, approved ? "approve" : "update", id, { is_approved: approved, item_dcode: row?.item_dcode ?? null }, row);
      const [data] = await toViews([row], type);
      return res.json({
        success: true,
        data,
        toast_type: "success",
        message: approved ? `${label} approved.` : `${label} approval revoked — status is Pending.`,
      });
    } catch (err) {
      return send(res, err);
    }
  };

  return { list, get, save, remove, approve };
}

export const primeProcess = itemProcessController(PROCESS_TYPE.PRIME);
export const fgProcess = itemProcessController(PROCESS_TYPE.FG);
