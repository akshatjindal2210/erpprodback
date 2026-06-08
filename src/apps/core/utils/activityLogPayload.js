const SENSITIVE_KEYS = new Set([
  "password",
  "confirmpassword",
  "oldpassword",
  "token",
  "otp",
  "secret",
  "refresh_token",
  "access_token",
]);

const SKIP_KEYS = new Set([
  "created_at",
  "updated_at",
  "deleted_at",
  "created_by",
  "updated_by",
  "deleted_by",
  "success",
  "action",
  "entity",
  "entity_ref",
]);

const RECORD_KEYS = [
  "box_no_uid",
  "packing_number",
  "in_uid",
  "out_uid",
  "fuid",
  "adjustment_id",
  "standard_id",
  "location_id",
  "audit_id",
  "item_dcode",
  "acc_name",
  "username",
  "name",
  "rack_no",
  "shelf_no",
  "entry_type",
  "po_number",
  "bill_no",
];

const ENTITY_LABELS = {
  boxes: "box",
  box_table: "box",
  inventory_inwards: "inward",
  out_entry: "out entry",
  packing_standard: "packing standard",
  forwarding_note_master: "forwarding note",
  stock_adjustment: "adjustment",
  location_master: "location",
  users: "user",
  audit: "audit",
  change_override_customer: "customer override",
  ims_box_override_request: "customer override",
};

const ACTION_VERBS = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
  APPROVE: "Approved",
  MODIFY: "Updated",
  LOCK: "Locked",
  UNLOCK: "Unlocked",
  LOGIN: "Login",
  LOGOUT: "Logout",
  GENERATE_STICKERS: "Generated stickers for",
  DELETE_GENERATED_STICKERS: "Removed stickers from packing",
  BULK_DOWNLOAD: "Downloaded stickers for packing",
};

const FIELD_LABELS = {
  box_no_uid: "Box no",
  packing_number: "Packing no",
  in_uid: "Inward id",
  out_uid: "Out id",
  fuid: "Forwarding id",
  adjustment_id: "Adjustment id",
  standard_id: "Standard id",
  location_id: "Location id",
  audit_id: "Audit id",
  item_dcode: "Item code",
  acc_name: "Customer",
  username: "Username",
  name: "Name",
  rack_no: "Rack",
  shelf_no: "Shelf",
  entry_type: "Type",
  po_number: "PO no",
  bill_no: "Bill no",
  deleted_count: "Removed",
  total_stickers: "Sticker count",
  sticker_count: "Download count",
  item_count: "Item count",
  updated_fields: "Changed fields",
  from_customer: "From customer",
  to_customer: "To customer",
  old_cust: "From customer",
  new_cust: "To customer",
  box_count: "Box count",
  remarks: "Remarks",
};

function entityLabel(entity) {
  const key = String(entity || "").toLowerCase();
  return ENTITY_LABELS[key] || key.replace(/_/g, " ");
}

function toActionType(action) {
  return String(action || "ACTION").trim().toUpperCase();
}

function parseEntityId(entity_id) {
  if (entity_id == null || entity_id === "") return { numeric: null, ref: null };
  const n = Number(entity_id);
  if (Number.isFinite(n) && String(n) === String(entity_id).trim()) {
    return { numeric: n, ref: String(entity_id) };
  }
  return { numeric: null, ref: String(entity_id) };
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function labelField(key) {
  return FIELD_LABELS[key] || String(key).replace(/_/g, " ");
}

function formatValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return null;
  return String(value);
}

function filterObject(obj) {
  if (!isPlainObject(obj)) return null;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || SKIP_KEYS.has(lower)) continue;
    const formatted = formatValue(value);
    if (formatted == null) continue;
    out[labelField(key)] = formatted;
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeRecord(record, maxKeys = 12) {
  if (!isPlainObject(record)) return null;

  const out = {};
  for (const key of RECORD_KEYS) {
    const formatted = formatValue(record[key]);
    if (formatted != null) out[labelField(key)] = formatted;
  }

  if (!Object.keys(out).length) {
    for (const [key, value] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower) || SKIP_KEYS.has(lower)) continue;
      const formatted = formatValue(value);
      if (formatted == null) continue;
      out[labelField(key)] = formatted;
      if (Object.keys(out).length >= maxKeys) break;
    }
  }

  return Object.keys(out).length ? out : null;
}

