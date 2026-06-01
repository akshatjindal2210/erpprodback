const forPicker = ["id", "name", "username"];

const forModal = [...forPicker, "email", "phone", "type", "status", "usercode", "auth_source", "department_id", "designation_id" ];

export function resolveUserViewsSelectFields(options = {}) {
  const mod = options.permission_module;
  const act = options.permission_action;

  if (mod == null || act == null) {
    return null;
  }

  if (mod === "users" && act === "view") {
    return [...forPicker];
  }
  if (mod === "users" && (act === "add" || act === "edit" || act === "authorize")) {
    return [...forModal];
  }

  return null;
}
