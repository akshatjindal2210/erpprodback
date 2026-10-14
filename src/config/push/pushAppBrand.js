/** Push branding — same /push-icons/* as frontend appIcons.js / manifest. */

const ICONS = {
  home: "/push-icons/home.svg",
  ims: "/push-icons/ims.svg",
  rmstore: "/push-icons/rmstore.svg",
  task: "/push-icons/task.svg",
  hrms: "/push-icons/hrms.svg",
  purchase: "/push-icons/purchase.svg",
  production: "/push-icons/production.svg",
  engineering: "/push-icons/engineering.svg",
  settings: "/push-icons/settings.svg",
  core: "/push-icons/core.svg",
};

export const PUSH_APP_BRAND = {
  task: { label: "Task", icon: ICONS.task, badge: ICONS.task, defaultUrl: "/task/dashboard/tasks" },
  ims: { label: "IMS", icon: ICONS.ims, badge: ICONS.ims, defaultUrl: "/ims/dashboard" },
  rmstore: { label: "RM Store", icon: ICONS.rmstore, badge: ICONS.rmstore, defaultUrl: "/rmstore/dashboard" },
  hrms: { label: "HRMS", icon: ICONS.hrms, badge: ICONS.hrms, defaultUrl: "/hrms/dashboard" },
  purchase: { label: "Purchase", icon: ICONS.purchase, badge: ICONS.purchase, defaultUrl: "/purchase/dashboard" },
  production: { label: "Production", icon: ICONS.production, badge: ICONS.production, defaultUrl: "/production/dashboard" },
  engineering: { label: "Engineering", icon: ICONS.engineering, badge: ICONS.engineering, defaultUrl: "/engineering/dashboard" },
  core: { label: "Admin Console", icon: ICONS.core, badge: ICONS.core, defaultUrl: "/settings" },
  settings: { label: "Admin Console", icon: ICONS.settings, badge: ICONS.settings, defaultUrl: "/settings" },
  home: { label: "Home", icon: ICONS.home, badge: ICONS.home, defaultUrl: "/home" },
};

const DEFAULT_BRAND = {
  label: "JFL ERP",
  icon: ICONS.task,
  badge: ICONS.task,
  defaultUrl: "/",
};

export function normalizePushAppType(appType) {
  const key = String(appType ?? "task")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (key === "admin" || key === "admin_console") return "settings";
  if (Object.prototype.hasOwnProperty.call(PUSH_APP_BRAND, key)) return key;
  return "task";
}

export function resolvePushAppBrand(appType) {
  return PUSH_APP_BRAND[normalizePushAppType(appType)] ?? DEFAULT_BRAND;
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

export function pushIconUrl(appType, origin) {
  const brand = resolvePushAppBrand(appType);
  const path = brand.icon || ICONS.task;
  if (!origin) return path;
  return `${origin.replace(/\/$/, "")}${path}`;
}
