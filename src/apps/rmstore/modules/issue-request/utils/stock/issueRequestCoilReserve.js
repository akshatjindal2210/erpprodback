import { findCoils } from "../../../coil/models/coil.model.js";
import { findReservedCoilsFromRequests } from "../../models/issueRequest.model.js";
import { findOpenOutDraftForCoil, findOutDraftReservedCoilUids } from "../../../out-entry/models/outEntry.model.js";

/** Same FIFO order as Issue Request modal (created_at ASC, coil_uid ASC). */
export function sortCoilsFifo(coils = []) {
  return [...(coils || [])].sort((a, b) => {
    const ta = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b?.created_at ? new Date(b.created_at).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return Number(a?.coil_uid || 0) - Number(b?.coil_uid || 0);
  });
}

export function pickCoilsFifo(pool, targetQty, excludeUids = new Set()) {
  const exclude = new Set([...excludeUids].map((u) => String(u).toLowerCase()));
  const sorted = sortCoilsFifo(pool).filter(
    (c) => c?.coil_no_uid && !exclude.has(String(c.coil_no_uid).toLowerCase())
  );

  const storeQty = sorted.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  if (!(Number(targetQty) > 0)) {
    return { picked: [], pickedQty: 0, storeQty, available: sorted };
  }

  const picked = [];
  let pickedQty = 0;
  for (const c of sorted) {
    if (pickedQty >= Number(targetQty)) break;
    picked.push(c);
    pickedQty += Number(c.qty) || 0;
  }
  return { picked, pickedQty, storeQty, available: sorted };
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

  let stored = await fetchAllCoils({ stored: true, ...itemFilter });
  let unassigned = await fetchAllCoils({ coil_area: true, ...itemFilter });

  if (!stored.length && !unassigned.length && code && Number.isFinite(dcode) && dcode > 0) {
    stored = await fetchAllCoils({ stored: true, item_code: code });
    unassigned = await fetchAllCoils({ coil_area: true, item_code: code });
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

/**
 * Physical active coils minus reservations from other issue requests + open store-out drafts.
 * Pending + approved issue requests both reserve (IMS forwarding-note style).
 */
export async function buildAvailableCoilsForIssue({
  rm_item_code,
  rm_item_dcode,
  excludeIssueUid = null,
} = {}) {
  const physical = await fetchActiveRmCoils({ rm_item_code, rm_item_dcode });
  const physicalQty = physical.reduce((s, c) => s + (Number(c.qty) || 0), 0);

  const [reservedRows, outDraftUids] = await Promise.all([
    findReservedCoilsFromRequests({ excludeIssueUid }),
    findOutDraftReservedCoilUids(),
  ]);
  const reservedByUid = reservedMaps(reservedRows);

  const available = physical.filter((c) => {
    const key = String(c.coil_no_uid || "").toLowerCase();
    return !reservedByUid.has(key) && !outDraftUids.has(key);
  });
  const reservedQty = physical
    .filter((c) => {
      const key = String(c.coil_no_uid || "").toLowerCase();
      return reservedByUid.has(key) || outDraftUids.has(key);
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

function assertSameUidList(submitted, expected) {
  const a = submitted.map((u) => String(u).toLowerCase());
  const b = expected.map((u) => String(u).toLowerCase());
  return a.length === b.length && a.every((u, i) => u === b[i]);
}

/**
 * Validate coils are not reserved elsewhere and match FIFO pick for each job card.
 */
export async function assertIssueRequestCoilsAvailable(jobCards = [], { excludeIssueUid = null } = {}) {
  const reservedRows = await findReservedCoilsFromRequests({ excludeIssueUid });
  const reservedByUid = reservedMaps(reservedRows);
  const pickedInRequest = new Set();

  for (const jc of jobCards || []) {
    const pjobcardno = String(jc?.pjobcardno || "").trim();
    const issueQty = Number(jc?.issue_qty);
    const coils = Array.isArray(jc?.coils) ? jc.coils : [];
    if (!coils.length) {
      throw Object.assign(new Error(`Select coils in FIFO order for job card ${pjobcardno}.`), { status: 400 });
    }

    for (const c of coils) {
      const uid = String(c?.coil_no_uid || "").trim();
      const key = uid.toLowerCase();
      if (pickedInRequest.has(key)) {
        throw Object.assign(new Error(`Coil ${uid} is used on more than one job card.`), { status: 400 });
      }

      const hit = reservedByUid.get(key);
      if (hit) {
        throw Object.assign(
          new Error(
            `Coil ${uid} is reserved on Issue Request #${hit.issue_uid}. Delete or edit that request first.`
          ),
          { status: 400 }
        );
      }

      const outDraft = await findOpenOutDraftForCoil(uid);
      if (outDraft) {
        throw Object.assign(
          new Error(`Coil ${uid} is reserved on Store Out #${outDraft.out_uid}.`),
          { status: 400 }
        );
      }
    }

    const { data: pool } = await buildAvailableCoilsForIssue({
      rm_item_code: jc.rm_item_code,
      rm_item_dcode: jc.rm_item_dcode,
      excludeIssueUid,
    });

    const { picked } = pickCoilsFifo(pool, issueQty, pickedInRequest);
    const submittedUids = coils.map((c) => c.coil_no_uid);
    const expectedUids = picked.map((c) => c.coil_no_uid);

    if (!assertSameUidList(submittedUids, expectedUids)) {
      throw Object.assign(
        new Error(
          `Coils for job card ${pjobcardno} must follow FIFO order (oldest store-in / coil-area first). Refresh and pick again.`
        ),
        { status: 400 }
      );
    }

    for (const c of coils) {
      pickedInRequest.add(String(c.coil_no_uid).toLowerCase());
    }
  }
}
