const forPicker = ["ps.standard_id AS id", "ps.item_dcode", "ps.acc_code", "ps.item_dcode::text AS item_code", "ps.qty", "ps.unit", "ps.type", "cat.name AS category_name"];

const forModal = [...forPicker, "ps.item_dcode", "ps.acc_code", "ps.acc_code::text AS acc_name"];

export function resolvePackingStandardViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "packing_entry" && act === "view") {
    return [...forPicker];
  } else if (mod === "packing_entry" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  }

  return null;
}
