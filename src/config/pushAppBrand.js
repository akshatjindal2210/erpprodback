/** Push notification branding per portal app — keep in sync with frontend/src/config/pushAppBrand.js */

export const PUSH_APP_BRAND = {
  task: {
    label: "Task",
    icon: "/push-icons/task.svg",
    badge: "/push-icons/task.svg",
    defaultUrl: "/task/dashboard/tasks",
  },
  ims: {
    label: "IMS",
    icon: "/push-icons/ims.svg",
    badge: "/push-icons/ims.svg",
    defaultUrl: "/ims/dashboard",
  },
  core: {
    label: "Admin Console",
    icon: "/push-icons/core.svg",
    badge: "/push-icons/core.svg",
    defaultUrl: "/settings",
  },
  home: {
    label: "Home",
    icon: "/push-icons/home.svg",
    badge: "/push-icons/home.svg",
    defaultUrl: "/home",
  },
};

const DEFAULT_BRAND = {
  label: "JFL ERP",
  icon: "/push-icons/task.svg",
  badge: "/push-icons/task.svg",
  defaultUrl: "/",
};

export function normalizePushAppType(appType) {
  const key = String(appType ?? "task")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (key === "settings" || key === "admin" || key === "admin_console") return "core";
  if (Object.prototype.hasOwnProperty.call(PUSH_APP_BRAND, key)) return key;
  return "task";
}

export function resolvePushAppBrand(appType) {
  const key = normalizePushAppType(appType);
  return PUSH_APP_BRAND[key] ?? DEFAULT_BRAND;
}

export function formatPushTitle(appType, title) {
  const brand = resolvePushAppBrand(appType);
  const clean = String(title ?? "").trim();
  if (!clean) return brand.label;
  const lower = clean.toLowerCase();
  if (lower.startsWith(`${brand.label.toLowerCase()} ·`) || lower.startsWith(`${brand.label.toLowerCase()}:`)) {
    return clean;
  }
  return `${brand.label} · ${clean}`;
}
