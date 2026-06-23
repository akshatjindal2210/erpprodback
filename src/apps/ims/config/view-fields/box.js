const forPicker = ["b.box_uid AS id", "b.box_no_uid", "b.packing_number", "b.qty", "b.location_id"];
const forOverridePicker = [...forPicker, "b.override_cust::text AS acc_name"];

const forModal = [...forPicker, "b.override_cust::text AS acc_name", "b.location_id", "lm.rack_no", "b.in_uid", "b.out_uid"];

export function resolveBoxViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "inventory_inwards" && act === "view") {
    return [...forPicker];
  } else if (mod === "inventory_inwards" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "out_entry" && act === "view") {
    return [...forPicker];
  } else if (mod === "out_entry" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "change_override_customer" && act === "view") {
    return [...forOverridePicker];
  } else if (mod === "change_override_customer" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "audit" && (act === "view" || act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "stock_adjustment" && act === "view") {
    return [
      "b.box_uid",
      "b.box_no_uid",
      "b.packing_number",
      "b.qty",
      "b.is_loose",
      "b.override_cust",
      "b.location_id",
      "b.in_uid",
      "b.out_uid",
      "b.sa_id",
      "b.sa_entry_type",
      "b.override_cust::text AS acc_name",
      "lm.rack_no",
      "lm.shelf_no",
      "COALESCE(lm.location_no, CONCAT(lm.rack_no, UPPER(COALESCE(lm.shelf_no, '')))) AS location_no",
      "dp.item_dcode AS itemdcode",
      "dp.item_dcode::text AS item_code",
    ];
  } else if (mod === "qc_hold_material" && (act === "view" || act === "add" || act === "edit" || act === "authorize")) {
    return [
      "b.box_uid",
      "b.box_no_uid",
      "b.packing_number",
      "b.qty",
      "b.in_uid",
      "b.out_uid",
      "b.override_cust::text AS acc_name",
      "dp.item_dcode AS itemdcode",
      "dp.item_dcode::text AS item_code",
    ];
  } else if (mod === "boxes" && act === "view") {
    return [...forModal];
  }

  return null;
}
