import { findCoils } from "../../../coil/models/coil.model.js";
import { isCoilEligibleForIssueRequest } from "../../../../lib/utils/coilQcEligibility.js";
import { findReservedCoilsFromRequests, findIssuedQtyByJobCards } from "../../models/issueRequest.model.js";
import { findOutDraftReservedCoilUids } from "../../../out-entry/models/outEntry.model.js";

/** Unassigned / coil-area — IMS "loose" analogue. */
function isUnassignedCoil(c) {
  return c?.location_id == null || String(c?.location_no || "").toLowerCase() === "unassigned";
}

/** Packing # analogue: prefer mrn_uid, fall back to mrn_no. */
function mrnGroupKey(c) {
  const uid = String(c?.mrn_uid || "").trim();
  if (uid) return uid;
  const no = c?.mrn_no;
  if (no != null && String(no).trim() !== "") return `no:${String(no).trim()}`;
  return "N/A";
}

/**
 * Same FIFO order as Issue Request modal (IMS packing style):
 * mrn_uid/mrn_no → stored before unassigned → created_at → coil_uid.
 */
export function sortCoilsFifo(coils = []) {
  return [...(coils || [])].sort((a, b) => {
    const keyA = mrnGroupKey(a);
    const keyB = mrnGroupKey(b);
    const rawNoA = a?.mrn_no != null && String(a.mrn_no).trim() !== "" ? Number(a.mrn_no) : NaN;
    const rawNoB = b?.mrn_no != null && String(b.mrn_no).trim() !== "" ? Number(b.mrn_no) : NaN;
    if (Number.isFinite(rawNoA) && Number.isFinite(rawNoB) && rawNoA !== rawNoB) return rawNoA - rawNoB;
    if (keyA !== keyB) return keyA.localeCompare(keyB, undefined, { numeric: true });

    const looseA = isUnassignedCoil(a) ? 1 : 0;
    const looseB = isUnassignedCoil(b) ? 1 : 0;
    if (looseA !== looseB) return looseA - looseB;

    const ta = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b?.created_at ? new Date(b.created_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a?.coil_uid || 0) - Number(b?.coil_uid || 0);
  });
}

/**
 * Whole-coil FIFO to cover targetQty (may overshoot, e.g. 751 → 800).
 * Typed dispatch is capped at required RM separately — not here.
 */
export function pickCoilsFifo(pool, targetQty, excludeUids = new Set()) {
  const exclude = new Set([...excludeUids].map((u) => String(u).toLowerCase()));
  const sorted = sortCoilsFifo(pool || []).filter(
    (c) => c?.coil_no_uid && !exclude.has(String(c.coil_no_uid).toLowerCase())
  );

  const storeQty = sorted.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const target = Number(targetQty);
  if (!(target > 0)) {
    return { picked: [], pickedQty: 0, storeQty, available: sorted };
  }

  const picked = [];
  let pickedQty = 0;
  for (const c of sorted) {
    if (pickedQty >= target) break;
    picked.push(c);
    pickedQty += Number(c.qty) || 0;
  }
  return { picked, pickedQty, storeQty, available: sorted };
}

/** First N coils in FIFO order. */
export function pickCoilsByCount(pool, count, excludeUids = new Set()) {
  const { available, storeQty } = pickCoilsFifo(pool, 0, excludeUids);
  const n = Math.max(0, Math.min(Number(count) || 0, available.length));
  const picked = available.slice(0, n);
  const pickedQty = picked.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  return { picked, pickedQty, storeQty, available };
}

async function fetchAllCoils(filters) {
  const limit = 500;
  let page = 1;
  const all = [];
  for (;;) {
    const result = await findCoils({
      filters: { status: "active", ...filters },
      page,
      limit,
      sortBy: "created_at",
      order: "ASC",
    });
    const batch = result?.data || [];
    all.push(...batch);
    if (batch.length < limit || all.length >= (result?.total || 0)) break;
    page += 1;
    if (page > 20) break;
  }
  return all;
}

