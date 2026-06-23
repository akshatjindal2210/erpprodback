import dbQuery from "../../../../config/db.js";
import { IMS_TABLES as T } from "../../../../config/dbTables.js";
import {
  sqlBoxInHand,
  sqlBoxItemDcode,
  sqlBoxCustomerCodeWithSa,
  sqlBoxPackingNumber,
  sqlDailyprodLateralForBox,
} from "../box/boxInventorySql.js";
import { enrichRowsWithIMS, getImsMapsSafe, canonicalCode } from "../erp-api/imsLookup.js";
import { fetchFromIMS } from "../../services/ims.service.js";
import { lookupPartyRateAccName, lookupPartyRateAccNameAnyItem } from "../packing-entry/packingEntryCustomers.js";
import { resolveStockAdjustmentPackingMeta } from "../stock-adjustment/stockAdjustmentPacking.js";

const SA_JOIN = `LEFT JOIN ${T.STOCK_ADJUSTMENT} sa ON b.sa_id = sa.adjustment_id AND sa.is_deleted = false`;

const SNAPSHOT_SQL = `
  SELECT
    b.box_uid,
    TRIM(b.box_no_uid::text) AS box_no_uid,
    ${sqlBoxPackingNumber("b")} AS packing_number,
    b.qty,
    NULLIF(TRIM(b.override_cust::text), '') AS override_cust,
    b.is_loose,
    b.location_id,
    b.sa_id,
    b.sa_entry_type,
    ${sqlBoxItemDcode("sa", "dp")} AS item_dcode,
    ${sqlBoxCustomerCodeWithSa("b", "sa", "dp")} AS acc_code,
    NULLIF(TRIM(sa.acc_code::text), '') AS sa_acc_code,
    NULLIF(TRIM(dp.acc_code::text), '') AS packing_acc_code
  FROM ${T.BOX_TABLE} b
  ${SA_JOIN}
  ${sqlDailyprodLateralForBox("b", "sa", sqlBoxPackingNumber("b"))}
  WHERE b.location_id = $1
    AND ${sqlBoxInHand("b")}
  ORDER BY b.box_no_uid
`;

/** In-hand boxes at this location — frozen snapshot for audit comparison. */
export async function fetchBoxSnapshotForLocation(locationId, { client = null, enrichOpts = null } = {}) {
  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(SNAPSHOT_SQL, [locationId]);
  const rows = client ? res.rows : res;
  return enrichAuditBoxRows((rows || []).map(normalizeSnapshotBox), enrichOpts);
}

const BOX_DETAIL_BY_UID_SQL = `
  SELECT
    b.box_uid,
    TRIM(b.box_no_uid::text) AS box_no_uid,
    ${sqlBoxPackingNumber("b")} AS packing_number,
    b.qty,
    NULLIF(TRIM(b.override_cust::text), '') AS override_cust,
    b.is_loose,
    b.location_id,
    b.sa_id,
    b.sa_entry_type,
    ${sqlBoxItemDcode("sa", "dp")} AS item_dcode,
    ${sqlBoxCustomerCodeWithSa("b", "sa", "dp")} AS acc_code,
    NULLIF(TRIM(sa.acc_code::text), '') AS sa_acc_code,
    NULLIF(TRIM(dp.acc_code::text), '') AS packing_acc_code,
    COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no
  FROM ${T.BOX_TABLE} b
  LEFT JOIN ${T.LOCATION_MASTER} lm ON b.location_id = lm.location_id
  ${SA_JOIN}
  ${sqlDailyprodLateralForBox("b", "sa", sqlBoxPackingNumber("b"))}
  WHERE TRIM(UPPER(b.box_no_uid::text)) = ANY($1::text[])
  ORDER BY b.box_no_uid
`;

