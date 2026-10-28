/**
 * Prime Item helpers — used by Shortage → Prime Item tab and Maintain Job Card.
 *
 * ims_shortage.is_accepted: NULL = Pending | TRUE = Accepted | FALSE = Rejected
 *
 * Prime item is NOT stored in the DB. It comes from the IMS item master (item → primitemdcode),
 * so the flow is:
 *   1. loadProductionShortages()  → rows from DB + IMS details (item code, prime item, weight)
 *   2. groupByPrimeItem(rows)     → one row per prime item, its entries inside `children`
 */
import dbQuery from "../../../../../config/db/db.js";
import { IMS_TABLES, PRODUCTION_TABLES } from "../../../../../config/db/dbTables.js";
import { canonicalCode } from "../../../../ims/lib/utils/erp-api/lookup/imsLookup.js";
import { SHORTAGE_LIST_TYPES, fromDateSql } from "../shortage.config.js";
import { PRODUCTION_GROUP_NAME } from "../../../lib/config/groupFilter.js";
import { enrichShortageRows } from "../controllers/shortage.controller.js";
import { loadPrimeProcesses, shortageFullyApprovedSql, JOB_CARD_TYPE } from "../../jc/models/jobCard.model.js";
import { rmItemMap } from "../../../../rmstore/modules/production/utils/erpItems.js";
import { RMSTORE_TABLES as R } from "../../../../../config/db/dbTables.js";
import { issueQtyKg } from "../../jc/jobCard.config.js";

/* ───────────────────────── Status ───────────────────────── */

export const PRIME_STATUSES = ["pending", "accepted", "rejected"];

const STATUS_SQL = {
  pending: "is_accepted IS NULL",
  accepted: "is_accepted = true",
  rejected: "is_accepted = false",
};

/** "pending" → "s.is_accepted IS NULL". Pass alias "" for UPDATE statements. */
export function primeStatusSql(status, alias = "s") {
  const key = status === "approved" ? "accepted" : status;
  const sql = STATUS_SQL[key] || STATUS_SQL.pending;
  return alias ? `${alias}.${sql}` : sql;
}

/** Row status from is_accepted: NULL → pending, true → accepted, false → rejected. */
export function primeStatusOf(row) {
  if (row?.is_accepted === true) return "accepted";
  if (row?.is_accepted === false) return "rejected";
  return "pending";
}

/* ───────────────────────── Scope ───────────────────────── */

/** Shortage on an authorized job card (ims_shortage.docno = jc.docno). */
export function shortageOnAuthorizedJobCardSql(alias = "s", type = JOB_CARD_TYPE.JC) {
  return `EXISTS (
    SELECT 1 FROM ${PRODUCTION_TABLES.JC} jc
    WHERE jc.is_deleted = false AND jc.type = ${Number(type)} AND jc.approved = true
      AND ${alias}.docno = jc.docno
  )`;
}

/** Latest open JC per prime → job_card_no on pending group (Register authorize step removed). */
export async function attachOpenJobCardNo(groups = [], type = JOB_CARD_TYPE.JC) {
  const primes = [...new Set(groups.map((g) => Number(g.prime_key || g.id)).filter(Boolean))];
  if (!primes.length) return;
  const rows = await dbQuery(
    `SELECT DISTINCT ON (jc.itemdcode) jc.itemdcode, jc.docno, jc.pjobcardno, jc.process_plan, jc.jobcardno
     FROM ${PRODUCTION_TABLES.JC} jc
     WHERE jc.is_deleted = false AND jc.type = $1 AND jc.itemdcode = ANY($2::int[])
       AND EXISTS (
         SELECT 1 FROM ${IMS_TABLES.SHORTAGE} s
         WHERE s.docno = jc.docno AND s.is_accepted = true AND COALESCE(s.is_deleted, false) = false
       )
     ORDER BY jc.itemdcode, jc.docno DESC`,
    [Number(type), primes]
  );
  const byPrime = new Map((rows || []).map((r) => [Number(r.itemdcode), r]));
  for (const g of groups) {
    const jc = byPrime.get(Number(g.prime_key || g.id));
    if (!jc) continue;
    if (jc.pjobcardno) g.job_card_no = jc.pjobcardno;
    g.docno = jc.docno;
    const plan = jc.process_plan;
    g.jc_has_plan = Array.isArray(plan) ? plan.length > 0 : Boolean(plan && typeof plan === "object" && Object.keys(plan).length);
  }
}

