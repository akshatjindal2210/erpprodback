import { accessControl } from "../../core/middleware/accessControl.js";

const VIEW = "view";
const FORM_ACTIONS = ["add", "edit", "authorize"];
const isForm = (act) => FORM_ACTIONS.includes(act);

// ─── Items (/master/items/helper) ────────────────────────────────────────────
const itemPicker = ["itemdcode AS id", "item_code", "itemdesc"];
const itemModal = [...itemPicker, "unit", "category_id"];

function fieldsForItems(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "packing_standard" && act === VIEW) return [...itemPicker];
  if (mod === "packing_standard" && isForm(act)) return [...itemModal];

  if (mod === "stock_adjustment" && act === VIEW) return [...itemPicker];
  if (mod === "stock_adjustment" && isForm(act)) return [...itemModal];

  if (mod === "forwarding_note_master" && act === VIEW) return [...itemPicker];
  if (mod === "forwarding_note_master" && isForm(act)) return [...itemModal];

  if (mod === "location_master" && act === VIEW) return [...itemPicker];
  if (mod === "location_master" && isForm(act)) return [...itemModal];

  if (mod === "product_master" && act === VIEW) return [...itemPicker];
  if (mod === "product_master" && isForm(act)) return [...itemModal];

  if (mod === "qc_hold_material" && (act === VIEW || isForm(act))) return [...itemPicker];

  return null;
}

// ─── Ledgers (/master/ledgers/helper) ──────────────────────────────────────
const ledgerPicker = ["acc_code AS id", "acc_name"];
const ledgerModal = [...ledgerPicker, "group_code", "city"];

function fieldsForLedgers(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "packing_standard" && act === VIEW) return [...ledgerPicker];
  if (mod === "packing_standard" && isForm(act)) return [...ledgerModal];

  if (mod === "forwarding_note_master" && act === VIEW) return [...ledgerPicker];
  if (mod === "forwarding_note_master" && isForm(act)) return [...ledgerModal];

  if (mod === "location_master" && act === VIEW) return [...ledgerPicker];
  if (mod === "location_master" && isForm(act)) return [...ledgerModal];

  if (mod === "packing_entry" && act === VIEW) return [...ledgerPicker];
  if (mod === "packing_entry" && isForm(act)) return [...ledgerModal];

  if (mod === "change_override_customer" && act === VIEW) return [...ledgerPicker];
  if (mod === "change_override_customer" && isForm(act)) return [...ledgerModal];

  if (mod === "customer_master" && act === VIEW) return [...ledgerPicker];
  if (mod === "customer_master" && isForm(act)) return [...ledgerModal];

  if (mod === "stock_adjustment" && act === VIEW) return [...ledgerPicker];
  if (mod === "stock_adjustment" && isForm(act)) return [...ledgerModal];

  if (mod === "out_entry" && act === VIEW) return [...ledgerPicker];
  if (mod === "out_entry" && isForm(act)) return [...ledgerModal];

  if (mod === "boxes" && act === VIEW) return [...ledgerPicker];
  if (mod === "boxes" && isForm(act)) return [...ledgerModal];

  return null;
}

// ─── Boxes (/boxes/helper) ───────────────────────────────────────────────────
const boxPicker = ["b.box_uid AS id", "b.box_no_uid", "b.packing_number", "b.qty", "b.location_id"];
const boxOverridePicker = [...boxPicker, "b.override_cust::text AS acc_name"];
const boxModal = [...boxPicker, "b.override_cust::text AS acc_name", "b.location_id", "lm.rack_no", "b.in_uid", "b.out_uid"];

function fieldsForBoxes(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "inventory_inwards" && act === VIEW) return [...boxPicker];
  if (mod === "inventory_inwards" && isForm(act)) return [...boxModal];

  if (mod === "out_entry" && act === VIEW) return [...boxPicker];
  if (mod === "out_entry" && isForm(act)) return [...boxModal];

  if (mod === "change_override_customer" && act === VIEW) return [...boxOverridePicker];
  if (mod === "change_override_customer" && isForm(act)) return [...boxModal];

  if (mod === "audit" && (act === VIEW || isForm(act))) return [...boxModal];

  if (mod === "stock_adjustment" && act === VIEW) {
    return [
      "b.box_uid", "b.box_no_uid", "b.packing_number", "b.qty", "b.is_loose", "b.override_cust",
      "b.location_id", "b.in_uid", "b.out_uid", "b.sa_id", "b.sa_entry_type",
      "b.override_cust::text AS acc_name", "lm.rack_no", "lm.shelf_no",
      "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
      "dp.item_dcode AS itemdcode", "dp.item_dcode::text AS item_code",
    ];
  }

  if (mod === "qc_hold_material" && (act === VIEW || isForm(act))) {
    return [
      "b.box_uid", "b.box_no_uid", "b.packing_number", "b.qty", "b.in_uid", "b.out_uid",
      "b.override_cust::text AS acc_name", "dp.item_dcode AS itemdcode", "dp.item_dcode::text AS item_code",
    ];
  }

  if (mod === "boxes" && act === VIEW) return [...boxModal];

  return null;
}