/** Box table details for a set of box UIDs (any location). */
export async function fetchBoxDetailsByUids(uids = [], { client = null, enrichOpts = null } = {}) {
  const normalized = [...new Set((uids || []).map((uid) => normalizeUid(uid)).filter(Boolean))];
  if (!normalized.length) return new Map();

  const run = client ? (sql, params) => client.query(sql, params) : (sql, params) => dbQuery(sql, params);
  const res = await run(BOX_DETAIL_BY_UID_SQL, [normalized]);
  const rows = client ? res.rows : res;
  const enriched = await enrichAuditBoxRows(
    (rows || []).map((row) => ({
      ...normalizeSnapshotBox(row),
      location_no: row.location_no ?? null,
    })),
    enrichOpts
  );
  const map = new Map();
  for (const detail of enriched) {
    map.set(detail.box_no_uid, detail);
  }
  return map;
}

export async function fetchBoxSnapshotsForLocations(locationIds = [], { client = null } = {}) {
  const uniqueIds = [...new Set((locationIds || []).map((id) => Number(id)).filter(Number.isFinite))];
  const map = new Map();
  for (const locId of uniqueIds) {
    map.set(locId, await fetchBoxSnapshotForLocation(locId, { client }));
  }
  return map;
}

function normalizeSnapshotBox(row) {
  const overrideRaw = row.override_cust != null ? String(row.override_cust).trim() : "";
  const override_cust = overrideRaw && overrideRaw !== "-" ? overrideRaw : null;
  const accRaw = row.acc_code != null ? String(row.acc_code).trim() : "";
  const acc_code = accRaw && accRaw !== "-" ? accRaw : null;
  const saRaw = row.sa_acc_code != null ? String(row.sa_acc_code).trim() : "";
  const sa_acc_code = saRaw && saRaw !== "-" ? saRaw : null;

  return {
    box_uid: row.box_uid ?? null,
    box_no_uid: String(row.box_no_uid || "").trim().toUpperCase(),
    packing_number: row.packing_number ?? null,
    qty: row.qty ?? null,
    override_cust,
    is_loose: Boolean(row.is_loose),
    location_id: row.location_id ?? null,
    sa_id: row.sa_id ?? null,
    sa_entry_type: row.sa_entry_type ?? null,
    item_dcode: row.item_dcode ?? null,
    acc_code: acc_code ?? sa_acc_code,
    sa_acc_code,
    packing_acc_code: row.packing_acc_code ?? null,
    acc_name: resolveBoxAccName({ ...row, override_cust, acc_code: acc_code ?? sa_acc_code, sa_acc_code }),
    item_code: row.item_code ?? null,
  };
}

/** Box customer label — override_cust is the display name on ims_box (see box.model). */
export function resolveBoxAccName(row) {
  if (!row) return null;
  const existing = row.acc_name != null ? String(row.acc_name).trim() : "";
  if (existing && existing !== "-") return existing;

  const override = row.override_cust != null ? String(row.override_cust).trim() : "";
  if (override && override !== "-") return override;

  for (const candidate of [row.acc_code, row.sa_acc_code, row.packing_acc_code]) {
    const code = candidate != null ? String(candidate).trim() : "";
    if (code && code !== "-" && !/^\d+$/.test(code)) return code;
  }
  return null;
}

export function pickAuditAccCode(row) {
  for (const candidate of [row?.acc_code, row?.sa_acc_code, row?.packing_acc_code]) {
    const code = canonicalCode(candidate);
    if (code && code !== "-") return code;
  }
  return null;
}

/** Ledger + party-rate customer name (same priority as inventory report / stock adjustment). */
export function resolveAuditBoxAccName(row, { maps = null, partyMap = null } = {}) {
  const direct = resolveBoxAccName(row);
  if (direct) return direct;

  const accCode = pickAuditAccCode(row);
  const itemDcode = canonicalCode(row?.item_dcode);
  const itemDcodeClean = itemDcode && itemDcode !== "-" ? itemDcode : null;

  const fromEnrich =
    row?.acc_name != null && String(row.acc_name).trim() !== "" && row.acc_name !== "-"
      ? String(row.acc_name).trim()
      : null;
  if (fromEnrich) return fromEnrich;

  if (accCode && maps?.ledgerMap) {
    const ledgerName = maps.ledgerMap.get(accCode);
    if (ledgerName != null && String(ledgerName).trim() !== "" && ledgerName !== "-") {
      return String(ledgerName).trim();
    }
  }

  if (partyMap && accCode) {
    const partyName =
      (itemDcodeClean ? lookupPartyRateAccName(partyMap, accCode, itemDcodeClean) : null) ??
      lookupPartyRateAccNameAnyItem(partyMap, accCode);
    if (partyName) return partyName;
  }

  return null;
}

