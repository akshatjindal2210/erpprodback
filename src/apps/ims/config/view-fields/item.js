const forPicker = ["itemdcode AS id", "item_code", "itemdesc"];

const forModal = [...forPicker, "unit", "category_id"];

export function resolveItemViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "packing_standard" && act === "view") {
    return [...forPicker];
  } else if (mod === "packing_standard" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "stock_adjustment" && act === "view") {
    return [...forPicker];
  } else if (mod === "stock_adjustment" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "forwarding_note_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "forwarding_note_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "location_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "location_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "product_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "product_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "qc_hold_material" && (act === "view" || act === "add" || act === "edit" || act === "authorize")) {
    return [...forPicker];
  }

  return null;
}