function normalizeExtra(details, meta) {
  const merged = {};
  if (isPlainObject(details)) Object.assign(merged, details);
  if (isPlainObject(meta)) Object.assign(merged, meta);
  return Object.keys(merged).length ? merged : null;
}

function buildStickerRemoveInfo(extra) {
  if (!extra) return null;
  const info = {};
  if (extra.deleted_count != null) info["Removed"] = String(extra.deleted_count);
  if (extra.scope === "production_only") info["Type"] = "Production only";
  if (extra.permanent != null) info["Permanent"] = extra.permanent ? "Yes" : "No";
  if (extra.dailyprod_reset != null) info["Can generate again"] = extra.dailyprod_reset ? "Yes" : "No";
  if (extra.sa_boxes_preserved != null) info["SA boxes kept"] = extra.sa_boxes_preserved ? "Yes" : "No";
  return Object.keys(info).length ? info : null;
}

function parseRemovedBoxIds(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Stock adjustment: qty always positive in logs; type field shows add/minus. */
function buildStockAdjustmentLog(extra, record) {
  const source = { ...(isPlainObject(record) ? record : {}), ...(extra || {}) };
  const info = {};
  const more = {};

  const entryType = source.entry_type;
  if (entryType) info["Type"] = entryType === "minus" ? "Minus" : entryType === "add" ? "Add" : String(entryType);

  if (source.qty != null && source.qty !== "") {
    const q = Number(source.qty);
    info["Qty"] = Number.isFinite(q) ? String(Math.abs(q)) : String(source.qty);
  }
  if (source.packing_number) info["Packing no"] = String(source.packing_number);
  if (source.item_dcode != null) info["Item code"] = String(source.item_dcode);
  if (source.unit) info["Unit"] = String(source.unit);
  if (source.acc_code != null) info["Customer code"] = String(source.acc_code);
  if (source.per_box_qty != null) info["Per box qty"] = String(source.per_box_qty);

  if (source.approved != null) more["Approved"] = source.approved ? "Yes" : "No";
  if (source.box_count_impact != null) {
    more["Box count impact"] = source.box_count_impact === true || source.box_count_impact === "true" ? "Yes" : "No";
  }

  const removedIds = parseRemovedBoxIds(source.removed_box_ids);
  if (removedIds.length) more["Removed box ids"] = removedIds.join(", ");

  if (source.affected_boxes) {
    more["Affected boxes"] = Array.isArray(source.affected_boxes)
      ? source.affected_boxes.join(", ")
      : String(source.affected_boxes);
  }
  if (source.remarks) more["Remarks"] = String(source.remarks);
  if (source.financial_year) more["Financial year"] = String(source.financial_year);
  if (source.entry_type) more["Entry type"] = String(source.entry_type);

  return {
    info: Object.keys(info).length ? info : null,
    more: Object.keys(more).length ? more : null,
  };
}

function isOverrideCustomerContext(entity, actionType) {
  const entityKey = String(entity || "").toLowerCase();
  const action = String(actionType || "").toUpperCase();
  return (
    entityKey === "change_override_customer" ||
    entityKey === "ims_box_override_request" ||
    action.includes("OVERRIDE")
  );
}

function buildOverrideCustomerDescription(actionType, ref, record, extra) {
  const source = { ...(isPlainObject(record) ? record : {}), ...(extra || {}) };
  const from = source.from_customer ?? source.old_cust;
  const to = source.to_customer ?? source.new_cust;
  const packing = source.packing_number;
  const boxCount =
    source.box_count ??
    (Array.isArray(source.box_uids) ? source.box_uids.length : null);

  const bits = [];
  if (ref) bits.push(`request ${ref}`);
  if (packing) bits.push(`packing ${packing}`);
  if (from && to) bits.push(`${from} → ${to}`);
  else if (to) bits.push(`to ${to}`);
  if (boxCount != null) bits.push(`${boxCount} box(es)`);

  const action = String(actionType).toUpperCase();
  if (action === "OVERRIDE_CUSTOMER") {
    return bits.length ? `Changed customer on box, ${bits.join(", ")}` : "Changed customer on box";
  }
  if (action === "CREATE") {
    const status = source.approved === true ? "approved" : "pending";
    return bits.length
      ? `Submitted override request (${status}), ${bits.join(", ")}`
      : `Submitted override request (${status})`;
  }
  if (action === "APPROVE" || action === "APPROVE_OVERRIDE_REQUEST") {
    return bits.length ? `Approved customer override, ${bits.join(", ")}` : "Approved customer override";
  }
  if (action === "REJECT" || action === "REJECT_OVERRIDE_REQUEST") {
    return bits.length ? `Rejected customer override, ${bits.join(", ")}` : "Rejected customer override";
  }
  if (action === "UPDATE" || action === "UPDATE_OVERRIDE_REQUEST") {
    if (source.approved === true) {
      return bits.length ? `Approved customer override, ${bits.join(", ")}` : "Approved customer override";
    }
    return bits.length ? `Updated override request, ${bits.join(", ")}` : "Updated override request";
  }

  const verb = ACTION_VERBS[action] || action;
  return bits.length ? `${verb} customer override, ${bits.join(", ")}` : `${verb} customer override`;
}

function buildOverrideCustomerLog(extra, record) {
  const source = { ...(isPlainObject(record) ? record : {}), ...(extra || {}) };
  const info = {};
  const more = {};

  const from = source.from_customer ?? source.old_cust;
  const to = source.to_customer ?? source.new_cust;
  if (from) info["From customer"] = String(from);
  if (to) info["To customer"] = String(to);
  if (source.packing_number) info["Packing no"] = String(source.packing_number);
  if (source.box_count != null) info["Box count"] = String(source.box_count);
  if (source.approved != null) info["Approved"] = source.approved ? "Yes" : "No";

  if (source.remarks) more["Remarks"] = String(source.remarks);
  const uids = source.box_uids;
  if (Array.isArray(uids) && uids.length) more["Box ids"] = uids.join(", ");

  return {
    info: Object.keys(info).length ? info : null,
    more: Object.keys(more).length ? more : null,
  };
}

function buildStockAdjustmentDescription(actionType, ref, record, extra) {
  const source = { ...(isPlainObject(record) ? record : {}), ...(extra || {}) };
  const adjustmentId = ref || source.adjustment_id;
  const packing = source.packing_number;

  const bits = [];
  if (adjustmentId != null && adjustmentId !== "") bits.push(`id ${adjustmentId}`);
  if (packing) bits.push(`packing ${packing}`);

  if (actionType === "CREATE") {
    const type = source.entry_type;
    const q =
      source.qty != null && Number.isFinite(Number(source.qty))
        ? Math.abs(Number(source.qty))
        : null;
    if (type) bits.push(String(type));
    if (q != null) bits.push(`qty ${q}`);
  }

  const verb = ACTION_VERBS[actionType] || actionType;
  return bits.length ? `${verb} adjustment, ${bits.join(", ")}` : `${verb} adjustment`;
}

function buildSimpleDescription(actionType, entity, ref, record, extra) {
  const item = entityLabel(entity);
  const refText = ref ? ` ${ref}` : "";

  if (entity === "stock_adjustment") {
    return buildStockAdjustmentDescription(actionType, ref, record, extra);
  }

  if (isOverrideCustomerContext(entity, actionType)) {
    return buildOverrideCustomerDescription(actionType, ref, record, extra);
  }

  if (actionType === "DELETE_GENERATED_STICKERS") {
    const n = extra?.deleted_count ?? 0;
    return `Removed ${n} sticker(s) from packing${refText}`;
  }
  if (actionType === "GENERATE_STICKERS") {
    const n = extra?.total_stickers ?? 0;
    return `Generated ${n} sticker(s) for packing${refText}`;
  }
  if (actionType === "BULK_DOWNLOAD") {
    const n = extra?.sticker_count ?? 0;
    return `Downloaded ${n} sticker(s) for packing${refText}`;
  }

  const verb = ACTION_VERBS[actionType] || actionType;
  const recordBits = summarizeRecord(record);
  const hint =
    recordBits?.["Box no"] ||
    recordBits?.["Packing no"] ||
    recordBits?.["Name"] ||
    recordBits?.["Username"] ||
    null;

  if (actionType === "DELETE") {
    return hint ? `Deleted ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `Deleted ${item}${ref ? `, id ${ref}` : ""}`;
  }
  if (actionType === "CREATE") {
    return hint ? `Created ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `Created ${item}${ref ? `, id ${ref}` : ""}`;
  }
  if (actionType === "UPDATE" || actionType === "MODIFY") {
    if (Array.isArray(extra?.updated_fields) && extra.updated_fields.length) {
      return `Updated ${item}${ref ? `, id ${ref}` : ""}, fields: ${extra.updated_fields.join(", ")}`;
    }
    return hint ? `Updated ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `Updated ${item}${ref ? `, id ${ref}` : ""}`;
  }
  if (actionType === "APPROVE") {
    return hint ? `Approved ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `Approved ${item}${ref ? `, id ${ref}` : ""}`;
  }

  return hint ? `${verb} ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `${verb} ${item}${ref ? `, id ${ref}` : ""}`;
}

function buildInfo(actionType, record, extra) {
  if (actionType === "DELETE_GENERATED_STICKERS") {
    return buildStickerRemoveInfo(extra);
  }

  const info = {};

  const recordInfo = summarizeRecord(record);
  if (recordInfo) Object.assign(info, recordInfo);

  const extraInfo = filterObject(extra);
  if (extraInfo) {
    for (const [key, value] of Object.entries(extraInfo)) {
      if (info[key] == null) info[key] = value;
    }
  }

  if (actionType === "UPDATE" || actionType === "MODIFY") {
    if (Array.isArray(extra?.updated_fields)) {
      info["Changed fields"] = extra.updated_fields.join(", ");
    }
  }

  return Object.keys(info).length ? info : null;
}

export function buildActivityLogPayload({
  action,
  entity,
  entity_id = null,
  record = null,
  details = null,
  meta = null,
}) {
  const actionType = toActionType(action);
  const { numeric, ref } = parseEntityId(entity_id);
  const extra = normalizeExtra(details, meta);
  const description = buildSimpleDescription(actionType, entity, ref, record, extra);

  const log_data = { summary: description };
  if (ref) log_data.ref = ref;

  if (entity === "stock_adjustment") {
    const sa = buildStockAdjustmentLog(extra, record);
    if (sa.info) log_data.info = sa.info;
    if (sa.more) log_data.more = sa.more;
  } else if (isOverrideCustomerContext(entity, actionType)) {
    const oc = buildOverrideCustomerLog(extra, record);
    if (oc.info) log_data.info = oc.info;
    if (oc.more) log_data.more = oc.more;
  } else {
    const info = buildInfo(actionType, record, extra);
    if (info) log_data.info = info;
  }

  return {
    description,
    log_data,
    entity_id: numeric,
    entity_ref: ref,
  };
}

export function buildMiddlewareLogPayload({
  actionType,
  module,
  entityId = null,
  body = null,
  responseData = null,
  route = "",
}) {
  const payload = buildActivityLogPayload({
    action: actionType,
    entity: module,
    entity_id: entityId,
    record: actionType === "DELETE" ? summarizeRecord(responseData) : summarizeRecord(responseData) || summarizeRecord(body),
    details: summarizeRecord(body),
  });

  if (actionType === "DELETE" && route.includes("bulk") && Array.isArray(body?.ids)) {
    payload.log_data.info = {
      ...(payload.log_data.info || {}),
      Count: String(body.ids.length),
    };
    payload.description = `Deleted ${body.ids.length} ${entityLabel(module)} record(s)`;
    payload.log_data.summary = payload.description;
  }

  return payload;
}