/** Shared IMS maps for audit comparison enrichment. */
export async function buildAuditEnrichContext() {
  const maps = await getImsMapsSafe();
  const partyMap = await buildAuditPartyRateAccNameMap(maps);
  return {
    maps,
    partyMap,
    enrichOpts: { maps, partyRateAccNameMap: partyMap },
    enrichCtx: { maps, partyMap },
  };
}

export async function enrichAuditBoxRows(rows = [], enrichOpts = null) {
  if (!Array.isArray(rows) || !rows.length) return rows;

  const opts = enrichOpts && typeof enrichOpts === "object" ? enrichOpts : {};
  const maps = opts.maps ?? (await getImsMapsSafe());
  const partyMap = opts.partyRateAccNameMap ?? (await buildAuditPartyRateAccNameMap(maps));

  const withSaCodes = await attachSaAccCodesFromDb(rows);
  const withPackingMeta = await attachPackingCustomerFromMeta(withSaCodes);
  const enriched = await enrichRowsWithIMS(withPackingMeta, { maps });
  const ctx = { maps, partyMap };

  return enriched.map((row) => {
    const acc_name = resolveAuditBoxAccName(row, ctx);
    return acc_name ? { ...row, acc_name } : row;
  });
}

/** Party-rate names with IMS ledger fallback (custcode rows often omit Acc_Name). */
async function buildAuditPartyRateAccNameMap(mapsIn = null) {
  const maps = mapsIn ?? (await getImsMapsSafe());
  const { ledgerMap } = maps;
  const partyRates = await fetchFromIMS("custcode");
  const map = new Map();
  for (const r of partyRates || []) {
    const acc = canonicalCode(r.Acc_code ?? r.Acc_Code ?? r.acc_code);
    const item = canonicalCode(r.ItemDcode ?? r.Itemdcode ?? r.itemdcode);
    if (!acc || !item) continue;
    const name =
      r.acc_name ??
      r.Acc_Name ??
      (ledgerMap?.get(acc) ?? null);
    if (name == null || String(name).trim() === "" || name === "-") continue;
    const key = `${acc}__${item}`;
    if (!map.has(key)) map.set(key, String(name).trim());
  }
  return map;
}

/**
 * Packing-level customer when box / SA / dailyprod rows omit acc_code
 * (same IMS pack resolution as SA stickers via resolveStockAdjustmentPackingMeta).
 */
async function attachPackingCustomerFromMeta(rows = []) {
  const needMeta = rows.filter((row) => !pickAuditAccCode(row) && row?.packing_number);
  if (!needMeta.length) return rows;

  const groups = new Map();
  for (const row of needMeta) {
    const pn = String(row.packing_number).trim();
    const saId = row.sa_id != null ? Number(row.sa_id) : null;
    const itemDcode = row.item_dcode ?? row.itemdcode ?? null;
    const key = `${pn}|${saId ?? ""}|${itemDcode ?? ""}`;
    if (!groups.has(key)) groups.set(key, { pn, saId, itemDcode });
  }

  const metaByKey = new Map();
  await Promise.all(
    [...groups.entries()].map(async ([key, { pn, saId, itemDcode }]) => {
      try {
        const meta = await resolveStockAdjustmentPackingMeta(pn, {
          adjustment_id: Number.isFinite(saId) ? saId : null,
          item_dcode: itemDcode,
        });
        if (meta?.acc_code || meta?.acc_name) metaByKey.set(key, meta);
      } catch {
        /* optional IMS */
      }
    })
  );

  if (!metaByKey.size) return rows;

  return rows.map((row) => {
    if (pickAuditAccCode(row)) return row;
    const pn = String(row.packing_number ?? "").trim();
    if (!pn) return row;

    const saId = row.sa_id != null ? Number(row.sa_id) : null;
    const itemDcode = row.item_dcode ?? row.itemdcode ?? null;
    const key = `${pn}|${saId ?? ""}|${itemDcode ?? ""}`;
    const meta = metaByKey.get(key);
    if (!meta) return row;

    return normalizeSnapshotBox({
      ...row,
      item_dcode: row.item_dcode ?? meta.itemdcode ?? row.item_dcode,
      acc_code: meta.acc_code ?? row.acc_code,
      sa_acc_code: row.sa_acc_code ?? (saId && meta.acc_code ? meta.acc_code : row.sa_acc_code),
      acc_name: meta.acc_name ?? row.acc_name,
    });
  });
}

