const forPicker = ["id", "name"];

const forModal = [...forPicker, "approved", "created_at", "updated_at"];

export function resolveCategoryViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "packing_standard" && act === "view") {
    return [...forPicker];
  } else if (mod === "packing_standard" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  }

  return null;
}
