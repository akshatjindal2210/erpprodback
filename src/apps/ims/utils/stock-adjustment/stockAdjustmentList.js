/**
 * Stock Adjustment — list query + row enrich for API responses.
 *
 * Table: ims_stock_adjustment (s)
 * Joins: users for created / updated / approved names
 *
 * Filters: adjustment_id, item_dcode, approved, entry_type, packing_number, acc_code, dates
 * Search:  adj id, item, packing, fin year, remarks, customer code, entry type
 */

import dbQuery from "../../../../config/db.js";
import { MST_TABLES as M } from "../../../../config/dbTables.js";
import { buildImsDocFilter, findImsPackByDocNo, imsPackRowToProduction } from "../erp-api/imsPackRow.js";
import { fetchFromIMS, fetchPackRowsForFinancialYearDoc } from "../../services/ims.service.js";
import { findCustomerHintsForPackings } from "../../models/inventoryReport.model.js";
import { buildPartyRateAccNameMap, lookupPartyRateAccName } from "../packing-entry/packingEntryCustomers.js";
import { canonicalCode, getImsMapsSafe, getImsPartyRateMapSafe, pickPartyRateCustCode } from "../erp-api/imsLookup.js";
import { applyMinusCustomerEnrichment, buildMinusCustomerLinesByAdjustmentId } from "./stockAdjustmentMinusEnrich.js";

const ALLOWED_FILTER_FIELDS = [
  "adjustment_id",
  "item_dcode",
  "approved",
  "is_deleted",
  "from_date",
  "to_date",
  "entry_type",
  "packing_number",
  "acc_code",
];

const ALLOWED_SORT_FIELDS = [
  "adjustment_id",
  "item_dcode",
  "qty",
  "created_at",
  "approved",
  "entry_type",
  "packing_number",
  "acc_code",
];

const USER_JOINS = `
  LEFT JOIN ${M.USERS} u_cr ON s.created_by = u_cr.id
  LEFT JOIN ${M.USERS} u_up ON s.updated_by = u_up.id
  LEFT JOIN ${M.USERS} u_ap ON s.approved_by = u_ap.id
`;

const DEFAULT_SELECT = [
  "s.*",
  "s.item_dcode::text AS item_code",
  "u_cr.name AS created_by_name",
  "u_up.name AS updated_by_name",
  "u_ap.name AS approved_by_name",
];

function assertField(key, whitelist, context = "field") {
  if (!whitelist.includes(key)) throw new Error(`Invalid ${context}: "${key}"`);
}

function buildListWhere({ filters = {}, search, permission = {} }) {
  const values = [];
  let paramIdx = 1;
  const conditions = ["s.is_deleted = false"];

  if (permission?.can_view_days > 0) {
    conditions.push(`s.created_at >= CURRENT_DATE - INTERVAL '${permission.can_view_days - 1} days'`);
  }

  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === "") continue;

    if (key === "from_date" || key === "fromDate") {
      values.push(val);
      conditions.push(`s.created_at >= $${paramIdx++}`);
      continue;
    }
    if (key === "to_date" || key === "toDate") {
      values.push(val);
      conditions.push(`s.created_at <= $${paramIdx++}`);
      continue;
    }

    assertField(key, ALLOWED_FILTER_FIELDS, "filter field");
    values.push(val);
    conditions.push(`s.${key} = $${paramIdx++}`);
  }

  const searchText = search != null ? String(search).trim() : "";
  if (searchText) {
    values.push(`%${searchText}%`);
    const idx = paramIdx++;
    conditions.push(`(
      s.adjustment_id::text ILIKE $${idx} OR
      CAST(s.item_dcode AS TEXT) ILIKE $${idx} OR
      s.remarks ILIKE $${idx} OR
      COALESCE(s.packing_number::text, '') ILIKE $${idx} OR
      COALESCE(s.financial_year::text, '') ILIKE $${idx} OR
      COALESCE(s.acc_code::text, '') ILIKE $${idx} OR
      COALESCE(s.entry_type::text, '') ILIKE $${idx} OR
      u_cr.name ILIKE $${idx} OR
      u_ap.name ILIKE $${idx}
    )`);
  }

  return { whereClause: `WHERE ${conditions.join(" AND ")}`, values, nextParamIdx: paramIdx };
}

function resolveSelectFields(fields = []) {
  if (!fields.length) return DEFAULT_SELECT.join(", ");
  return fields
    .map((f) => {
      if (f === "item_code") return "s.item_dcode::text AS item_code";
      if (f === "created_by_name") return "u_cr.name AS created_by_name";
      if (f === "updated_by_name") return "u_up.name AS updated_by_name";
      if (f === "approved_by_name") return "u_ap.name AS approved_by_name";
      return `s.${f}`;
    })
    .join(", ");
}

