const forPicker = ["acc_code AS id", "acc_name"];

const forModal = [...forPicker, "group_code", "city"];

export function resolveLedgerViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "packing_standard" && act === "view") {
    return [...forPicker];
  } else if (mod === "packing_standard" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "forwarding_note_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "forwarding_note_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "location_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "location_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "packing_entry" && act === "view") {
    return [...forPicker];
  } else if (mod === "packing_entry" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "change_override_customer" && act === "view") {
    return [...forPicker];
  } else if (mod === "change_override_customer" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "customer_master" && act === "view") {
    return [...forPicker];
  } else if (mod === "customer_master" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  } else if (mod === "stock_adjustment" && act === "view") {
    return [...forPicker];
  } else if (mod === "stock_adjustment" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  }

  return null;
}
