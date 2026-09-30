import dbQuery from "../../../../../config/db/db.js";
import { RMSTORE_TABLES as T } from "../../../../../config/db/dbTables.js";
import { buildNaiveTimestampUpdateParts } from "../../../lib/utils/sqlTimestampUpdate.js";

const TABLE = T.IN_PROCESS_REQUEST;
const REJECTION_TABLE = T.REJECTION;
const COIL_TABLE = T.COIL_TABLE;
const MRN_TABLE = T.MRN;

/** Canonical row purpose (DB `type`). */
export const IPR_TYPE = {
  CONSUME: "consume",
  RETURN: "return",
  REASSIGN: "reassign",
  COIL: "reject_coil",
  LOT: "reject_lot",
};

/** Legacy DB type values before reject_coil / reject_lot rename. */
const LEGACY_TYPE_MAP = {
  coil: IPR_TYPE.COIL,
  lot: IPR_TYPE.LOT,
};

/** Canonical workflow stage (DB `stage`; was `downstream`). */
export const IPR_STAGE = {
  NONE: null,
  PENDING_STORE_OUT: "pending_store_out",
  PENDING_STORE_IN: "pending_store_in",
  CONSUMED: "consumed",
  STORE_IN_DONE: "store_in_done",
  STORE_OUT_DONE: "store_out_done",
};

/**
 * FE / legacy API aliases — map from type.
 * Prefer IPR_TYPE for new code; keep these so Pending/Register payloads stay stable.
 */
export const IPR_REQUEST_TYPE = {
  REJECTION: "rejection",
  STORE_IN: "store_in",
  CONSUME: "consume",
  TRANSFER: "transfer",
};

/** @deprecated use IPR_STAGE — kept as alias for FE/controllers */
export const IPR_DOWNSTREAM = {
  NONE: IPR_STAGE.NONE,
  PENDING_STORE_OUT: IPR_STAGE.PENDING_STORE_OUT,
  PENDING_STORE_IN: IPR_STAGE.PENDING_STORE_IN,
  CONSUMED: IPR_STAGE.CONSUMED,
  TRANSFER_PENDING: "transfer_pending",
  STORE_IN_DONE: IPR_STAGE.STORE_IN_DONE,
  STORE_OUT_DONE: IPR_STAGE.STORE_OUT_DONE,
};

const SELECT_COLS = `r.*,
            r.created_by AS created_by_name,
            r.updated_by AS updated_by_name,
            r.approved_by AS approved_by_name`;

const KNOWN_TYPES = new Set(Object.values(IPR_TYPE));
const KNOWN_REQUEST_TYPES = new Set(Object.values(IPR_REQUEST_TYPE));

export function normalizeType(value) {
  const t = String(value || "").trim().toLowerCase();
  if (KNOWN_TYPES.has(t)) return t;
  return LEGACY_TYPE_MAP[t] || null;
}

export function isIprRejectionType(type) {
  const t = normalizeType(type);
  return t === IPR_TYPE.COIL || t === IPR_TYPE.LOT;
}

export function normalizeRequestType(value) {
  const type = String(value || "").trim();
  return KNOWN_REQUEST_TYPES.has(type) ? type : IPR_REQUEST_TYPE.REJECTION;
}

export function typeToRequestType(type) {
  const t = normalizeType(type);
  if (t === IPR_TYPE.RETURN) return IPR_REQUEST_TYPE.STORE_IN;
  if (t === IPR_TYPE.COIL || t === IPR_TYPE.LOT) return IPR_REQUEST_TYPE.REJECTION;
  if (t === IPR_TYPE.CONSUME || t === IPR_TYPE.REASSIGN) return IPR_REQUEST_TYPE.CONSUME;
  return IPR_REQUEST_TYPE.REJECTION;
}

export function typeToRejectionType(type) {
  const t = normalizeType(type);
  if (t === IPR_TYPE.LOT) return "lot";
  if (t === IPR_TYPE.COIL) return "coil";
  return null;
}

/** Derive canonical type from legacy request_type + rejection_type + coils. */
export function resolveTypeFromLegacy({ request_type, rejection_type, coils } = {}) {
  const raw = String(request_type || "").trim();
  // Empty request_type must NOT default to rejection (legacy col may be dropped).
  if (!raw) {
    const lines = normalizeCoils(coils);
    if (lines.some((c) => c.reassign === true)) return IPR_TYPE.REASSIGN;
    if (
      lines.some(
        (c) =>
          num(c.consumed_qty) > 0 ||
          (c.original_qty != null &&
            c.remaining_qty != null &&
            num(c.remaining_qty) !== num(c.original_qty))
      )
    ) {
      return IPR_TYPE.CONSUME;
    }
    return null;
  }
  const rt = normalizeRequestType(raw);
  if (rt === IPR_REQUEST_TYPE.STORE_IN) return IPR_TYPE.RETURN;
  if (rt === IPR_REQUEST_TYPE.REJECTION) {
    return rejection_type === "lot" ? IPR_TYPE.LOT : IPR_TYPE.COIL;
  }
  if (rt === IPR_REQUEST_TYPE.CONSUME || rt === IPR_REQUEST_TYPE.TRANSFER) {
    if (normalizeCoils(coils).some((c) => c.reassign === true)) return IPR_TYPE.REASSIGN;
    return IPR_TYPE.CONSUME;
  }
  return null;
}

