/**

 * Production → Shortage → Prime Item (Accept / Reject → Maintain Job Card stub via docno).

 */

import { withTransaction } from "../../../../../config/db/db.js";

import { IMS_TABLES as T } from "../../../../../config/db/dbTables.js";

import { auditUserName } from "../../../../core/lib/utils/auth/approval.js";

import { logActivity } from "../../../../core/lib/utils/activity/logActivity.js";

import { canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";

import {

  PRIME_STATUSES, attachRmWireFromProduction, groupByPrimeItem, loadPrimeItemChildren,

  loadProductionShortages, primeKeyOf, primeStatusOf, primeStatusSql, slimPrimeGroup,

} from "../utils/primeItemShortage.js";

import { applyShortageDecisionToJobCards } from "../../job-card/models/jobCard.model.js";



const ENTITY = "production_shortage";

const MAX_REMARK = 500;

const NO_ROWS = (from) => `No ${from} shortage entries found for the selected prime items. Refresh and try again.`;



function parsePrimeKeys(raw) {

  if (!Array.isArray(raw)) return [];

  return [...new Set(raw.map((k) => canonicalCode(k)).filter(Boolean))];

}



function shortageIdsByPrime(rows, onlyIds = null) {

  const allow = onlyIds ? new Set(onlyIds) : null;

  const m = new Map();

  for (const r of rows) {

    if (allow && !allow.has(r.id)) continue;

    const k = Number(primeKeyOf(r));

    if (!m.has(k)) m.set(k, []);

    m.get(k).push(r.id);

  }

  return m;

}



export const getPrimeItems = async (req, res) => {

  try {

    const rows = await loadProductionShortages();

    const data = [];

    for (const status of PRIME_STATUSES) {

      for (const group of groupByPrimeItem(rows.filter((r) => primeStatusOf(r) === status))) {

        data.push(slimPrimeGroup(group, { id: `${status}-${group.prime_key}`, status }));

      }

    }

    await attachRmWireFromProduction(data, { wireList: true });

    res.json({ success: true, data, total: data.length });

  } catch (err) {

    res.status(500).json({ success: false, message: err.message || "Failed to load prime items." });

  }

};



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



async function applyPrimeDecision(req, res, { from, to, action, verb, remarkRequired }) {

  try {

    const primeKeys = parsePrimeKeys(req.body?.prime_items);

    if (!primeKeys.length) return res.status(400).json({ success: false, message: "Select at least one prime item." });



    const remark = String(req.body?.remark ?? "").trim().slice(0, MAX_REMARK) || null;

    if (remarkRequired && !remark) return res.status(400).json({ success: false, message: "Remark is required." });



    const wanted = new Set(primeKeys.map((k) => String(canonicalCode(k) || k)));

    const matchPrime = (r) => wanted.has(String(primeKeyOf(r) || ""));

    const rows = await loadProductionShortages([primeStatusSql(from)]);

    let ids = rows.filter(matchPrime).map((r) => r.id);

    const user = auditUserName(req) || "system";



    if (!ids.length && to === true && from === "pending") {

      const accepted = (await loadProductionShortages([primeStatusSql("accepted")])).filter(matchPrime);

      if (!accepted.length) return res.status(400).json({ success: false, message: NO_ROWS(from) });

      await applyShortageDecisionToJobCards({

        primeKeys, approved: true, user, shortageIdsByPrime: shortageIdsByPrime(accepted),

      });

      return res.json({

        success: true,

        message: "Shortage already accepted — maintain job card entry synced.",

        updated: 0,

        skipped: accepted.length,

      });

    }

    if (!ids.length) return res.status(400).json({ success: false, message: NO_ROWS(from) });



    const updatedIds = await withTransaction(async (client) => {

      const out = await client.query(

        `UPDATE ${T.SHORTAGE} SET is_accepted = $1, accepted_remark = $2

         WHERE id = ANY($3::int[]) AND is_deleted = false AND ${primeStatusSql(from, "")}

         RETURNING id`,

        [to, remark, ids]

      );

      return (out.rows || []).map((r) => r.id);

    });



    const skipped = ids.length - updatedIds.length;

    if (updatedIds.length) {

      await applyShortageDecisionToJobCards({

        primeKeys, approved: to, user, shortageIdsByPrime: shortageIdsByPrime(rows, updatedIds),

      });

    }



    await logActivity(req, {

      action, entity: ENTITY, entity_id: primeKeys.length === 1 ? primeKeys[0] : null, appType: "production",

      record: { prime_items: primeKeys, shortage_ids: updatedIds, is_accepted: to, remark, by: user, at: new Date() },

      details: { prime_items: primeKeys, shortage_ids: updatedIds, is_accepted: to, remark, skipped },

    });



    return res.json({

      success: true,

      message: `${updatedIds.length} shortage entr${updatedIds.length === 1 ? "y" : "ies"} ${verb}`

        + (skipped > 0 ? ` (${skipped} already actioned, skipped).` : "."),

      updated: updatedIds.length,

      skipped,

    });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message || "Action failed." });

  }

}



export const approvePrimeItems = (req, res) =>

  applyPrimeDecision(req, res, { from: "pending", to: true, action: "approve", verb: "accepted", remarkRequired: false });



export const rejectPrimeItems = (req, res) =>

  applyPrimeDecision(req, res, { from: "pending", to: false, action: "reject", verb: "rejected", remarkRequired: false });



export const resetPrimeItems = (req, res) =>

  applyPrimeDecision(req, res, { from: "rejected", to: null, action: "update", verb: "moved back to pending", remarkRequired: false });