/** JS check: row belongs to Production (same rule as the SQL in loadProductionShortages). */
export function isProductionScopeRow(row) {
  if (!row || row.is_deleted === true) return false;
  const typeOk = SHORTAGE_LIST_TYPES.includes(String(row.type ?? "").trim());
  const groupOk = String(row.grpname ?? "").trim().toLowerCase() === PRODUCTION_GROUP_NAME.toLowerCase();
  return typeOk && groupOk;
}

/* ───────────────────────── Step 1: load rows ───────────────────────── */

/**
 * Production shortage rows + IMS details.
 * `where` = extra SQL conditions, e.g. [primeStatusSql("pending")].
 *
 * Each returned row has: id, itemdcode, qty, type, month, is_accepted, accepted_remark, ...
 *   + from IMS: item_code, item_desc, primitemdcode, primitem_code, primitemdesc, gweight
 *   + weight_kg = Issue Qty = (gweight × qty) + 10%
 */
export async function loadProductionShortages(where = []) {
  const conditions = [
    "s.is_deleted = false",
    "s.type = ANY($1::text[])", // PPC / Additional
    "LOWER(TRIM(COALESCE(s.grpname, ''))) = LOWER($2)", // Production group
    fromDateSql("s"), // only entries from SHORTAGE_FROM_DATE
    ...where,
  ];

  const rows = await dbQuery(
    `SELECT s.id, s.itemdcode, s.itemcode, s.grpname, s.type, s.qty, s.month, s.remarks, s.approved, s.is_accepted, s.accepted_remark, s.created_by, s.created_at
     FROM ${IMS_TABLES.SHORTAGE} s
     WHERE ${conditions.join(" AND ")}
     ORDER BY s.id DESC`,
    [SHORTAGE_LIST_TYPES, PRODUCTION_GROUP_NAME]
  );

  // Adds item_code / item_desc / prime item / gweight from IMS item master (cached).
  const enriched = await enrichShortageRows(rows || []);

  const result = [];
  for (const row of enriched) {
    const gweight = toNumberOrNull(row.gweight ?? row.item_weight);
    const weightKg = issueQtyKg(gweight, row.qty);
    result.push({ ...row, item_weight: gweight, gweight, weight_kg: weightKg });
  }

  return result;
}

/* ───────────────────────── Step 2: group by prime item ───────────────────────── */

/** Group key = prime item dcode. Item without a prime item in IMS = its own prime item. */
export function primeKeyOf(row) {
  return canonicalCode(row?.primitemdcode) || canonicalCode(row?.itemdcode);
}

/**
 * Example — 4 rows, all with prime HN013:
 *   HN013 6000, HN013 4000, HN013AB 4870, HN013TW 4352
 * → 1 group:
 *   { prime_item_code: "HN013", entry_count: 4, total_qty: 19222,
 *     items: [HN013 (10000), HN013AB (4870), HN013TW (4352)], children: [the 4 rows] }
 */
export function groupByPrimeItem(rows = []) {
  // 1) put every row into its prime item's group
  const groups = new Map();
  for (const row of rows) {
    const key = primeKeyOf(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, newGroup(key, row));
    groups.get(key).children.push(row);
  }

  // 2) fill totals for each group
  const result = [];
  for (const group of groups.values()) {
    fillGroupTotals(group);
    result.push(group);
  }

  // 3) sort by prime item code (HN013, HN014 …)
  result.sort((a, b) => compareCode(a.prime_item_code, b.prime_item_code));

  return result;
}

/** Empty group — names / description come from the first row of that prime item. */
function newGroup(key, row) {
  const hasPrime = Boolean(canonicalCode(row.primitemdcode));
  return {
    id: `prime-${key}`,
    prime_key: key,
    prime_item_code: (hasPrime ? row.primitem_code : row.item_code) || row.itemcode || key,
    prime_item_desc: (hasPrime ? row.primitemdesc : row.item_desc) || null,
    has_prime: hasPrime,
    children: [],
  };
}

/** Totals for the parent row: qty, required qty, item-wise list, remark. */
function fillGroupTotals(group) {
  const children = group.children;

  group.entry_count = children.length;
  group.total_qty = sum(children.map((c) => c.qty));

  // Required Qty (KG) = (prime gweight × total qty) + extra % — one simple formula.
  const primeRow = children.find((c) => canonicalCode(c.itemdcode) === group.prime_key) || children[0];
  group.gweight = toNumberOrNull(primeRow?.gweight ?? primeRow?.item_weight);
  group.total_weight_kg = issueQtyKg(group.gweight, group.total_qty);
  group.weight_missing = group.total_weight_kg == null;

  group.items = buildItemList(children, group.prime_key);
  group.item_count = group.items.length;
  group.item_codes = group.items.map((it) => it.item_code).filter(Boolean);

  // All entries are approved / rejected together, so normally there is one remark.
  const remarks = children.map((c) => String(c.accepted_remark ?? "").trim()).filter(Boolean);
  group.accepted_remark = [...new Set(remarks)].join(" | ") || null;
}

