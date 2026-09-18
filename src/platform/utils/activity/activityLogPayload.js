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
  "coils",
  "previous_coils",
  "proposed_coils",
  "scanned_coil_uids",
  "job_cards",
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
  "id",
  "tray_id",
  "audit_id",
  "code",
  "batch_id",
  "serial_number",
  "item_dcode",
  "acc_name",
  "username",
  "name",
  "rack_no",
  "shelf_no",
  "entry_type",
  "po_number",
  "bill_no",
  "employee_code",
  "attendance_date",
];

const ENTITY_LABELS = {
  boxes: "box",
  box_table: "box",
  inventory_inwards: "inward",
  out_entry: "out entry",
  packing_standard: "packing standard",
  shortage: "shortage",
  forwarding_note_master: "forwarding note",
  stock_adjustment: "adjustment",
  location_master: "location",
  tray_master: "tray",
  manage_tray: "manage tray",
  users: "user",
  audit: "audit",
  change_override_customer: "customer override",
  ims_box_override_request: "customer override",
  qc_hold_material: "QC hold",
  hrms_attendance: "daily attendance",
  hrms_attendance_log: "attendance log",
  rm_mrn_portal: "MRN",
  rm_inventory_inwards: "store in",
  rm_qc_check: "QC check",
  rm_issue_request: "issue request",
  rm_in_process_request: "in-process request",
  rm_out_entry: "store out",
  rm_rejection: "RM rejection",
  rm_stock_adjustment: "stock adjustment",
  rm_production_master: "production master",
  rm_spec_master: "RM spec",
  rm_store_location_master: "store location",
};

const ACTION_VERBS = {
  CREATE: "Created",
  UPDATE: "Updated",
  DELETE: "Deleted",
  APPROVE: "Approved",
  SUBMIT: "Submitted",
  MODIFY: "Updated",
  LOCK: "Locked",
  UNLOCK: "Unlocked",
  LOGIN: "Login",
  LOGOUT: "Logout",
  GENERATE: "Generated stickers for",
  GENERATE_STICKERS: "Generated stickers for",
  DELETE_GENERATED_STICKERS: "Removed stickers from packing",
  BULK_DOWNLOAD: "Downloaded stickers for packing",
  CREATE_APPROVE: "Created and approved",
  CREATE_SUBMIT: "Created and submitted",
  CREATE_DRAFT: "Saved draft",
  UNAPPROVE: "Set to pending",
  UPDATE_REVERT: "Updated and set to pending",
  SAVE_DRAFT: "Saved draft for",
  REJECT: "Rejected",
  GENERATE_STORE_OUT: "Generated store out for",
};

const STOCK_ADJUSTMENT_ENTITIES = new Set(["stock_adjustment", "rm_stock_adjustment"]);