// ─── Locations (/locations/helper) ───────────────────────────────────────────
const locPicker = [
  "lm.location_id", "lm.location_id AS id", "lm.rack_no", "lm.shelf_no",
  "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
  "lm.acc_code", "lm.item_dcode",
];
const locModal = [...locPicker, "lm.location_description", "lm.acc_code::text AS acc_name", "lm.item_dcode::text AS item_code"];
const locPackingListOnly = [
  "lm.rack_no", "lm.shelf_no",
  "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
  "lm.location_description", "lm.acc_code", "lm.item_dcode",
];
const locAuditPicker = [
  ...locPicker,
  "(SELECT COUNT(*)::int FROM ims_box_table b WHERE b.location_id = lm.location_id AND b.is_deleted = false AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL) AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')) AS box_count",
];

function fieldsForLocations(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "inventory_inwards" && act === VIEW) return [...locPicker];
  if (mod === "inventory_inwards" && isForm(act)) return [...locModal];

  if (mod === "packing_entry" && act === VIEW) return [...locPackingListOnly];
  if (mod === "packing_entry" && isForm(act)) return [...locModal];

  if (mod === "audit" && (act === VIEW || isForm(act))) return [...locAuditPicker];

  if (mod === "boxes" && act === VIEW) return [...locModal];

  return null;
}

// ─── Packing standard (/packing-standard/helper) ─────────────────────────────
const psPicker = [
  "ps.standard_id AS id", "ps.item_dcode", "ps.acc_code", "ps.item_dcode::text AS item_code",
  "ps.qty", "ps.unit", "ps.type", "cat.name AS category_name",
];
const psModal = [...psPicker, "ps.item_dcode", "ps.acc_code", "ps.acc_code::text AS acc_name"];

function fieldsForPackingStandard(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "packing_entry" && act === VIEW) return [...psPicker];
  if (mod === "packing_entry" && isForm(act)) return [...psModal];

  if (mod === "stock_adjustment" && act === VIEW) return [...psPicker];
  if (mod === "stock_adjustment" && isForm(act)) return [...psModal];

  return null;
}

// ─── Category (/category/helper) ─────────────────────────────────────────────
const catPicker = ["id", "name"];
const catModal = [...catPicker, "approved", "created_at", "updated_at"];

function fieldsForCategory(mod, act) {
  if (mod == null || act == null) return null;

  if (mod === "packing_standard" && act === VIEW) return [...catPicker];
  if (mod === "packing_standard" && isForm(act)) return [...catModal];

  if (mod === "stock_adjustment" && act === VIEW) return [...catPicker];
  if (mod === "stock_adjustment" && isForm(act)) return [...catModal];

  return null;
}

// ─── Sirf access check (SQL fields nahi) — [] = allowed ─────────────────────
function allowOnly(mod, act, pageModule, allowedActions) {
  if (mod !== pageModule || act == null) return null;
  return allowedActions.includes(act) ? [] : null;
}

function fieldsForPartyRates(mod, act) {
  return allowOnly(mod, act, "customer_item_code", [VIEW]);
}

function fieldsForDailyProd(mod, act) {
  return allowOnly(mod, act, "packing_entry", [VIEW, ...FORM_ACTIONS]);
}

function fieldsForForwardingNotes(mod, act) {
  if (mod == null || act == null) return null;
  const allowed = [VIEW, ...FORM_ACTIONS];
  if (mod === "out_entry" && allowed.includes(act)) return [];
  if (mod === "forwarding_note_master" && allowed.includes(act)) return [];
  return null;
}

function fieldsForInventoryInwards(mod, act) {
  return allowOnly(mod, act, "inventory_inwards", [VIEW, ...FORM_ACTIONS]);
}

function fieldsForOutEntries(mod, act) {
  return allowOnly(mod, act, "out_entry", [VIEW, ...FORM_ACTIONS]);
}

function fieldsForStockAdjustment(mod, act) {
  return allowOnly(mod, act, "stock_adjustment", [VIEW, ...FORM_ACTIONS]);
}

// ─── Route helper keys (helperAccess("...") mein same naam) ─────────────────
const BY_HELPER = {
  items: fieldsForItems,
  ledgers: fieldsForLedgers,
  boxes: fieldsForBoxes,
  locations: fieldsForLocations,
  packingStandard: fieldsForPackingStandard,
  category: fieldsForCategory,
  partyRates: fieldsForPartyRates,
  dailyProd: fieldsForDailyProd,
  forwardingNotes: fieldsForForwardingNotes,
  inventoryInwards: fieldsForInventoryInwards,
  outEntries: fieldsForOutEntries,
  stockAdjustment: fieldsForStockAdjustment,
};

function resolveHelperFields(helper, { permission_module, permission_action } = {}) {
  const fn = BY_HELPER[helper];
  if (!fn) return null;
  return fn(permission_module, permission_action);
}

/** Route middleware — helperAccess("ledgers") */
export function helperAccess(helper) {
  return (req, res, next) => {
    const page = req.body?.permission_module;
    const action = req.body?.permission_action;

    if (!page || !action) {
      return res.status(400).json({
        success: false,
        message: "permission_module and permission_action required in request body",
      });
    }

    if (resolveHelperFields(helper, { permission_module: page, permission_action: action }) == null) {
      return res.status(403).json({
        success: false,
        message: "This helper is not allowed from this page",
      });
    }

    const userType = String(req.user?.type || req.user?.role || "").toLowerCase().trim();
    if (userType === "super_admin") return next();

    return accessControl(page, action)(req, res, next);
  };
}

// Controllers — SQL field list (access route pe ho chuka hai)
export function resolveViewsFields(helper, { permission_module, permission_action } = {}) {
  return resolveHelperFields(helper, { permission_module, permission_action });
}
