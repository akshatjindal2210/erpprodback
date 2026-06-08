const forPicker = ["lm.location_id", "lm.location_id AS id", "lm.rack_no", "lm.shelf_no", "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no", "lm.acc_code", "lm.item_dcode"];

const forAuditPicker = [...forPicker, "(SELECT COUNT(*)::int FROM ims_box_table b WHERE b.location_id = lm.location_id AND b.is_deleted = false AND (b.out_uid IS NULL OR NULLIF(TRIM(b.out_uid::text), '') IS NULL) AND (b.sa_entry_type IS DISTINCT FROM 'stock_out')) AS box_count"];

const forModal = [...forPicker, "lm.location_description", "lm.acc_code::text AS acc_name", "lm.item_dcode::text AS item_code"];

const forPackingListOnly = ["lm.rack_no", "lm.shelf_no", "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no", "lm.location_description", "lm.acc_code", "lm.item_dcode"];

export function resolveLocationViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  } else if (mod === "inventory_inwards" && act === "view") {
    return [...forPicker];
  } else if (mod === "inventory_inwards" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "packing_entry" && act === "view") {
    return [...forPackingListOnly];
  } else if (mod === "packing_entry" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "audit" && (act === "view" || act === "add" || act === "edit" || act === "authorize")) {
    return [...forAuditPicker];
  } else {
    return null;
  }
}