const FIELD_LABELS = {
  box_no_uid: "Box no",
  packing_number: "Packing no",
  in_uid: "Inward id",
  out_uid: "Out id",
  fuid: "Forwarding id",
  adjustment_id: "Adjustment id",
  standard_id: "Standard id",
  location_id: "Location id",
  id: "Tray id",
  tray_id: "Tray id",
  code: "Code",
  batch_id: "Batch",
  serial_number: "S.No.",
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
  hold_id: "Hold id",
  submission_id: "Submission id",
  submission_type: "Submission type",
  completed_qty: "Completed qty",
  rejected_qty: "Rejected qty",
  balance_qty: "Balance qty",
  box_count: "Box count",
  status: "Status",
  event: "Event",
  hold_scan_mode: "Scan mode",
  completion_sticker_count: "Completion stickers",
  deleted_count: "Removed",
  total_stickers: "Sticker count",
  sticker_count: "Download count",
  item_count: "Item count",
  employee_code: "Emp code",
  attendance_date: "Date",
  approval_status: "Approval",
  in: "In",
  out: "Out",
  punch_count: "Punches",
  approved_count: "Approved rows",
  unapproved_count: "Unapproved rows",
  edited_codes: "Edited employees",
  updated_fields: "Changed fields",
  total: "New logs",
  fetched: "Fetched events",
  from: "From",
  to: "To",
  from_customer: "From customer",
  to_customer: "To customer",
  old_cust: "From customer",
  new_cust: "To customer",
  remarks: "Remarks",
  approval_only: "Approval only",
  coil_count: "Coil count",
  mrn_uid: "MRN UID",
  approved: "Approved",
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

/** Known primary-key / reference fields across IMS, RM Store, and Task. */
const ENTITY_ID_KEYS = [
  "id",
  "uid",
  "mrn_uid",
  "coil_no_uid",
  "qc_check_uid",
  "qc_reject_uid",
  "out_uid",
  "in_uid",
  "ipr_uid",
  "issue_uid",
  "adjustment_id",
  "production_id",
  "location_id",
  "hold_id",
  "audit_id",
  "box_uid",
  "standard_id",
  "fuid",
  "item_dcode",
  "source_item_dcode",
  "doc_no",
];

function hasEntityIdValue(value) {
  return value != null && String(value).trim() !== "";
}

function pickEntityIdFromObject(obj) {
  if (!isPlainObject(obj)) return null;
  for (const key of ENTITY_ID_KEYS) {
    const value = obj[key];
    if (hasEntityIdValue(value)) return String(value).trim();
  }
  return null;
}

function pickEntityIdFromResponseData(data) {
  const direct = pickEntityIdFromObject(data);
  if (direct) return direct;
  if (!isPlainObject(data)) return null;
  for (const value of Object.values(data)) {
    if (!isPlainObject(value)) continue;
    const nested = pickEntityIdFromObject(value);
    if (nested) return nested;
  }
  return null;
}

/** Resolve entity ref for auto middleware logs (params → body → response). */
export function resolveMiddlewareEntityId(req, responseData = null) {
  const fromParams = req?.params?.id;
  if (hasEntityIdValue(fromParams)) return String(fromParams).trim();

  const fromBody = pickEntityIdFromObject(req?.body);
  if (fromBody) return fromBody;

  return pickEntityIdFromResponseData(responseData);
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function labelField(key) {
  return FIELD_LABELS[key] || String(key).replace(/_/g, " ");
}

function formatObjectRef(obj) {
  if (!isPlainObject(obj)) return null;
  const ref =
    obj.coil_no_uid ??
    obj.box_uid ??
    obj.box_no_uid ??
    obj.uid ??
    obj.id;
  if (ref != null && String(ref).trim() !== "") return String(ref).trim();
  return null;
}

function formatArraySummary(value, maxItems = 12) {
  if (!Array.isArray(value) || !value.length) return null;
  const allScalar = value.every(
    (item) => item == null || ["string", "number", "boolean"].includes(typeof item)
  );
  if (allScalar && value.length <= maxItems) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  return `[${value.length}]`;
}

/** Nested objects: expand one level (so hold_data is not just `{...}`). */
function formatObjectSummary(obj, maxPairs = 8, depth = 0) {
  if (!isPlainObject(obj)) return null;
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const lower = String(key).toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || SKIP_KEYS.has(lower)) continue;
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      const arr = formatArraySummary(value);
      if (arr) parts.push(`${key}: ${arr}`);
    } else if (isPlainObject(value)) {
      const ref = formatObjectRef(value);
      if (ref) parts.push(`${key}: ${ref}`);
      else if (depth < 1) {
        const nested = formatObjectSummary(value, 10, depth + 1);
        parts.push(nested ? `${key}: { ${nested} }` : `${key}: {}`);
      } else {
        parts.push(`${key}: {...}`);
      }
    } else {
      const text = String(value).trim();
      if (text) parts.push(`${key}: ${text}`);
    }
    if (parts.length >= maxPairs) break;
  }
  return parts.length ? parts.join(", ") : null;
}

function formatValue(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value == null || value === "") return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    const parts = value
      .map((item) => {
        if (item == null || item === "") return null;
        if (typeof item === "object") return formatObjectRef(item);
        const text = String(item).trim();
        return text || null;
      })
      .filter(Boolean);
    if (parts.length) return parts.join(", ");
    return `${value.length} item(s)`;
  }
  if (typeof value === "object") return formatObjectRef(value) || formatObjectSummary(value);
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