export async function findAdjustments(options = {}) {
  const {
    filters = {},
    fields = [],
    sort = {},
    page = 1,
    limit = 10,
    search = null,
    permission = {},
  } = options;

  const { whereClause, values, nextParamIdx } = buildListWhere({ filters, search, permission });
  const selectFields = resolveSelectFields(fields);

  const safeSortBy = ALLOWED_SORT_FIELDS.includes(sort.by) ? sort.by : "adjustment_id";
  const safeSortOrder = sort.order?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit, 10) || 10));
  const offset = (safePage - 1) * safeLimit;

  const [{ count }] = await dbQuery(
    `SELECT COUNT(*) AS count FROM ims_stock_adjustment s ${USER_JOINS} ${whereClause}`,
    values
  );

  const limitIdx = nextParamIdx;
  const offsetIdx = nextParamIdx + 1;
  const rows = await dbQuery(
    `SELECT ${selectFields}
     FROM ims_stock_adjustment s
     ${USER_JOINS}
     ${whereClause}
     ORDER BY s.${safeSortBy} ${safeSortOrder}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...values, safeLimit, offset]
  );

  return {
    data: rows,
    total: parseInt(count, 10) || 0,
    page: safePage,
    limit: safeLimit,
  };
}

async function fillCustomerHintsFromIms(rows, hintMap, fyHintMap) {
  const missingAccRows = rows.filter((r) => {
    const pn = String(r.packing_number || "").trim();
    return pn && !r.acc_code && !hintMap.get(pn);
  });
  if (!missingAccRows.length) return;

  const uniqueMissing = [
    ...new Map(
      missingAccRows.map((r) => {
        const fy = String(r.financial_year || fyHintMap.get(String(r.packing_number || "").trim()) || "").trim();
        return [String(r.packing_number).trim(), { pn: r.packing_number, fy }];
      })
    ).values(),
  ].filter((x) => x.pn);

  await Promise.all(
    uniqueMissing.map(async ({ pn, fy }) => {
      try {
        let acc = null;
        if (fy) {
          const imsRes = await fetchPackRowsForFinancialYearDoc(fy, pn);
          if (imsRes?.success && imsRes.records?.length > 0) {
            acc = imsRes.records[0].acc_code;
          }
        }
        if (!acc) {
          const filter = buildImsDocFilter(pn);
          const records = filter ? await fetchFromIMS("pack", filter) : [];
          const matched = findImsPackByDocNo(records, pn);
          const prod = imsPackRowToProduction(matched);
          if (prod?.acc_code) acc = prod.acc_code;
        }
        if (acc) hintMap.set(String(pn).trim(), String(acc).trim());
      } catch {
        /* ignore IMS lookup errors for list enrich */
      }
    })
  );
}

/** List/detail enrich — item, customer, minus customer breakdown. */
export async function enrichStockAdjustmentListRows(rows = [], options = {}) {
  const listView = options?.listView === true;
  if (!rows?.length) return rows || [];

  const emptyMap = new Map();
  const [{ itemMap, ledgerMap }, partyRateMap, partyRateAccNameMap] = await Promise.all([
    getImsMapsSafe(),
    listView ? Promise.resolve(emptyMap) : getImsPartyRateMapSafe(),
    listView ? Promise.resolve(emptyMap) : buildPartyRateAccNameMap(),
  ]);

  const packingNums = listView
    ? [
        ...new Set(
          rows
            .filter((r) => {
              const pn = String(r.packing_number || "").trim();
              const acc = r.acc_code != null ? String(r.acc_code).trim() : "";
              return pn && !acc;
            })
            .map((r) => String(r.packing_number).trim())
        ),
      ]
    : [...new Set(rows.map((r) => String(r.packing_number || "").trim()).filter(Boolean))];

  const hints = packingNums.length > 0 ? await findCustomerHintsForPackings(packingNums) : [];
  const hintMap = new Map(hints.map((h) => [String(h.packing_number), h.customer_code]));
  const fyHintMap = new Map(hints.map((h) => [String(h.packing_number), h.financial_year]));

  if (!listView) {
    await fillCustomerHintsFromIms(rows, hintMap, fyHintMap);
  }

  const minusLinesMap = await buildMinusCustomerLinesByAdjustmentId(rows, ledgerMap);

  return rows.map((row) => {
    const itemDcode = canonicalCode(row.item_dcode);
    const pn = String(row.packing_number || "").trim();
    const rawAccCode = row.acc_code || hintMap.get(pn);
    const accCode = canonicalCode(rawAccCode);

    const item = itemDcode ? itemMap.get(itemDcode) : null;
    const ledgerName = accCode ? ledgerMap.get(accCode) : null;
    const partyRateName = listView
      ? null
      : lookupPartyRateAccName(partyRateAccNameMap, accCode, itemDcode);
    const partyRate = listView
      ? null
      : pickPartyRateCustCode(partyRateMap, itemDcode || row.item_code, [accCode]);

    const existingName =
      row.acc_name && String(row.acc_name).trim() !== "" && String(row.acc_name).trim() !== "—"
        ? String(row.acc_name).trim()
        : null;

    const base = {
      ...row,
      item_code: item?.item_code ?? row.item_code ?? null,
      item_desc: item?.item_desc ?? row.item_desc ?? null,
      acc_code: rawAccCode,
      acc_name: ledgerName ?? partyRateName ?? existingName ?? null,
      party_rate_cust_code: partyRate ?? row.party_rate_cust_code ?? null,
    };

    const minusLines = minusLinesMap.get(row.adjustment_id);
    if (row.entry_type === "minus" && minusLines?.length) {
      return applyMinusCustomerEnrichment(base, minusLines);
    }
    return base;
  });
}