/** Same item's entries added together → [{ item_code: "HN013", qty: 10000, weight_kg, ... }]. Prime item first. */
function buildItemList(children, primeKey) {
  const byItem = new Map();

  for (const c of children) {
    const key = String(c.itemdcode);
    if (!byItem.has(key)) {
      byItem.set(key, {
        itemdcode: c.itemdcode,
        item_code: c.item_code || c.itemcode || key,
        item_weight: c.item_weight ?? null,
        gweight: c.gweight ?? c.item_weight ?? null,
        qty: 0,
        weight_kg: 0,
        weight_missing: false,
      });
    }
    const item = byItem.get(key);
    item.qty += Number(c.qty) || 0;
    if (c.weight_kg == null) item.weight_missing = true;
    else item.weight_kg = round2(item.weight_kg + c.weight_kg);
  }

  const items = [...byItem.values()];
  items.sort((a, b) => {
    const aIsPrime = String(a.itemdcode) === primeKey;
    const bIsPrime = String(b.itemdcode) === primeKey;
    if (aIsPrime !== bIsPrime) return aIsPrime ? -1 : 1;
    return compareCode(a.item_code, b.item_code);
  });
  return items;
}

function compact(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === "") continue;
    if (k === "weight_missing" && v === false) continue;
    out[k] = v;
  }
  return out;
}

/** Tooling list shape — one row per prime item, totals only. */
function slimPrimeTotals(group) {
  return compact({
    prime_key: group.prime_key,
    prime_item_code: group.prime_item_code,
    prime_item_desc: group.prime_item_desc ?? null,
    total_qty: group.total_qty ?? 0,
    gweight: group.gweight ?? null,
    total_weight_kg: group.total_weight_kg ?? null,
    weight_missing: Boolean(group.weight_missing),
  });
}

export function slimShortageChild(row) {
  return compact({
    id: row.id,
    itemdcode: row.itemdcode,
    item_code: row.item_code || row.itemcode || null,
    item_desc: row.item_desc ?? null,
    qty: row.qty,
    type: row.type ?? null,
    month: row.month ?? null,
    weight_kg: row.weight_kg ?? null,
    item_weight: row.item_weight ?? null,
    remarks: row.remarks ?? null,
    accepted_remark: row.accepted_remark ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
  });
}

/** Shortage → Prime Item list — item-wise totals for table/drawer; line detail loads on expand. */
export function slimPrimeGroup(group, { id, status } = {}) {
  return compact({
    ...slimPrimeTotals(group),
    id: id ?? group.id,
    entry_count: group.entry_count ?? 0,
    accepted_remark: group.accepted_remark ?? null,
    item_codes: group.item_codes ?? [],
    items: (group.items ?? []).map((it) =>
      compact({
        itemdcode: it.itemdcode,
        item_code: it.item_code,
        qty: it.qty,
        item_weight: it.item_weight ?? null,
        weight_kg: it.weight_kg ?? null,
        weight_missing: it.weight_missing,
      })
    ),
    status,
  });
}

/** Expand row — shortage lines for one prime item (+ optional status filter). */
export async function loadPrimeItemChildren(primeKey, status) {
  const key = canonicalCode(primeKey);
  if (!key) return [];
  const statusKey = status === "approved" ? "accepted" : status;
  let rows = await loadProductionShortages(statusKey && PRIME_STATUSES.includes(statusKey) ? [primeStatusSql(statusKey)] : []);
  rows = rows.filter((r) => primeKeyOf(r) === key);
  return rows.map(slimShortageChild);
}

/** Maintain Job Card pending — Tooling-sized row + ids for create. */
export function slimJobCardPendingGroup(group) {
  const children = group.children ?? [];
  const allAccepted = children.length > 0 && children.every((c) => c.is_accepted === true);
  return compact({
    ...slimPrimeTotals(group),
    id: String(group.prime_key),
    item_codes: group.item_codes ?? [],
    items: group.items ?? [],
    shortage_ids: children.map((c) => c.id),
    gweight: group.gweight ?? null,
    status: allAccepted ? "accepted" : "pending",
    job_card_no: group.job_card_no ?? null,
    docno: group.docno ?? null,
    jc_has_plan: group.jc_has_plan ?? false,
  });
}

/** True when any prime-process step has tooling ON (same rule as `process_tooling` on list rows). */
export function primeProcessRequiresTooling(stages = []) {
  return (stages || []).some((s) => (s.processes || []).some((p) => p.tooling === true));
}