/** Infer type from stage / coils when DB type + request_type are missing. */
function inferTypeFromStageAndCoils(row = {}) {
  const lines = normalizeCoils(row.coils);
  const stage = resolveCanonicalStage(row);
  if (stage === IPR_STAGE.PENDING_STORE_OUT || stage === IPR_STAGE.STORE_OUT_DONE) {
    return IPR_TYPE.COIL;
  }
  if (stage === IPR_STAGE.CONSUMED) return IPR_TYPE.CONSUME;
  if (stage === IPR_STAGE.PENDING_STORE_IN || stage === IPR_STAGE.STORE_IN_DONE) {
    // Update Coil Status leftover still has consumed qty / split original/remaining.
    if (
      lines.some(
        (c) =>
          num(c.consumed_qty) > 0 ||
          (c.original_qty != null &&
            c.remaining_qty != null &&
            num(c.remaining_qty) < num(c.original_qty))
      )
    ) {
      return IPR_TYPE.CONSUME;
    }
    return IPR_TYPE.RETURN;
  }
  if (
    lines.some(
      (c) =>
        num(c.consumed_qty) > 0 ||
        (c.original_qty != null &&
          c.remaining_qty != null &&
          num(c.remaining_qty) < num(c.original_qty))
    )
  ) {
    return IPR_TYPE.CONSUME;
  }
  return null;
}

export function resolveCanonicalType(row = {}) {
  // Reassign wins even when type was incorrectly saved as consume.
  if (str(row.reassign_jc) || normalizeCoils(row.coils).some((c) => c.reassign === true)) {
    return IPR_TYPE.REASSIGN;
  }
  return (
    normalizeType(row.type) ||
    resolveTypeFromLegacy({
      request_type: row.request_type,
      rejection_type: row.rejection_type,
      coils: row.coils,
    }) ||
    inferTypeFromStageAndCoils(row) ||
    IPR_TYPE.COIL
  );
}

export function resolveCanonicalStage(row = {}) {
  const stage = row.stage != null && String(row.stage).trim() !== "" ? String(row.stage).trim() : null;
  if (stage) return stage;
  const down = row.downstream != null && String(row.downstream).trim() !== "" ? String(row.downstream).trim() : null;
  return down;
}

/** Store-in approval queues for receive; coil update happens on complete (same UID, return qty). */
export function resolveDownstream(requestType, approved) {
  if (!approved) return IPR_STAGE.NONE;
  const type = normalizeRequestType(requestType);
  if (type === IPR_REQUEST_TYPE.STORE_IN) return IPR_STAGE.PENDING_STORE_IN;
  if (type === IPR_REQUEST_TYPE.CONSUME) return IPR_STAGE.CONSUMED;
  if (type === IPR_REQUEST_TYPE.TRANSFER) return IPR_DOWNSTREAM.TRANSFER_PENDING;
  return IPR_STAGE.PENDING_STORE_OUT;
}

export function resolveStageForType(type, approved) {
  if (!approved) return IPR_STAGE.NONE;
  const t = normalizeType(type);
  if (t === IPR_TYPE.RETURN) return IPR_STAGE.PENDING_STORE_IN;
  if (t === IPR_TYPE.CONSUME || t === IPR_TYPE.REASSIGN) return IPR_STAGE.CONSUMED;
  if (t === IPR_TYPE.COIL || t === IPR_TYPE.LOT) return IPR_STAGE.PENDING_STORE_OUT;
  return IPR_STAGE.NONE;
}

/** Reassign partial consume — balance moves to another job card on shop floor (not Store In). */
export function hasReassignShopFloorBalance(coils = [], type = null) {
  const lines = normalizeCoils(coils);
  if (normalizeType(type) === IPR_TYPE.REASSIGN) {
    return lines.some((c) => num(c.remaining_qty) > 0);
  }
  return lines.some((c) => c.reassign === true && num(c.remaining_qty) > 0);
}

/** After consume is applied — leftover return queues Store In; reassign balance stays on shop floor. */
export function resolveConsumeDownstream(coils = [], type = null) {
  const lines = normalizeCoils(coils);
  const balance = lines.reduce((s, c) => s + num(c.remaining_qty), 0);
  if (balance <= 0) return IPR_STAGE.CONSUMED;
  if (hasReassignShopFloorBalance(lines, type)) return IPR_STAGE.CONSUMED;
  return IPR_STAGE.PENDING_STORE_IN;
}

/** Links an auto-queued store-in row back to its source consume IPR. */
export const AUTO_STORE_IN_FROM_CONSUME_PREFIX = "AUTO_FROM_CONSUME:";