/** Backfill sa.acc_code for frozen snapshots / rows missing customer (SA boxes). */
async function attachSaAccCodesFromDb(rows = []) {
  const withSaId = rows.filter((row) => row?.sa_id != null);
  if (!withSaId.length) return rows;

  const saIds = [...new Set(withSaId.map((row) => Number(row.sa_id)).filter(Number.isFinite))];
  if (!saIds.length) return rows;

  const res = await dbQuery(
    `SELECT adjustment_id, NULLIF(TRIM(acc_code::text), '') AS acc_code
     FROM ${T.STOCK_ADJUSTMENT}
     WHERE adjustment_id = ANY($1::int[]) AND is_deleted = false`,
    [saIds]
  );

  const bySaId = new Map(
    (res || [])
      .map((row) => [Number(row.adjustment_id), row.acc_code ?? null])
      .filter(([, code]) => code)
  );
  if (!bySaId.size) return rows;

  return rows.map((row) => {
    const saId = Number(row.sa_id);
    const saAcc = bySaId.get(saId);
    if (!saAcc) return row;
    const sa_acc_code = String(saAcc).trim();
    const hasAcc =
      row.acc_code != null && String(row.acc_code).trim() !== "" && String(row.acc_code).trim() !== "-";
    return normalizeSnapshotBox({
      ...row,
      sa_acc_code,
      acc_code: hasAcc ? row.acc_code : sa_acc_code,
    });
  });
}

const normalizeUid = (uid) => String(uid || "").trim().toUpperCase();

export function parseScannedBoxes(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list
    .map((row) => ({
      box_no_uid: normalizeUid(row?.box_no_uid),
      scanned_at: row?.scanned_at ?? null,
      scanned_by: row?.scanned_by ?? null,
    }))
    .filter((row) => row.box_no_uid);
}

export function parseAssignmentHistory(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list
    .map((entry) => ({
      assignment_clone_id: entry?.assignment_clone_id ?? null,
      user_id: entry?.user_id != null ? Number(entry.user_id) : null,
      user_name: entry?.user_name ?? null,
      location_status: entry?.location_status ?? null,
      reassigned_at: entry?.reassigned_at ?? null,
      scan_count: Number(entry?.scan_count) || parseScannedBoxes(entry?.scanned_boxes).length,
      expected_boxes: parseExpectedBoxes(entry?.expected_boxes),
      scanned_boxes: parseScannedBoxes(entry?.scanned_boxes),
    }))
    .filter((entry) => entry.user_id != null);
}

/** Union of cloned history scans + active scanned_boxes (for comparison/count). */
export function getMergedScannedBoxes(rawLocation) {
  const loc = rawLocation && typeof rawLocation === "object" ? rawLocation : { scanned_boxes: rawLocation };
  const byUid = new Map();

  for (const entry of parseAssignmentHistory(loc.assignment_history)) {
    for (const row of entry.scanned_boxes || []) {
      if (row?.box_no_uid) byUid.set(row.box_no_uid, row);
    }
  }
  for (const row of parseScannedBoxes(loc.scanned_boxes)) {
    if (row?.box_no_uid) byUid.set(row.box_no_uid, row);
  }

  return [...byUid.values()].sort((a, b) => a.box_no_uid.localeCompare(b.box_no_uid));
}

