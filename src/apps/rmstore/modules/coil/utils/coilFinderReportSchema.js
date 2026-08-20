/**
 * Coil Finder Report — single control panel for all sections.
 *
 * How to change the report later:
 *  - Add / remove / reorder a field → edit the FIELDS array for that section
 *  - Add a table column → edit QC_SPEC_COLUMNS (key, title, width, get)
 *  - Add a whole section → add to REPORT_SECTIONS + render it in HTML/PDF builders
 *  - Empty values are dropped automatically (hasValue)
 *
 * Both HTML preview and PDF download read from this file so they stay in sync.
 */

export const REPORT_SECTIONS = [
  { id: "ipr_photos", title: "In-process rejection photos" },
  { id: "coil_details", title: "Coil Details" },
  { id: "qc_checks", title: "QC N Check Details" },
  { id: "attachments", title: "Attached Documents (TC / RMTC / QC)" },
];

export function numberedSectionTitle(id, { hasIprPhotos } = {}) {
  const shift = hasIprPhotos ? 1 : 0;
  const titles = {
    ipr_photos: "1. In-process rejection photos",
    coil_details: `${1 + shift}. Coil Details`,
    qc_checks: `${2 + shift}. QC N Check Details`,
    attachments: `${3 + shift}. Attached Documents (TC / RMTC / QC)`,
  };
  return titles[id] || sectionTitle(id);
}

export function sectionTitle(id) {
  return REPORT_SECTIONS.find((s) => s.id === id)?.title || id;
}

export function hasValue(v) {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== "" && s !== "—" && s !== "-";
}

/** Calendar date only (DD/MM/YYYY) — no timezone shift for YYYY-MM-DD / date columns. */
export function formatHumanDate(v) {
  if (v == null || v === "") return null;
  try {
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return `${String(v.getDate()).padStart(2, "0")}/${String(v.getMonth() + 1).padStart(2, "0")}/${v.getFullYear()}`;
    }
    const s = String(v).trim();
    if (!s || /invalid/i.test(s)) return null;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
    const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
    if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(s);
    if (iso) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
      }
    }
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Human-readable date/time for Create / Update / Approve (en-IN). */
export function formatHumanDateTime(v) {
  if (v == null || v === "") return null;
  try {
    const s = String(v).trim();
    // Date-only values must not invent a clock time (UTC midnight → wrong local day/time).
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      return formatHumanDate(s);
    }
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
}