export const AUTO_CONSUME_FROM_STORE_IN_PREFIX = "AUTO_FROM_STORE_IN:";

export function autoConsumeFromStoreInRemarks(storeInIprUid) {
  return `${AUTO_CONSUME_FROM_STORE_IN_PREFIX}${Number(storeInIprUid)}`;
}

export function autoStoreInFromConsumeRemarks(consumeIprUid) {
  return `${AUTO_STORE_IN_FROM_CONSUME_PREFIX}${Number(consumeIprUid)}`;
}

/** Parse source consume IPR id from auto-queued store-in remarks. */
export function parseConsumeIprUidFromAutoStoreInRemarks(remarks) {
  const s = String(remarks || "");
  if (!s.startsWith(AUTO_STORE_IN_FROM_CONSUME_PREFIX)) return null;
  const id = Number(s.slice(AUTO_STORE_IN_FROM_CONSUME_PREFIX.length));
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Pending store-in auto-created after partial consume (not yet received). */
export const findPendingAutoStoreInForConsume = async (consumeIprUid) => {
  const id = Number(consumeIprUid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ${SELECT_COLS} FROM ${TABLE} r
     WHERE r.is_deleted = false AND r.type = '${IPR_TYPE.RETURN}' AND r.approved = true
       AND r.stage = '${IPR_STAGE.PENDING_STORE_IN}' AND r.remarks = $1
     ORDER BY r.ipr_uid DESC LIMIT 1`,
    [autoStoreInFromConsumeRemarks(id)]
  );
  return row ? await summarizeRowAsync(row) : null;
};

const PENDING_STORE_IN_COIL_EXISTS = `EXISTS (
  SELECT 1 FROM jsonb_array_elements(r.coils) elem
  WHERE lower(elem->>'coil_no_uid') = $1
)`;

/** Pending store-in queue row that already includes this coil. */
export const findPendingStoreInForCoil = async (coilUid) => {
  const uid = String(coilUid || "").trim().toLowerCase();
  if (!uid) return null;

  const [row] = await dbQuery(
    `SELECT ${SELECT_COLS} FROM ${TABLE} r
     WHERE r.is_deleted = false AND r.approved = true
       AND r.stage = '${IPR_STAGE.PENDING_STORE_IN}'
       AND r.type IN ('${IPR_TYPE.CONSUME}', '${IPR_TYPE.RETURN}')
       AND ${PENDING_STORE_IN_COIL_EXISTS}
     ORDER BY r.ipr_uid DESC LIMIT 1`,
    [uid]
  );
  return row ? summarizeRowAsync(row) : null;
};

function jsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v == null || v === "" ? null : String(v));

/**
 * DB coils JSON — minimum only:
 *   full / rejection: { coil_no_uid, qty }
 *   partial consume/return/reassign: { coil_no_uid, original_qty, remaining_qty }
 * consumed_qty / extras derived on read.
 */
export function slimCoilForStorage(c = {}) {
  if (!c?.coil_no_uid) return null;
  const original = c.original_qty != null ? num(c.original_qty) : num(c.qty);
  const remaining =
    c.remaining_qty != null
      ? num(c.remaining_qty)
      : c.consumed_qty != null
        ? Math.max(0, original - num(c.consumed_qty))
        : original;
  const out = { coil_no_uid: String(c.coil_no_uid) };
  // Keep JC/machine + out_uid snapshot — delete/unapprove must put coils back on shop floor.
  const pjobcardno = str(c.pjobcardno);
  const macname = str(c.macname);
  if (pjobcardno) out.pjobcardno = pjobcardno;
  if (macname) out.macname = macname;
  if (c.reassign === true) out.reassign = true;
  const outUid = c.out_uid != null && c.out_uid !== "" ? Number(c.out_uid) : null;
  if (Number.isFinite(outUid) && outUid > 0) out.out_uid = outUid;
  // No split — one qty is enough
  if (remaining === original) {
    if (original !== 0) out.qty = original;
    return out;
  }
  out.original_qty = original;
  out.remaining_qty = remaining;
  return out;
}

export function slimCoilsForStorage(coils) {
  return jsonArray(coils).map(slimCoilForStorage).filter(Boolean);
}

/** @deprecated proposed_coils column dropped — kept for FE payload fold-in only. */
export function slimProposedCoilsForStorage(coils) {
  return jsonArray(coils)
    .filter((c) => c && (c.coil_no_uid || c.from_coil_uid || c.temp_id) && num(c.qty) > 0)
    .map((c) => slimCoilForStorage({
      coil_no_uid: c.coil_no_uid || c.from_coil_uid,
      qty: c.qty,
      original_qty: c.qty,
      remaining_qty: c.qty,
    }))
    .filter(Boolean);
}

/** Attachments DB shape: string paths only. */
export function slimAttachmentsForStorage(attachments) {
  return jsonArray(attachments)
    .map((a) => {
      if (typeof a === "string") return a.trim();
      if (a && typeof a === "object") {
        return String(a.path || a.url || a.filename || a.name || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

export function normalizeCoils(coils) {
  return jsonArray(coils)
    .filter((c) => c?.coil_no_uid)
    .map((c) => {
      const original =
        c.original_qty != null ? num(c.original_qty) : c.qty != null ? num(c.qty) : 0;
      const remaining =
        c.remaining_qty != null
          ? num(c.remaining_qty)
          : c.consumed_qty != null
            ? Math.max(0, original - num(c.consumed_qty))
            : original;
      const consumed =
        c.consumed_qty != null ? num(c.consumed_qty) : Math.max(0, original - remaining);
      return {
        coil_no_uid: String(c.coil_no_uid),
        qty: original,
        original_qty: original,
        remaining_qty: remaining,
        consumed_qty: consumed,
        item_code: str(c.item_code),
        item_desc: str(c.item_desc),
        heat_no: str(c.heat_no),
        mrn_uid: str(c.mrn_uid),
        mrn_no: c.mrn_no ?? null,
        location_id: c.location_id ?? null,
        location_no: str(c.location_no),
        out_uid: c.out_uid ?? null,
        pjobcardno: str(c.pjobcardno),
        macname: str(c.macname),
        reassign: c.reassign === true,
        reassign_rm_item_code: str(c.reassign_rm_item_code),
        status: str(c.status),
        source: str(c.source),
        is_seed_scan: Boolean(c.is_seed_scan),
        store_in_qty: c.store_in_qty != null ? num(c.store_in_qty) : null,
        balance_in_store_in: c.balance_in_store_in === true,
      };
    });
}

export function normalizeProposedCoils(coils) {
  return jsonArray(coils)
    .filter((c) => c && (c.coil_no_uid || c.temp_id) && num(c.qty) > 0)
    .map((c, i) => ({
      temp_id: str(c.temp_id) || `proposed-${i + 1}`,
      coil_no_uid: str(c.coil_no_uid),
      qty: num(c.qty),
      item_code: str(c.item_code),
      item_desc: str(c.item_desc),
      heat_no: str(c.heat_no),
      mrn_uid: str(c.mrn_uid),
      mrn_no: c.mrn_no ?? null,
      from_coil_uid: str(c.from_coil_uid) || str(c.coil_no_uid),
    }));
}

async function loadCoilMetaByUids(uids = []) {
  const list = [...new Set(uids.map((u) => String(u || "").trim()).filter(Boolean))];
  if (!list.length) return new Map();
  const placeholders = list.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await dbQuery(
    `SELECT
       c.coil_no_uid,
       c.mrn_uid,
       c.qty,
       c.location_id,
       c.out_uid,
       c.status,
       m.mrn_no,
       m.heat_no,
       m.item_code,
       m.item_desc
     FROM ${COIL_TABLE} c
     LEFT JOIN ${MRN_TABLE} m ON m.uid = c.mrn_uid
     WHERE c.coil_no_uid IN (${placeholders})`,
    list
  );
  const map = new Map();
  for (const row of rows || []) {
    map.set(String(row.coil_no_uid).toLowerCase(), row);
  }
  return map;
}

function enrichCoilLine(line, meta) {
  if (!line) return line;
  if (!meta) return line;
  return {
    ...line,
    item_code: line.item_code || str(meta.item_code),
    item_desc: line.item_desc || str(meta.item_desc),
    heat_no: line.heat_no || str(meta.heat_no),
    mrn_uid: line.mrn_uid || str(meta.mrn_uid),
    mrn_no: line.mrn_no ?? meta.mrn_no ?? null,
    location_id: line.location_id ?? meta.location_id ?? null,
    out_uid: line.out_uid ?? meta.out_uid ?? null,
    status: line.status || str(meta.status),
  };
}

async function enrichCoilsArrays(coils, proposed) {
  const uids = [
    ...normalizeCoils(coils).map((c) => c.coil_no_uid),
    ...normalizeProposedCoils(proposed).map((c) => c.coil_no_uid || c.from_coil_uid),
  ];
  const meta = await loadCoilMetaByUids(uids);
  const coilsOut = normalizeCoils(coils).map((c) =>
    enrichCoilLine(c, meta.get(String(c.coil_no_uid).toLowerCase()))
  );
  const proposedOut = normalizeProposedCoils(proposed).map((c) => {
    const key = String(c.coil_no_uid || c.from_coil_uid || "").toLowerCase();
    return enrichCoilLine(c, meta.get(key));
  });
  return { coils: coilsOut, proposed_coils: proposedOut };
}

function slimCoilLineForApi(c, { detail = false } = {}) {
  if (!c?.coil_no_uid) return null;
  if (!detail) return { coil_no_uid: String(c.coil_no_uid) };
  return {
    coil_no_uid: String(c.coil_no_uid),
    qty: num(c.qty),
    original_qty: num(c.original_qty),
    remaining_qty: num(c.remaining_qty),
    consumed_qty: num(c.consumed_qty),
    item_code: c.item_code || null,
    item_desc: c.item_desc || null,
    heat_no: c.heat_no || null,
    mrn_uid: c.mrn_uid || null,
    mrn_no: c.mrn_no ?? null,
    location_id: c.location_id ?? null,
    location_no: c.location_no || null,
    out_uid: c.out_uid ?? null,
    pjobcardno: c.pjobcardno || null,
    macname: c.macname || null,
    reassign: c.reassign === true,
    status: c.status || null,
    source: c.source || null,
    is_seed_scan: Boolean(c.is_seed_scan),
  };
}

/**
 * API row — FE-ready.
 * mode "list"  = Register/Pending table (minimal).
 * mode "detail" = modal / receive / helper (full working fields, still trimmed).
 */
export function summarizeRow(row, { coils, mode = "detail" } = {}) {
  if (!row) return null;
  const type = resolveCanonicalType(row);
  const stage = resolveCanonicalStage(row);
  const request_type = typeToRequestType(type);
  const rejection_type = typeToRejectionType(type);
  const isReturn = type === IPR_TYPE.RETURN;
  const isConsume = type === IPR_TYPE.CONSUME || type === IPR_TYPE.REASSIGN;
  const isReject = isIprRejectionType(type);
  const reassign_jc = str(row.reassign_jc);
  const isList = mode === "list";

  let lines = normalizeCoils(coils ?? row.coils);
  if (type === IPR_TYPE.REASSIGN) {
    lines = lines.map((c) => ({ ...c, reassign: true }));
  }

  const originalSum = lines.reduce((s, c) => s + num(c.original_qty), 0);
  const remainingSum = lines.reduce((s, c) => s + num(c.remaining_qty), 0);
  const consumedSum = lines.reduce((s, c) => s + num(c.consumed_qty), 0);
  const first = lines[0] || {};
  const balance_qty = isConsume || isReturn ? remainingSum : 0;
  const balance_status = isReject
    ? "Rejected"
    : !isConsume
      ? null
      : remainingSum <= 0
        ? "Full"
        : type === IPR_TYPE.REASSIGN || hasReassignShopFloorBalance(lines, type)
          ? "Reassign"
          : "Balance";

  const fromCoil = str(first.pjobcardno) || str(first.source_pjobcardno);
  const sourceJc =
    fromCoil && !(reassign_jc && fromCoil.toUpperCase() === reassign_jc.toUpperCase())
      ? fromCoil
      : null;
  const sourceMac = str(first.macname) || str(first.source_macname) || null;

  const total_qty = isConsume
    ? originalSum
    : isReturn
      ? remainingSum
      : lines.reduce((s, c) => s + num(c.qty), 0);
  const consumed_qty = isReturn
    ? Math.max(0, originalSum - remainingSum)
    : isConsume
      ? consumedSum
      : 0;

  const base = {
    ipr_uid: row.ipr_uid,
    type,
    reassign_jc,
    reason: row.reason ?? null,
    remarks: row.remarks ?? null,
    mrn_uid: row.mrn_uid ?? null,
    coils: lines.map((c) => slimCoilLineForApi(c, { detail: !isList })).filter(Boolean),
    approved: row.approved === true,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_by: row.updated_by ?? null,
    updated_at: row.updated_at ?? null,
    created_by_name: row.created_by_name || row.created_by || null,
    updated_by_name: row.updated_by_name || row.updated_by || null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    approved_by_name: row.approved_by_name || row.approved_by || null,
    request_type,
    rejection_type,
    downstream: stage,
    seed_coil_uid: first.coil_no_uid || null,
    coil_count: lines.length,
    total_qty,
    consumed_qty,
    balance_qty,
    balance_status,
    item_code: first.item_code || null,
    item_desc: first.item_desc || null,
    mrn_no: first.mrn_no ?? null,
    heat_no: first.heat_no || null,
    mrn_label: str(row.mrn_uid),
    heat_label: first.heat_no || null,
    lot_label: type === IPR_TYPE.LOT ? str(row.mrn_uid) : null,
    pjobcardno: sourceJc,
    macname: sourceMac,
    coil_label:
      lines.length === 1 ? first.coil_no_uid : lines.length > 1 ? `${lines.length} coils` : null,
  };

  if (isList) return base;

  // Detail — modal / receive / helper only
  return {
    ...base,
    previous_coils: lines.map((c) => slimCoilLineForApi(c, { detail: true })).filter(Boolean),
    attachments: slimAttachmentsForStorage(row.attachments),
    proposed_coils: lines
      .filter((c) => num(c.remaining_qty) > 0)
      .map((c) => ({
        coil_no_uid: c.coil_no_uid,
        from_coil_uid: c.coil_no_uid,
        qty: num(c.remaining_qty),
        item_code: c.item_code || null,
        item_desc: c.item_desc || null,
        heat_no: c.heat_no || null,
        mrn_uid: c.mrn_uid || null,
        mrn_no: c.mrn_no ?? null,
      })),
  };
}

export async function summarizeRowAsync(row, { mode = "detail" } = {}) {
  if (!row) return null;
  const { coils } = await enrichCoilsArrays(row.coils, []);
  return summarizeRow(row, { coils, mode });
}

function sqlRequestTypeFilter(filterValue) {
  const rt = normalizeRequestType(filterValue);
  if (rt === IPR_REQUEST_TYPE.STORE_IN) return `r.type = '${IPR_TYPE.RETURN}'`;
  if (rt === IPR_REQUEST_TYPE.CONSUME) {
    return `r.type IN ('${IPR_TYPE.CONSUME}', '${IPR_TYPE.REASSIGN}')`;
  }
  return `r.type IN ('${IPR_TYPE.COIL}', '${IPR_TYPE.LOT}')`;
}

export const findInProcessRequests = async (options = {}) => {
  const {
    filters = {},
    search,
    page = 1,
    limit = 100,
    includeAutoStoreInFromConsume = false,
    pendingStoreInQueue = false,
    permission = {},
  } = options;
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`r.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  if (pendingStoreInQueue) {
    conditions.push(
      `r.approved = true AND r.stage = '${IPR_STAGE.PENDING_STORE_IN}' AND r.type IN ('${IPR_TYPE.CONSUME}', '${IPR_TYPE.RETURN}')`
    );
  } else if (!includeAutoStoreInFromConsume) {
    conditions.push(
      `NOT (r.type = '${IPR_TYPE.RETURN}' AND COALESCE(r.remarks, '') LIKE '${AUTO_STORE_IN_FROM_CONSUME_PREFIX}%')`
    );
  }

  if (filters.request_type && filters.request_type !== "all") {
    conditions.push(sqlRequestTypeFilter(filters.request_type));
  }
  if (filters.type && filters.type !== "all") {
    const t = String(filters.type).trim().toLowerCase();
    if (t === IPR_TYPE.RETURN || t === IPR_REQUEST_TYPE.STORE_IN) {
      // Pure store-in OR Update Coil Status leftover (consume + store-in balance).
      conditions.push(
        `(r.type = '${IPR_TYPE.RETURN}' OR (r.type = '${IPR_TYPE.CONSUME}' AND r.stage IN ('${IPR_STAGE.PENDING_STORE_IN}', '${IPR_STAGE.STORE_IN_DONE}')))`
      );
    } else if (t === IPR_TYPE.CONSUME) {
      // Full consume only — exclude leftover-return rows shown as Return in UI.
      conditions.push(
        `r.type = '${IPR_TYPE.CONSUME}' AND COALESCE(r.stage, '') NOT IN ('${IPR_STAGE.PENDING_STORE_IN}', '${IPR_STAGE.STORE_IN_DONE}')`
      );
    } else if (t === IPR_TYPE.REASSIGN) {
      conditions.push(
        `(r.type = '${IPR_TYPE.REASSIGN}' OR NULLIF(TRIM(r.reassign_jc), '') IS NOT NULL)`
      );
    } else {
      values.push(t);
      conditions.push(`r.type = $${i++}`);
    }
  }
  if (filters.approved !== undefined && filters.approved !== null && filters.approved !== "") {
    values.push(filters.approved === true || filters.approved === "true");
    conditions.push(`r.approved = $${i++}`);
  }
  if (filters.downstream || filters.stage) {
    values.push(String(filters.downstream || filters.stage));
    conditions.push(`r.stage = $${i++}`);
  }
  if (filters.from_date) {
    values.push(filters.from_date);
    conditions.push(`r.created_at >= $${i++}`);
  }
  if (filters.to_date) {
    values.push(filters.to_date);
    conditions.push(`r.created_at <= $${i++}`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = i++;
    conditions.push(`(
      COALESCE(r.reason,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(r.reassign_jc,'') ILIKE $${idx} OR
      COALESCE(r.type,'') ILIKE $${idx} OR
      COALESCE(r.stage,'') ILIKE $${idx} OR
      COALESCE(r.created_by,'') ILIKE $${idx} OR
      COALESCE(r.coils::text,'') ILIKE $${idx} OR
      COALESCE(r.attachments::text,'') ILIKE $${idx} OR
      r.ipr_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT ${SELECT_COLS}
     FROM ${TABLE} r
     ${where}
     ORDER BY r.ipr_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  // One batched coil-meta load for the page (avoids N+1 per row).
  const pageRows = rows || [];
  const allUids = [];
  for (const r of pageRows) {
    for (const c of normalizeCoils(r.coils)) {
      if (c.coil_no_uid) allUids.push(c.coil_no_uid);
    }
  }
  const meta = await loadCoilMetaByUids(allUids);
  // pendingStoreInQueue needs working coil qtys for Store In list cards — use detail.
  const mode = pendingStoreInQueue ? "detail" : "list";
  const data = pageRows.map((r) => {
    const lines = normalizeCoils(r.coils).map((c) =>
      enrichCoilLine(c, meta.get(String(c.coil_no_uid).toLowerCase()))
    );
    return summarizeRow(r, { coils: lines, mode });
  });
  return {
    data,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.ceil(total / safeLimit),
  };
};

export const findInProcessRequest = async (ipr_uid) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return null;
  const [row] = await dbQuery(
    `SELECT ${SELECT_COLS}
     FROM ${TABLE} r
     WHERE r.ipr_uid = $1 AND r.is_deleted = false
     LIMIT 1`,
    [id]
  );
  return row ? summarizeRowAsync(row) : null;
};

/** Distinct reasons used before, newest first — powers the reason suggest field. */
export const findInProcessReasons = async ({ search, request_type, type } = {}) => {
  const values = [];
  let i = 1;
  const conditions = ["r.is_deleted = false", "COALESCE(TRIM(r.reason), '') <> ''"];

  if (type && type !== "all") {
    values.push(String(type));
    conditions.push(`r.type = $${i++}`);
  } else if (request_type && request_type !== "all") {
    conditions.push(sqlRequestTypeFilter(request_type));
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`r.reason ILIKE $${i++}`);
  }

  return dbQuery(
    `SELECT TRIM(r.reason) AS reason,
            MAX(COALESCE(r.updated_at, r.created_at)) AS last_used_at
     FROM ${TABLE} r
     WHERE ${conditions.join(" AND ")}
     GROUP BY TRIM(r.reason)
     ORDER BY last_used_at DESC NULLS LAST
     LIMIT 100`,
    values
  );
};

const WRITABLE = [
  "type", "reassign_jc", "stage",
  "reason", "remarks", "mrn_uid",
  "coils", "attachments",
  "approved", "approved_by", "approved_at",
  "created_by", "updated_by", "updated_at",
];
const JSON_COLS = new Set(["coils", "attachments"]);
const STRIP_LEGACY_WRITE = [
  "request_type", "rejection_type", "lot_no", "mrn_no", "heat_no",
  "item_code", "item_desc", "seed_coil_uid", "scanned_coil_uids", "downstream",
  "previous_coils", "proposed_coils",
];

/** Map FE/legacy fields → canonical columns; slim JSON; never write dropped cols. */
function prepareWritablePayload(data = {}) {
  const rawCoils = data.coils;
  const out = { ...data };

  let type = normalizeType(out.type);
  if (!type && (out.request_type !== undefined || rawCoils !== undefined || out.rejection_type !== undefined)) {
    type = resolveTypeFromLegacy({
      request_type: out.request_type,
      rejection_type: out.rejection_type,
      coils: rawCoils,
    });
  }
  if (type) out.type = type;

  if (out.type === IPR_TYPE.REASSIGN) {
    // reassign_jc = target only (from header). coil.pjobcardno is SOURCE — do not copy it here.
    if (out.reassign_jc === undefined || out.reassign_jc === null || out.reassign_jc === "") {
      out.reassign_jc = str(out.reassign_jc) || null;
    }
  } else if (out.type && out.reassign_jc === undefined) {
    out.reassign_jc = null;
  }

  if (out.stage === undefined && out.downstream !== undefined) {
    out.stage = out.downstream;
  }

  // Fold proposed return lines into coils when FE still sends proposed_coils.
  if (out.coils === undefined && Array.isArray(data.proposed_coils) && data.proposed_coils.length) {
    out.coils = normalizeProposedCoils(data.proposed_coils).map((p) => ({
      coil_no_uid: p.coil_no_uid || p.from_coil_uid,
      qty: p.qty,
      original_qty: p.qty,
      remaining_qty: p.qty,
      consumed_qty: 0,
    }));
  }

  if (out.coils !== undefined) out.coils = slimCoilsForStorage(out.coils);
  if (out.attachments !== undefined) out.attachments = slimAttachmentsForStorage(out.attachments);

  for (const key of STRIP_LEGACY_WRITE) delete out[key];
  return out;
}

export const insertInProcessRequest = async (data = {}) => {
  const prepared = prepareWritablePayload(data);
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const key of WRITABLE) {
    if (prepared[key] === undefined) continue;
    cols.push(key);
    placeholders.push(JSON_COLS.has(key) ? `$${i++}::jsonb` : `$${i++}`);
    values.push(JSON_COLS.has(key) ? JSON.stringify(prepared[key] || []) : prepared[key]);
  }

  const [row] = await dbQuery(
    `INSERT INTO ${TABLE} (${cols.join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING *`,
    values
  );
  return row;
};

export const updateInProcessRequest = async (ipr_uid, fields = {}) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return null;

  const prepared = prepareWritablePayload(fields);
  const safe = {};
  for (const key of WRITABLE) {
    if (prepared[key] === undefined) continue;
    safe[key] = prepared[key];
  }
  if (!Object.keys(safe).length) return findInProcessRequest(id);

  const { setParts, values, nextIndex } = buildNaiveTimestampUpdateParts(safe, {
    jsonKeys: JSON_COLS,
  });
  values.push(id);
  const [row] = await dbQuery(
    `UPDATE ${TABLE} SET ${setParts.join(", ")}
     WHERE ipr_uid = $${nextIndex} AND is_deleted = false
     RETURNING *`,
    values
  );
  return row ?? null;
};

/**
 * Approved in-process rejections waiting in RM Rejection Pending (before Store Out).
 */
export const findInProcessRejectionsPendingRejection = async (options = {}) => {
  const { search, page = 1, limit = 100 } = options;
  const values = [];
  let i = 1;
  const conditions = [
    "r.is_deleted = false",
    "r.approved = true",
    `r.type IN ('${IPR_TYPE.COIL}', '${IPR_TYPE.LOT}')`,
    `r.stage = '${IPR_STAGE.PENDING_STORE_OUT}'`,
    `NOT EXISTS (
      SELECT 1 FROM ${REJECTION_TABLE} rej
      WHERE rej.is_deleted = false AND rej.ipr_uid = r.ipr_uid
    )`,
  ];

  if (search) {
    const term = `%${search}%`;
    values.push(term);
    const idx = i++;
    conditions.push(`(
      COALESCE(r.reason,'') ILIKE $${idx} OR
      COALESCE(r.remarks,'') ILIKE $${idx} OR
      COALESCE(r.mrn_uid,'') ILIKE $${idx} OR
      COALESCE(r.reassign_jc,'') ILIKE $${idx} OR
      COALESCE(r.coils::text,'') ILIKE $${idx} OR
      r.ipr_uid::text ILIKE $${idx}
    )`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const countRes = await dbQuery(`SELECT COUNT(*) AS count FROM ${TABLE} r ${where}`, values);
  const total = Number(countRes[0]?.count || 0);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 100));
  const offset = (safePage - 1) * safeLimit;

  const rows = await dbQuery(
    `SELECT r.*
     FROM ${TABLE} r
     ${where}
     ORDER BY r.ipr_uid DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...values, safeLimit, offset]
  );

  const summarized = await Promise.all((rows || []).map((raw) => summarizeRowAsync(raw)));
  const data = summarized.map((row) => {
    const coils = row?.coils || [];
    const mrnUidSet = new Set();
    const mrnSet = new Set();
    const heatSet = new Set();
    const itemSet = new Set();
    const itemDescSet = new Set();
    for (const c of coils) {
      if (c.mrn_uid) mrnUidSet.add(String(c.mrn_uid));
      if (c.mrn_no != null) mrnSet.add(String(c.mrn_no));
      if (c.heat_no) heatSet.add(c.heat_no);
      if (c.item_code) itemSet.add(c.item_code);
      if (c.item_desc) itemDescSet.add(c.item_desc);
    }
    const first = coils[0] || {};
    const mrn_uid = [...mrnUidSet].join(" | ") || row.mrn_uid || first.mrn_uid || null;
    const item_descs = [...itemDescSet].join(" | ") || first.item_desc || null;
    return {
      ipr_uid: row.ipr_uid,
      pending_source: "in_process",
      pending_type: row.rejection_type === "lot" ? "lot" : "coil",
      is_virtual_pending: true,
      qc_reject_uid: null,
      qc_check_uid: null,
      coil_no_uid: coils.length === 1 ? first.coil_no_uid : null,
      mrn_uid,
      mrn_uids: mrn_uid,
      mrn_no: first.mrn_no ?? null,
      mrn_refs: [...mrnSet].join(" | ") || null,
      heat_nos: [...heatSet].join(" | ") || first.heat_no || null,
      item_code: first.item_code || null,
      item_codes: [...itemSet].join(" | ") || first.item_code || null,
      item_desc: item_descs,
      item_descs,
      qty: row.total_qty ?? 0,
      total_qty: row.total_qty ?? 0,
      coil_count: row.coil_count ?? coils.length,
      reason: row.reason || null,
      failure_reason: row.reason || null,
      remarks: row.remarks || null,
      rejection_type: row.rejection_type || "coil",
      inspected_by: row.approved_by || row.created_by || null,
      inspected_by_name: row.approved_by || row.created_by || null,
      inspected_at: row.approved_at || row.created_at || null,
      approved: false,
      coils,
    };
  });

  return { data, total, page: safePage, limit: safeLimit, totalPages: Math.ceil(total / safeLimit) };
};

export const softDeleteInProcessRequest = async (ipr_uid, deleted_by = null) => {
  const id = Number(ipr_uid);
  if (!Number.isFinite(id)) return;
  await dbQuery(
    `UPDATE ${TABLE}
     SET is_deleted = true, deleted_at = NOW(), deleted_by = $2
     WHERE ipr_uid = $1 AND is_deleted = false`,
    [id, deleted_by]
  );
};
