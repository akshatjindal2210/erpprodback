import { findJobCardFgByPjobcardno } from "../../issue-request/models/issueRequestJobCard.model.js";
import { isIssuedToShopFloor } from "../../../lib/utils/saMinusInventory.js";

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
    const part = buildSplit({
      fg: targetFg,
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
  if (row.reassign) return reassignFgWireSplits(row);
  if (isIssuedToShopFloor(row)) return shopFloorFgWireSplit(row);
  return {};
}