export function qcExpected(spec) {
  const t = String(spec?.spec_type || "").toLowerCase();
  if (t === "min") return `>= ${Number(spec?.min_value) || 0}`;
  if (t === "max") return `<= ${Number(spec?.max_value) || 0}`;
  if (t === "range") return `${Number(spec?.min_value) || 0} - ${Number(spec?.max_value) || 0}`;
  if (t === "dropdown") {
    return (
      String(spec?.correct_option || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .join(" | ") || "-"
    );
  }
  const pv = spec?.print_val;
  return pv != null && String(pv).trim() ? String(pv).trim() : "-";
}

export function qcLineResult(spec) {
  const stored = String(spec?.result || "").toLowerCase();
  if (stored === "pass" || stored === "fail") return stored;
  const t = String(spec?.spec_type || "").toLowerCase();
  const actualText = spec?.actual_value == null ? "" : String(spec.actual_value).trim();
  if (!actualText) return null;
  if (t === "dropdown") {
    const actualUpper = actualText.toUpperCase();
    const ok = String(spec?.correct_option || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .some((opt) => opt === actualUpper);
    return ok ? "pass" : "fail";
  }
  const n = Number(actualText);
  if (!Number.isFinite(n)) return "fail";
  const min = Number(spec?.min_value);
  const max = Number(spec?.max_value);
  if (t === "min") return n >= (Number.isFinite(min) ? min : 0) ? "pass" : "fail";
  if (t === "max") return n <= (Number.isFinite(max) ? max : 0) ? "pass" : "fail";
  if (t === "range") {
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 0;
    return n >= lo && n <= hi ? "pass" : "fail";
  }
  return "fail";
}

export function qcOverall(check) {
  const st = String(check?.status || "").toLowerCase();
  if (st === "passed" || st === "pass") return "pass";
  if (st === "failed" || st === "fail") return "fail";
  const rs = (check?.items || []).map(qcLineResult).filter(Boolean);
  if (rs.length && rs.every((r) => r === "pass")) return "pass";
  if (rs.some((r) => r === "fail")) return "fail";
  return null;
}

/**
 * Resolve declarative field defs → { label, value }[] (empties dropped).
 * @param {Array<{ key: string, label: string, get: Function }>} fieldDefs
 * @param {*} ctx
 */
export function resolveFields(fieldDefs, ctx) {
  return (fieldDefs || [])
    .map((f) => {
      let value;
      try {
        value = f.get(ctx);
      } catch {
        value = null;
      }
      const str = value == null || String(value).trim() === "" ? null : String(value);
      return {
        key: f.key,
        label: f.label,
        value: str || (f.always ? "—" : null),
        always: !!f.always,
      };
    })
    .filter((row) => row.always || hasValue(row.value));
}

/**
 * Resolve table columns → string cell values for one row.
 * @param {Array<{ key: string, get: Function }>} columns
 * @param {*} rowCtx
 */
export function resolveRowCells(columns, rowCtx) {
  return (columns || []).map((col) => {
    let value;
    try {
      value = col.get(rowCtx);
    } catch {
      value = null;
    }
    if (value == null || String(value).trim() === "") return "-";
    return String(value);
  });
}

// ─── Section field / column definitions (edit these to change the report) ───

/** Coil detail rows — used by data loader + HTML + PDF. */
export const COIL_DETAIL_FIELDS = [
  { key: "mrn_uid", label: "MRN UID", get: (c) => c.mrn_uid || null },
  { key: "mrn_dt", label: "MRN Date", get: (c) => formatHumanDate(c.mrn_dt) || null },
  { key: "heat_no", label: "Heat No", get: (c) => c.heat_no },
  { key: "item_code", label: "Item Code", get: (c) => c.item_code },
  { key: "item_desc", label: "Description", get: (c) => c.item_desc },
  // Never expose internal ids: item_dcode, acc_code — only vendor name (header) + item_code/name.
  { key: "qty", label: "Qty", get: (c) => c.qty },
  { key: "bill_no", label: "Bill Number", get: (c) => c.bill_no || null },
  {
    key: "bill_dt",
    label: "Bill Date",
    get: (c) => formatHumanDate(c.bill_dt) || null,
  },
  { key: "qc_id", label: "QC ID", get: (c) => (c.qc_uid != null ? `QC-${c.qc_uid}` : null) },
  { key: "qc_status", label: "QC Status", get: (c) => c.qc_check_status },
  // { key: "status", label: "Status", get: (c) => c.status },
  { key: "pjobcardno", label: "Job Card", get: (c) => c.pjobcardno },
  { key: "macname", label: "Machine", get: (c) => c.macname },
  {
    key: "created_at",
    label: "Created At",
    get: (c) => formatHumanDateTime(c.created_at),
  },
  {
    key: "updated_at",
    label: "Updated At",
    get: (c) => formatHumanDateTime(c.updated_at),
  },
];

/** QC check summary (meta) — HTML + PDF. Add/remove rows here. */
export const QC_SUMMARY_FIELDS = [
  {
    key: "qc_id",
    label: "QC ID",
    get: (check) => (check?.qc_check_uid != null ? `QC-${check.qc_check_uid}` : null),
  },
  { key: "status", label: "Status", get: (check) => check?.status || null },
  {
    key: "inspected_by",
    label: "Inspected By",
    always: true,
    get: (check) => check?.inspected_by_name || check?.inspected_by || null,
  },
  {
    key: "inspected_at",
    label: "Inspected At",
    always: true,
    get: (check) => formatHumanDateTime(check?.inspected_at),
  },
  {
    key: "approved_by",
    label: "Approved By",
    always: true,
    get: (check) => check?.approved_by_name || check?.approved_by || null,
  },
  {
    key: "approved_at",
    label: "Approved At",
    always: true,
    get: (check) => formatHumanDateTime(check?.approved_at),
  },
  {
    key: "created_at",
    label: "Created At",
    get: (check) => formatHumanDateTime(check?.created_at),
  },
  {
    key: "updated_at",
    label: "Updated At",
    get: (check) => formatHumanDateTime(check?.updated_at),
  },
  { key: "failure_reason", label: "Failure Reason", get: (check) => check?.failure_reason || null },
  { key: "remarks", label: "Remarks", get: (check) => check?.remarks || null },
];

/**
 * QC spec table columns.
 * pdfWidth = relative share of content width (normalized at draw time).
 * htmlClass optional CSS hint.
 */
export const QC_SPEC_COLUMNS = [
  {
    key: "sno",
    title: "#",
    pdfWidth: 28,
    get: (spec) => (spec.sno != null && String(spec.sno).trim() !== "" ? spec.sno : "-"),
  },
  {
    key: "spec",
    title: "SPEC",
    pdfWidth: 120,
    bold: true,
    get: (spec) => spec.spec_name || "-",
  },
  {
    key: "inspection_method",
    title: "INSPECTION METHOD",
    pdfWidth: 100,
    get: (spec) => spec.inspection_method != null && String(spec.inspection_method).trim() ? String(spec.inspection_method).trim().toUpperCase() : "-",
  },
  {
    key: "expected",
    title: "EXPECTED",
    pdfWidth: 110,
    mono: true,
    get: (spec) => qcExpected(spec),
  },
  {
    key: "actual",
    title: "ACTUAL",
    pdfWidth: 90,
    mono: true,
    get: (spec) => (spec.actual_value != null && String(spec.actual_value).trim() !== "" ? spec.actual_value : "-"),
  },
  {
    key: "result",
    title: "RESULT",
    pdfWidth: 80,
    bold: true,
    get: (spec) => {
      const r = qcLineResult(spec);
      return r ? r.toUpperCase() : "-";
    },
  },
];

/** Build coil detail rows for the payload (loader). */
export function buildCoilDetailRows(coil) {
  return resolveFields(COIL_DETAIL_FIELDS, coil || {});
}

/** Build QC summary rows for one check. */
export function buildQcSummaryRows(check) {
  return resolveFields(QC_SUMMARY_FIELDS, check || {});
}