/** Active RM coils = store-in + coil area (same pool as the modal). */
export async function fetchActiveRmCoils({ rm_item_code, rm_item_dcode } = {}) {
  const code = String(rm_item_code || "").trim();
  const dcode = Number(rm_item_dcode);
  const itemFilter =
    Number.isFinite(dcode) && dcode > 0 ? { item_dcode: dcode } : code ? { item_code: code } : null;
  if (!itemFilter) return [];

  let [stored, unassigned] = await Promise.all([
    fetchAllCoils({ stored: true, ...itemFilter }),
    fetchAllCoils({ coil_area: true, ...itemFilter }),
  ]);

  if (!stored.length && !unassigned.length && code && Number.isFinite(dcode) && dcode > 0) {
    [stored, unassigned] = await Promise.all([
      fetchAllCoils({ stored: true, item_code: code }),
      fetchAllCoils({ coil_area: true, item_code: code }),
    ]);
  }

  const byUid = new Map();
  for (const c of [...stored, ...unassigned]) {
    const key = String(c?.coil_no_uid || "").toLowerCase();
    if (!key) continue;
    if (!byUid.has(key)) byUid.set(key, c);
  }
  return sortCoilsFifo([...byUid.values()]);
}

function reservedMaps(rows = []) {
  const byUid = new Map();
  for (const row of rows) {
    const uid = String(row?.coil_no_uid || "").trim().toLowerCase();
    if (!uid) continue;
    byUid.set(uid, row);
  }
  return byUid;
}

function poolCacheKey(rm_item_code, rm_item_dcode) {
  const dcode = Number(rm_item_dcode);
  if (Number.isFinite(dcode) && dcode > 0) return `d:${dcode}`;
  return `c:${String(rm_item_code || "").trim().toUpperCase()}`;
}

/**
 * Serialize reserve attempts for the same coil UIDs (one DB round-trip).
 */