/**
 * Prime Process Master flags for Job Card list: `rm`, `process_tooling` (any step with rm_wire / tooling ON).
 * Optional `wireList` fills process RM codes (legacy); Job Card drawer RM uses Production attach instead.
 */
export async function attachRmWireFromPrimeProcess(groups = [], { wireList = false } = {}) {
  if (!groups.length) return;

  const keys = [...new Set(groups.map((g) => Number(g.prime_key)).filter(Boolean))];
  if (!keys.length) return;

  const primeProcesses = await loadPrimeProcesses(keys);
  let defaultRmByPrime;
  let rmMap;
  if (wireList) {
    [rmMap, defaultRmByPrime] = await Promise.all([
      rmItemMap(),
      dbQuery(
        `SELECT item_dcode, rm_items FROM ${R.MASTER_PRODUCTION} WHERE item_dcode = ANY($1::int[]) AND is_deleted = false`,
        [keys]
      ).then((prodRows) => new Map(prodRows.map((r) => [Number(r.item_dcode), Array.isArray(r.rm_items) ? r.rm_items : []]))),
    ]);
  }

  for (const g of groups) {
    const key = Number(g.prime_key);
    const stageList = primeProcesses.get(key);
    if (!stageList?.length) {
      g.rm = null;
      g.process_tooling = null;
      if (wireList) g.rm_wire_items = [];
      continue;
    }

    const processes = stageList.flatMap((s) => s.processes || []);
    g.rm = processes.some((p) => p.rm_wire === true);
    g.process_tooling = primeProcessRequiresTooling(stageList);
    if (!wireList) continue;

    let items = processes
      .filter((p) => p.rm_wire)
      .flatMap((p) => p.rm_items || [])
      .map((r) => ({
        rm_item_code: r.rm_item_code || null,
        rm_item_desc: r.rm_item_desc ?? null,
      }))
      .filter((r) => r.rm_item_code);

    if (g.rm && !items.length) {
      items = mapProductionRmItems(defaultRmByPrime.get(key), rmMap);
    }

    g.rm_wire_items = dedupeRmWireItems(items).map((r) => r.rm_item_code);
  }
}

/**
 * Shortage → Prime Item (view): RM wire list from RM Store Production master for the prime item.
 */
/** @param setRmFlag — when false, only `rm_wire_items` + `production_rm` (Job Card drawer); leaves `rm` for process attach. */
export async function attachRmWireFromProduction(groups = [], { wireList = true, setRmFlag = true } = {}) {
  if (!groups.length) return;

  const keys = [...new Set(groups.map((g) => Number(g.prime_key)).filter(Boolean))];
  if (!keys.length) return;

  const prodRows = await dbQuery(
    `SELECT item_dcode, rm_items FROM ${R.MASTER_PRODUCTION} WHERE item_dcode = ANY($1::int[]) AND is_deleted = false`,
    [keys]
  );
  const byPrime = new Map(prodRows.map((r) => [Number(r.item_dcode), Array.isArray(r.rm_items) ? r.rm_items : []]));

  const rmMap = wireList ? await rmItemMap() : null;

  for (const g of groups) {
    const key = Number(g.prime_key);
    if (!byPrime.has(key)) {
      if (setRmFlag) g.rm = null;
      else g.production_rm = null;
      if (wireList) g.rm_wire_items = [];
      continue;
    }
    if (wireList) {
      g.rm_wire_items = dedupeRmWireItems(mapProductionRmItems(byPrime.get(key), rmMap));
      const hasWire = g.rm_wire_items.length > 0;
      if (setRmFlag) g.rm = hasWire;
      else g.production_rm = hasWire;
    } else if (setRmFlag) {
      g.rm = (byPrime.get(key) || []).length > 0;
    } else {
      g.production_rm = (byPrime.get(key) || []).length > 0;
    }
  }
}

/* ───────────────────────── Small helpers ───────────────────────── */

function mapProductionRmItems(rmList, rmMap) {
  return (rmList || [])
    .map((rm) => {
      const live = rmMap.get(canonicalCode(rm.rm_item_dcode));
      const rm_item_code = live?.item_code || rm.rm_item_code || null;
      if (!rm_item_code) return null;
      return { rm_item_code, rm_item_desc: live?.item_desc ?? rm.rm_item_desc ?? null };
    })
    .filter(Boolean);
}

function dedupeRmWireItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const code = it.rm_item_code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(it);
  }
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Sum numbers, ignoring null / non-numbers. */
function sum(values) {
  let total = 0;
  for (const v of values) total += Number(v) || 0;
  return total;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "HN2" before "HN10" (numeric-aware). */
function compareCode(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}