function qcHoldPassRejectLabel(source, { partial = false } = {}) {
  const pass = Number(source?.completed_qty) || 0;
  const reject = Number(source?.rejected_qty) || 0;
  const suffix = partial ? " (partial)" : "";
  if (pass > 0 && reject > 0) return `Passed ${pass.toLocaleString()} · rejected ${reject.toLocaleString()}${suffix}`;
  if (pass > 0) return `Passed ${pass.toLocaleString()} qty${suffix}`;
  if (reject > 0) return `Rejected ${reject.toLocaleString()} qty${suffix}`;
  return partial ? "Passed (partial)" : "Passed";
}

function qcHoldEventLabel(event, submissionType, source = {}) {
  const e = String(event || "").toLowerCase();
  if (e === "qc_hold_created") return "Put on hold";
  if (e === "partial_submit") return "Submitted — awaiting approval (partial)";
  if (e === "full_submit") return "Submitted — awaiting approval (full)";
  if (e === "revert_submit") return "Release requested — awaiting approval";
  if (e === "partial_approved") return qcHoldPassRejectLabel(source, { partial: true });
  if (e === "hold_completed") return qcHoldPassRejectLabel(source);
  if (e === "revert_approved") return "Released";
  if (e === "qc_hold_updated") return "Hold updated";
  if (e === "qc_hold_deleted") return "Hold deleted";
  const t = String(submissionType || "").toLowerCase();
  if (t === "partial") return "Partial submit";
  if (t === "full") return "Full submit";
  if (t === "revert") return "Release requested";
  return null;
}

function buildQcHoldDescription(actionType, ref, record, extra) {
  const item = entityLabel("qc_hold_material");
  const verb = ACTION_VERBS[actionType] || actionType;
  if (ref) return `${verb} ${item}, id ${ref}`;
  return `${verb} ${item}`;
}

function compactHoldDataSnapshot(raw) {
  if (raw == null || raw === "") return null;
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(data)) return null;
  const boxes = Array.isArray(data.boxes)
    ? data.boxes.map((v) => String(v).trim()).filter(Boolean)
    : [];
  const out = {};
  if (data.hold_type) out.hold_type = String(data.hold_type);
  if (data.hold_scan_mode) out.hold_scan_mode = String(data.hold_scan_mode);
  if (data.qty != null && data.qty !== "") out.qty = Number(data.qty) || 0;
  if (data.total_boxes != null) out.total_boxes = Number(data.total_boxes) || boxes.length;
  else if (boxes.length) out.total_boxes = boxes.length;
  if (boxes.length) out.boxes = boxes;
  if (data.completed_qty != null) out.completed_qty = Number(data.completed_qty) || 0;
  if (data.completed_boxes != null) out.completed_boxes = Number(data.completed_boxes) || 0;
  if (data.rejected_qty != null) out.rejected_qty = Number(data.rejected_qty) || 0;
  if (data.rejected_boxes != null) out.rejected_boxes = Number(data.rejected_boxes) || 0;
  if (Array.isArray(data.submissions)) out.submissions_count = data.submissions.length;
  return Object.keys(out).length ? out : null;
}

function buildQcHoldLog(extra, record) {
  const source = { ...(isPlainObject(record) ? record : {}), ...(extra || {}) };
  const info = {};
  const more = {};

  const eventLabel = qcHoldEventLabel(source.event, source.submission_type, source);
  if (eventLabel) info["Event"] = eventLabel;
  if (source.submission_type) {
    const t = String(source.submission_type).toLowerCase();
    info["Submission"] = t === "partial" ? "Partial" : t === "full" ? "Full" : t === "revert" ? "Revert" : String(source.submission_type);
  }
  if (source.status) info["Status"] = String(source.status);
  if (source.packing_number) info["Packing no"] = String(source.packing_number);
  if (source.item_dcode != null) info["Item code"] = String(source.item_dcode);
  if (source.qty != null && source.qty !== "") info["Qty"] = String(source.qty);
  if (source.completed_qty != null && source.completed_qty !== "") info["Completed qty"] = String(source.completed_qty);
  if (source.rejected_qty != null && source.rejected_qty !== "") info["Rejected qty"] = String(source.rejected_qty);
  if (source.balance_qty != null && source.balance_qty !== "") info["Balance qty"] = String(source.balance_qty);
  if (source.box_count != null) info["Box count"] = String(source.box_count);

  if (source.submission_id != null) more["Submission id"] = String(source.submission_id);
  if (source.hold_scan_mode) more["Scan mode"] = String(source.hold_scan_mode);
  if (source.completion_sticker_count != null) more["Completion stickers"] = String(source.completion_sticker_count);
  if (source.reason) more["Reason"] = String(source.reason);
  if (source.remarks) more["Remarks"] = String(source.remarks);

  const holdDataSnap = compactHoldDataSnapshot(source.hold_data);
  if (holdDataSnap) more.hold_data = holdDataSnap;

  return {
    info: Object.keys(info).length ? info : null,
    more: Object.keys(more).length ? more : null,
  };
}