export async function lockCoilUidsForReserve(client, coilUids = []) {
  if (!client?.query) return;
  const keys = [
    ...new Set(
      (coilUids || [])
        .map((u) => String(u || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
  if (!keys.length) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('rm-ir-coil:' || k))
     FROM unnest($1::text[]) AS k`,
    [keys]
  );
}

export async function buildAvailableCoilsForIssue({
  rm_item_code,
  rm_item_dcode,
  excludeIssueUid = null,
  client = null,
  reservedByUid = null,
  outDraftUids = null,
} = {}) {
  const physicalAll = await fetchActiveRmCoils({ rm_item_code, rm_item_dcode });
  const physical = physicalAll.filter(isCoilEligibleForIssueRequest);
  const physicalQty = physical.reduce((s, c) => s + (Number(c.qty) || 0), 0);

  let reservedMap = reservedByUid;
  let outSet = outDraftUids;
  if (!reservedMap || !outSet) {
    const [reservedRows, draftSet] = await Promise.all([
      reservedMap ? Promise.resolve(null) : findReservedCoilsFromRequests({ excludeIssueUid, client }),
      outSet ? Promise.resolve(null) : findOutDraftReservedCoilUids(),
    ]);
    if (!reservedMap) reservedMap = reservedMaps(reservedRows);
    if (!outSet) outSet = draftSet;
  }

  const available = physical.filter((c) => {
    const key = String(c.coil_no_uid || "").toLowerCase();
    return !reservedMap.has(key) && !outSet.has(key);
  });
  const reservedQty = physical
    .filter((c) => {
      const key = String(c.coil_no_uid || "").toLowerCase();
      return reservedMap.has(key) || outSet.has(key);
    })
    .reduce((s, c) => s + (Number(c.qty) || 0), 0);

  return {
    data: available,
    store_qty: available.reduce((s, c) => s + (Number(c.qty) || 0), 0),
    physical_qty: physicalQty,
    reserved_qty: reservedQty,
    reserved_count: physical.length - available.length,
  };
}

const qtyClose = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.001;

/** Packing / MRN key for IMS-style FIFO (FIFO at MRN, any coil within). */
function coilMrnKey(c) {
  return mrnGroupKey(c);
}

/** Count coils per MRN (order-independent). Within an MRN, UIDs do not matter. */
export function mrnCoilCountMap(coils = []) {
  const counts = new Map();
  for (const c of coils || []) {
    const k = coilMrnKey(c);
    if (!k || k === "N/A") continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

function mrnCountMapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

/** Stable string form for logs / debugging. */
export function mrnCoilCountSignature(coils = []) {
  return [...mrnCoilCountMap(coils).entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map(([k, n]) => `${k}:${n}`)
    .join("|");
}

/**
 * IMS packing FIFO: selected coils must match FIFO MRN quotas for targetQty.
 * Exact coil UIDs / within-MRN order are free (any coil from the MRN).
 * Totals may differ from the canonical FIFO pick when coil weights differ inside an MRN.
 */
export function assertMrnLevelFifo(pool, selectedCoils, targetQty, excludeUids = new Set()) {
  const exclude = new Set([...(excludeUids || [])].map((u) => String(u).toLowerCase()));
  const poolByUid = new Map(
    (pool || [])
      .filter((c) => c?.coil_no_uid && !exclude.has(String(c.coil_no_uid).toLowerCase()))
      .map((c) => [String(c.coil_no_uid).toLowerCase(), c])
  );

  // Payload often sends only { coil_no_uid, qty } — enrich MRN/qty from pool
  const enriched = [];
  for (const c of selectedCoils || []) {
    const uid = String(c?.coil_no_uid || "").toLowerCase();
    if (!uid || !poolByUid.has(uid)) return false;
    const full = poolByUid.get(uid);
    enriched.push({
      ...full,
      ...c,
      qty: c.qty ?? full.qty,
      mrn_uid: c.mrn_uid || full.mrn_uid,
      mrn_no: c.mrn_no ?? full.mrn_no,
    });
  }

  const { picked } = pickCoilsFifo(pool, targetQty, excludeUids || new Set());
  if (enriched.length !== picked.length) return false;
  if (!mrnCountMapsEqual(mrnCoilCountMap(picked), mrnCoilCountMap(enriched))) return false;
  const selectedQty = enriched.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const target = Number(targetQty) || 0;
  if (target > 0 && selectedQty + 1e-9 < target) return false;
  return true;
}

/**
 * Validate coils are available (not reserved elsewhere) and match FIFO.
 * Fast path: one reserve lookup, one store-out set, cached RM pools, single FIFO check.
 */
export async function assertIssueRequestCoilsAvailable(
  jobCards = [],
  { excludeIssueUid = null, client = null } = {}
) {
  const cards = Array.isArray(jobCards) ? jobCards : [];
  if (!cards.length) return;

  const jcNos = [
    ...new Set(
      cards
        .map((jc) => String(jc?.pjobcardno || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];

  const [reservedRows, outDraftUids, issuedRows] = await Promise.all([
    findReservedCoilsFromRequests({ excludeIssueUid, client }),
    findOutDraftReservedCoilUids(),
    jcNos.length ? findIssuedQtyByJobCards(jcNos, { excludeIssueUid }) : Promise.resolve([]),
  ]);
  const reservedByUid = reservedMaps(reservedRows);
  const issuedByJc = new Map(
    (issuedRows || []).map((r) => [String(r.pjobcardno || "").toUpperCase(), Number(r.issued_qty) || 0])
  );
  const poolCache = new Map();
  const pickedInRequest = new Set();

  const getPool = async (jc) => {
    const key = poolCacheKey(jc?.rm_item_code, jc?.rm_item_dcode);
    if (!poolCache.has(key)) {
      const res = await buildAvailableCoilsForIssue({
        rm_item_code: jc?.rm_item_code,
        rm_item_dcode: jc?.rm_item_dcode,
        excludeIssueUid,
        client,
        reservedByUid,
        outDraftUids,
      });
      poolCache.set(key, res.data || []);
    }
    return poolCache.get(key);
  };

  for (const jc of cards) {
    const pjobcardno = String(jc?.pjobcardno || "").trim() || "—";
    const issueQty = Number(jc?.issue_qty);
    const dispatchRaw = Number(jc?.dispatch_qty);
    const rmWeight = Number(jc?.rm_weight) || 0;
    const alreadyIssued = issuedByJc.get(pjobcardno.toUpperCase()) || 0;
    const remainingRm =
      rmWeight > 0 ? Math.max(0, Math.round((rmWeight - alreadyIssued) * 1000) / 1000) : null;
    const coils = Array.isArray(jc?.coils) ? jc.coils : [];

    if (remainingRm != null && remainingRm <= 0) {
      throw Object.assign(
        new Error(
          `Required RM weight (${rmWeight}) is already issued for job card ${pjobcardno}.` +
            (alreadyIssued > rmWeight
              ? ` Over by ${Math.round((alreadyIssued - rmWeight) * 1000) / 1000}.`
              : "")
        ),
        { status: 400 }
      );
    }

    if (!coils.length) {
      throw Object.assign(new Error(`Select coils for job card ${pjobcardno}.`), { status: 400 });
    }
    if (!(issueQty > 0)) {
      throw Object.assign(new Error(`Enter a valid issue quantity for job card ${pjobcardno}.`), {
        status: 400,
      });
    }

    // Typed dispatch ≤ remaining required; coil total (issue_qty) may overshoot
    const dispatchQty =
      Number.isFinite(dispatchRaw) && dispatchRaw > 0
        ? dispatchRaw
        : remainingRm != null && issueQty > remainingRm + 1e-9
          ? remainingRm
          : issueQty;
    if (remainingRm != null && dispatchQty > remainingRm + 1e-9) {
      throw Object.assign(
        new Error(
          `Dispatch qty cannot exceed required RM (${remainingRm}) for job card ${pjobcardno}.` +
            (alreadyIssued > 0 ? ` Already issued ${alreadyIssued} of ${rmWeight}.` : "")
        ),
        { status: 400 }
      );
    }

    const coilQty = coils.reduce((s, c) => s + (Number(c.qty) || 0), 0);
    if (!qtyClose(coilQty, issueQty)) {
      throw Object.assign(
        new Error(`Issue quantity must match the selected coil total for job card ${pjobcardno}.`),
        { status: 400 }
      );
    }

    for (const c of coils) {
      const uid = String(c?.coil_no_uid || "").trim();
      const key = uid.toLowerCase();
      if (!uid) {
        throw Object.assign(new Error(`Invalid coil on job card ${pjobcardno}.`), { status: 400 });
      }
      if (pickedInRequest.has(key)) {
        throw Object.assign(new Error(`Coil ${uid} is used on more than one job card.`), {
          status: 400,
        });
      }

      const hit = reservedByUid.get(key);
      if (hit) {
        throw Object.assign(
          new Error(`Coil ${uid} is already reserved on Issue Request #${hit.issue_uid}.`),
          { status: 400 }
        );
      }
      if (outDraftUids.has(key)) {
        throw Object.assign(new Error(`Coil ${uid} is already reserved on a store out.`), {
          status: 400,
        });
      }
    }

    const pool = await getPool(jc);
    const fifoTarget = dispatchQty > 0 ? dispatchQty : issueQty;
    if (!assertMrnLevelFifo(pool, coils, fifoTarget, pickedInRequest)) {
      throw Object.assign(
        new Error(
          `Coils for job card ${pjobcardno} must follow MRN FIFO. Please refresh and try again.`
        ),
        { status: 400 }
      );
    }

    for (const c of coils) {
      pickedInRequest.add(String(c.coil_no_uid).toLowerCase());
    }
  }
}
