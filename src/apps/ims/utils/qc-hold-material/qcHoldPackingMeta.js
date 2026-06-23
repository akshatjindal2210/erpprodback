import { findInHandBoxesByPackingNumber, findDispatchedOutwardLinesByPacking } from "../../models/box.model.js";
import { findForwardedQtyByItemAndPacking } from "../../models/forwardingNote.model.js";
import { resolveStockAdjustmentPackingMeta } from "../stock-adjustment/stockAdjustmentPacking.js";
import { isBoxOnQcHold } from "../box/boxInventory.js";
import { enrichRowsWithIMS } from "../erp-api/imsLookup.js";

function sumQty(boxes = []) {
  return boxes.reduce((s, b) => s + (Number(b.qty) || 0), 0);
}

function primaryStoreLocation(boxes = []) {
  const withLoc = boxes.find(
    (b) => b?.location_no != null && String(b.location_no).trim() !== ""
  );
  return withLoc?.location_no ? String(withLoc.location_no).trim() : null;
}

async function enrichDispatchLines(lines = [], packingMeta = null) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!list.length) return [];

  const enriched = await enrichRowsWithIMS(
    list.map((row) => {
      const overrideRaw =
        row.override_cust != null && String(row.override_cust).trim() !== ""
          ? String(row.override_cust).trim()
          : null;
      const overrideAsCode = overrideRaw && /^\d+$/.test(overrideRaw) ? overrideRaw : null;
      return {
        ...row,
        itemdcode: row.item_dcode ?? packingMeta?.itemdcode ?? packingMeta?.item_dcode ?? null,
        item_dcode: row.item_dcode ?? packingMeta?.itemdcode ?? packingMeta?.item_dcode ?? null,
        acc_code: row.acc_code ?? overrideAsCode ?? packingMeta?.acc_code ?? null,
      };
    }),
    {
      itemCodeField: "item_dcode",
      itemCodeOut: "item_code",
      itemDescOut: "item_desc",
      accCodeField: "acc_code",
      accNameOut: "acc_name",
    }
  );

  return (enriched || []).map((row) => {
    const overrideCust =
      row.override_cust != null && String(row.override_cust).trim() !== ""
        ? String(row.override_cust).trim()
        : null;
    const itemCode =
      row.item_code ??
      packingMeta?.item_code ??
      null;
    const itemDesc =
      row.item_desc ??
      packingMeta?.item_desc ??
      null;
    return {
      out_uid: row.out_uid != null ? Number(row.out_uid) : null,
      fuid: row.fuid != null ? Number(row.fuid) : null,
      entry_type: row.entry_type ?? null,
      acc_code: row.acc_code ?? packingMeta?.acc_code ?? null,
      acc_name: overrideCust || row.acc_name || packingMeta?.acc_name || null,
      customer_key: row.customer_key ?? overrideCust ?? row.acc_code ?? null,
      item_dcode: row.item_dcode ?? packingMeta?.itemdcode ?? null,
      item_code: itemCode,
      item_desc: itemDesc,
      total_qty: Number(row.total_qty) || 0,
      box_count: Number(row.box_count) || 0,
      full_box_count: Number(row.full_box_count) || 0,
      loose_box_count: Number(row.loose_box_count) || 0,
    };
  });
}

export async function resolveQcHoldPackingMeta(packing_number) {
  const pn = String(packing_number ?? "").trim();
  if (!pn) return null;

  const [packingMeta, inHandBoxes, dispatchRaw] = await Promise.all([
    resolveStockAdjustmentPackingMeta(pn, {}),
    findInHandBoxesByPackingNumber(pn),
    findDispatchedOutwardLinesByPacking(pn),
  ]);

  const sellableBoxes = (inHandBoxes || []).filter((b) => !isBoxOnQcHold(b));
  const heldBoxes = (inHandBoxes || []).filter((b) => isBoxOnQcHold(b));

  const itemDcode = packingMeta?.itemdcode ?? inHandBoxes?.[0]?.itemdcode ?? null;
  const forwardedMap = itemDcode
    ? await findForwardedQtyByItemAndPacking(itemDcode)
    : {};
  const dispatchQty = Number(forwardedMap[pn] || forwardedMap[String(Number(pn))] || 0);
  const sellableQty = sumQty(sellableBoxes);
  const qcHoldQty = sumQty(heldBoxes);
  const dispatchLines = await enrichDispatchLines(dispatchRaw, packingMeta);
  const dispatchedTotalQty = dispatchLines.reduce((s, row) => s + (Number(row.total_qty) || 0), 0);
  const dispatchCustomerCount = new Set(
    dispatchLines.map((row) => String(row.acc_name ?? row.customer_key ?? "").trim().toLowerCase()).filter(Boolean)
  ).size;

  return {
    packing_number: pn,
    itemdcode: itemDcode,
    item_dcode: itemDcode,
    item_code: packingMeta?.item_code ?? null,
    item_desc: packingMeta?.item_desc ?? null,
    acc_code: packingMeta?.acc_code ?? null,
    acc_name: packingMeta?.acc_name ?? null,
    total_stock_qty: sellableQty,
    dispatch_stock_qty: dispatchedTotalQty,
    forwarded_pending_qty: dispatchQty,
    dispatched_total_qty: dispatchedTotalQty,
    dispatch_lines: dispatchLines,
    dispatch_out_count: dispatchLines.length,
    dispatch_customer_count: dispatchCustomerCount,
    in_hand_qty: sellableQty,
    qc_hold_qty: qcHoldQty,
    store_in_location: primaryStoreLocation(sellableBoxes.length ? sellableBoxes : inHandBoxes),
    job_card_no: packingMeta?.job_card_no ?? null,
    standard_qty_per_box: packingMeta?.standard_qty_per_box ?? null,
    in_hand_box_count: sellableBoxes.length,
    qc_hold_box_count: heldBoxes.length,
  };
}
