import { findJobCardFgByPjobcardno } from "../../issue-request/models/issueRequestJobCard.model.js";
import { isIssuedToShopFloor } from "../../../lib/utils/saMinusInventory.js";
import { findProductionJcMetaByPjobcardnos, productionJcMetaKey } from "../../production/utils/erpItems.js";

function coilWireUnit(row) {
  const u = String(row?.it_unit || "kg").trim();
  return u || "kg";
}

function wireQtyLabel(qty, unit) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return null;
  return { wire_qty: q, wire_unit: unit, wire_qty_label: `${q} ${unit}` };
}

function buildSplit({ fg, qty, unit, pjobcardno, kind }) {
  if (!fg?.fg_item_code) return null;
  const wire = wireQtyLabel(qty, unit);
  if (!wire) return null;
  return {
    fg_item_code: fg.fg_item_code,
    fg_item_desc: fg.fg_item_desc ?? null,
    pjobcardno: pjobcardno || null,
    kind,
    ...wire,
  };
}

function summaryFromSplits(splits) {
  const codeParts = splits.map((s) => {
    const cut =
      s.kind === "consumed" ? "cut" : s.kind === "balance" ? "balance" : "on job";
    return `${s.fg_item_code} · wire ${cut} ${s.wire_qty_label}`;
  });
  const descParts = [];
  for (const s of splits) {
    const d = s.fg_item_desc ? String(s.fg_item_desc).trim() : "";
    if (!d) continue;
    if (descParts.some((x) => x.toUpperCase() === d.toUpperCase())) continue;
    descParts.push(d);
  }
  return {
    fg_item_code: codeParts.join(", "),
    fg_item_desc: descParts.length ? descParts.join("; ") : null,
    fg_wire_splits: splits,
  };
}

function jobCardAssignments(row) {
  return (Array.isArray(row?.job_card_assignments) ? row.job_card_assignments : []).filter((a) =>
    String(a?.pjobcardno || "").trim()
  );
}

function fgFromProdMeta(prodMap, jc) {
  const hit = prodMap.get(productionJcMetaKey(jc));
  if (!hit?.fg_item_code) return null;
  return { fg_item_code: hit.fg_item_code, fg_item_desc: hit.fg_item_desc ?? null };
}

/** Full reassign chain — one FG split per job_card_assignments hop (Coil Finder History). */
async function fgWireSplitsFromJobCardAssignments(row) {
  const assignments = jobCardAssignments(row);
  if (!assignments.length) return null;

  const multiHop = assignments.length > 1 || row.reassign === true;
  const status = String(row?.status || "active").toLowerCase();
  if (!multiHop && status !== "consumed") return null;

  const unit = coilWireUnit(row);
  const jcs = [...new Set(assignments.map((a) => String(a.pjobcardno).trim()).filter(Boolean))];
  const prodMap = jcs.length ? await findProductionJcMetaByPjobcardnos(jcs) : new Map();

  const fgCache = new Map();
  const resolveFg = async (jc) => {
    const key = productionJcMetaKey(jc);
    if (fgCache.has(key)) return fgCache.get(key);
    let fg = fgFromProdMeta(prodMap, jc);
    if (!fg?.fg_item_code) fg = await findJobCardFgByPjobcardno(jc);
    fgCache.set(key, fg || null);
    return fg;
  };

  const splits = [];
  for (const a of assignments) {
    const jc = String(a.pjobcardno).trim();
    const fg = await resolveFg(jc);
    const part = buildSplit({
      fg,
      qty: a.qty,
      unit,
      pjobcardno: jc,
      kind: a.kind || "on_job",
    });
    if (part) splits.push(part);
  }

  if (!splits.length) return null;
  return summaryFromSplits(splits);
}

/** Reassign: FG + wire qty cut on source JC and balance on target JC. */
async function reassignFgWireSplits(row) {
  const unit = coilWireUnit(row);
  const source = String(row.reassign_source_pjobcardno || "").trim();
  const target = String(row.reassign_target_pjobcardno || row.pjobcardno || "").trim();
  const consumed = Number(row.reassign_consumed_qty);
  const balance = Number(row.reassign_balance_qty ?? row.qty);

  const [sourceFg, targetFg] = await Promise.all([
    source ? findJobCardFgByPjobcardno(source) : null,
    target ? findJobCardFgByPjobcardno(target) : null,
  ]);

  const splits = [];
  if (consumed > 0) {
    const part = buildSplit({
      fg: sourceFg,
      qty: consumed,
      unit,
      pjobcardno: source,
      kind: "consumed",
    });
    if (part) splits.push(part);
  }
  if (balance > 0) {
    const fgBalance = sourceFg?.fg_item_code ? sourceFg : targetFg;
    const part = buildSplit({
      fg: fgBalance,
      qty: balance,
      unit,
      pjobcardno: target,
      kind: "balance",
    });
    if (part) splits.push(part);
  }

  if (!splits.length) return {};
  return summaryFromSplits(splits);
}

/** Single shop-floor job: full coil qty on one FG. */
function shopFloorFgWireSplit(row) {
  const code = String(row.fg_item_code || "").trim();
  if (!code) return {};
  const unit = coilWireUnit(row);
  const split = buildSplit({
    fg: { fg_item_code: code, fg_item_desc: row.fg_item_desc ?? null },
    qty: row.qty,
    unit,
    pjobcardno: row.pjobcardno,
    kind: "on_job",
  });
  if (!split) return {};
  return summaryFromSplits([split]);
}

/** Coil Finder FG header: wire cut / balance qty per FG (reassign + normal shop floor). */
export async function enrichCoilFgForReassign(row) {
  if (!row) return {};

  const fromChain = await fgWireSplitsFromJobCardAssignments(row);
  if (fromChain?.fg_wire_splits?.length) return fromChain;

  if (row.reassign) return reassignFgWireSplits(row);
  if (isIssuedToShopFloor(row)) return shopFloorFgWireSplit(row);
  return {};
}