function isStockAdjustmentEntity(entity) {
  return STOCK_ADJUSTMENT_ENTITIES.has(String(entity || "").toLowerCase());
}

function buildRmMrnPortalDescription(actionType, ref, extra) {
  const refText = ref ? ` ${ref}` : "";
  const n = extra?.coil_count;
  const countBit = n != null && n !== "" ? ` (${n} coil${Number(n) === 1 ? "" : "s"})` : "";
  if (actionType === "GENERATE") return `Generated MRN stickers${countBit}${refText}`;
  if (actionType === "APPROVE") return `Approved MRN stickers${countBit}${refText}`;
  if (actionType === "SAVE_DRAFT") return `Saved MRN sticker draft${refText}`;
  if (actionType === "REJECT") return `Rejected MRN${refText}`;
  if (actionType === "UPLOAD_DOCS") return `Uploaded MRN documents${refText}`;
  return null;
}

function buildSimpleDescription(actionType, entity, ref, record, extra) {
  const item = entityLabel(entity);
  const refText = ref ? ` ${ref}` : "";
  const entityKey = String(entity || "").toLowerCase();

  if (entityKey === "rm_mrn_portal") {
    const mrnDesc = buildRmMrnPortalDescription(actionType, ref, extra);
    if (mrnDesc) return mrnDesc;
  }

  if (isStockAdjustmentEntity(entity)) {
    return buildStockAdjustmentDescription(actionType, ref, record, extra);
  }

  if (entity === "qc_hold_material") {
    return buildQcHoldDescription(actionType, ref, record, extra);
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
    if (extra?.approval_only === true) {
      return `Approved ${item} (no field changes)${ref ? `, id ${ref}` : ""}`;
    }
    return hint ? `Approved ${item}, ${hint}${ref ? `, id ${ref}` : ""}` : `Approved ${item}${ref ? `, id ${ref}` : ""}`;
  }
  if (actionType === "CREATE_APPROVE") {
    return hint
      ? `Created and approved ${item}, ${hint}${ref ? `, id ${ref}` : ""}`
      : `Created and approved ${item}${ref ? `, id ${ref}` : ""}`;
  }
  if (ACTION_VERBS[actionType] && !["CREATE", "UPDATE", "MODIFY", "DELETE", "APPROVE"].includes(actionType)) {
    const customVerb = ACTION_VERBS[actionType];
    return hint
      ? `${customVerb} ${item}, ${hint}${ref ? `, id ${ref}` : ""}`
      : `${customVerb} ${item}${ref ? `, id ${ref}` : ""}`;
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

  if (isStockAdjustmentEntity(entity)) {
    const sa = buildStockAdjustmentLog(extra, record);
    if (sa.info) log_data.info = sa.info;
    if (sa.more) log_data.more = sa.more;
  } else if (entity === "qc_hold_material") {
    const qh = buildQcHoldLog(extra, record);
    if (qh.info) log_data.info = qh.info;
    if (qh.more) log_data.more = qh.more;
  } else if (isOverrideCustomerContext(entity, actionType)) {
    const oc = buildOverrideCustomerLog(extra, record);
    if (oc.info) log_data.info = oc.info;
    if (oc.more) log_data.more = oc.more;
  } else {
    const info = buildInfo(actionType, record, extra);
    if (info) log_data.info = info;
  }

  if (extra?.approval_only === true) {
    log_data.info = { ...(log_data.info || {}), Event: "Approval only" };
  }

  return {
    description,
    log_data,
    entity_id: ref || (numeric != null ? String(numeric) : null),
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