export function parseExpectedBoxes(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === "string" ? JSON.parse(raw) : []);
  return list.map(normalizeSnapshotBox).filter((row) => row.box_no_uid);
}

/** Flatten location scanned_boxes for API consumers that expect audit.scans rows. */
export function flattenScansFromLocations(auditId, locations = []) {
  const scans = [];
  for (const loc of locations) {
    if (loc.is_active === false) continue;
    const locId = Number(loc.location_id);
    for (const row of parseScannedBoxes(loc.scanned_boxes)) {
      scans.push({
        audit_id: auditId,
        location_id: locId,
        location_no: loc.location_no ?? null,
        box_no_uid: row.box_no_uid,
        scanned_at: row.scanned_at,
        scanned_by: row.scanned_by,
      });
    }
  }
  return scans;
}

export function mergeScannedBoxes(existing = [], additions = [], scannedBy, scannedAt = new Date()) {
  const byUid = new Map();
  for (const row of parseScannedBoxes(existing)) {
    byUid.set(row.box_no_uid, row);
  }
  const at = scannedAt instanceof Date ? scannedAt.toISOString() : scannedAt;
  for (const uid of additions) {
    const key = normalizeUid(uid);
    if (!key) continue;
    if (!byUid.has(key)) {
      byUid.set(key, { box_no_uid: key, scanned_at: at, scanned_by: scannedBy ?? null });
    }
  }
  return [...byUid.values()].sort((a, b) => a.box_no_uid.localeCompare(b.box_no_uid));
}

export function removeScannedBox(existing = [], boxNoUid) {
  const key = normalizeUid(boxNoUid);
  return parseScannedBoxes(existing).filter((row) => row.box_no_uid !== key);
}

/** Compare expected snapshot vs scanned JSON for a location. */
export function compareLocationBoxSets(expected_boxes, scanned_boxes) {
  const expected = new Set(
    parseExpectedBoxes(expected_boxes).map((b) => normalizeUid(b.box_no_uid)).filter(Boolean)
  );
  const scanned = new Set(
    parseScannedBoxes(scanned_boxes).map((s) => normalizeUid(s.box_no_uid)).filter(Boolean)
  );

  const missing = [...expected].filter((uid) => !scanned.has(uid)).sort();
  const extra = [...scanned].filter((uid) => !expected.has(uid)).sort();
  const exact = missing.length === 0 && extra.length === 0 && expected.size === scanned.size;
  const pending = scanned.size < expected.size && extra.length === 0;

  return {
    exact,
    pending,
    mismatch: !exact && !pending,
    missing,
    extra,
    expected_count: expected.size,
    scanned_count: scanned.size,
  };
}

export function resolveLocationStatusAfterScan(comparison, { forceComplete = false } = {}) {
  if (comparison.exact) return "completed";
  if (forceComplete) return "mismatch";
  if (comparison.scanned_count > 0) return "draft";
  return "pending";
}

export function isLocationPending(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "pending").trim().toLowerCase()
    : String(statusOrLoc ?? "pending").trim().toLowerCase();
  return key === "pending";
}

export function isLocationDraft(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "").trim().toLowerCase()
    : String(statusOrLoc ?? "").trim().toLowerCase();
  return key === "draft";
}

/** Location still open for scanning / edits (not finalized). */
export function isLocationEditable(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "pending").trim().toLowerCase()
    : String(statusOrLoc ?? "pending").trim().toLowerCase();
  return key === "pending" || key === "draft";
}

export function isLocationClosed(statusOrLoc) {
  const key = typeof statusOrLoc === "object"
    ? String(statusOrLoc?.status ?? "").trim().toLowerCase()
    : String(statusOrLoc ?? "").trim().toLowerCase();
  return key === "completed" || key === "mismatch";
}
