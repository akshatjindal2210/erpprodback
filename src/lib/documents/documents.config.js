/**
 * Which modules have uploads — the ONE place to configure them.
 *
 * module (`mod_type`, = route MODULE) → {
 *   table, key        module table and its id column (= documents.mod_ref)
 *   multi + folder    many files → JSONB array column (`doc_files`)
 *   slots             one file per slot → own column + folder (slot = multer field name, e.g. tc / rmtc)
 *   register + folder no file column: the module keeps its own JSON (`jsonCol`, list of `{ file_path, … }`) and every file also gets a
 *                     `documents` row (mod_ref = record id). Task self-note, recurring chat, CL form-fill.
 *   exts              allowed extensions (lowercase, no dot)
 *   maxMb             optional, default DEFAULT_MAX_MB
 * }
 * The module record stores `<uuid>.<ext>`; the file is at `<folder>/<uuid>.<ext>`.
 */
import path from "path";
import { IMS_TABLES as I, RMSTORE_TABLES as R, TASK_TABLES as TaskT, ENGINEERING_TABLES as E } from "../../config/db/dbTables.js";

const UUID_FILE_BASENAME_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.[a-z0-9]+)?$/i;

export const DEFAULT_MAX_MB = 20;

const EXT = {
  pdfImage: ["pdf", "png", "jpg", "jpeg", "webp"],
  pdfImageWord: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "doc", "docx"],
  office: ["pdf", "png", "jpg", "jpeg", "webp", "gif", "doc", "docx", "xls", "xlsx", "txt", "csv"],
};

const TC_RMTC = {
  tc: { col: "tc_file", folder: "uploads/rmstore/tc" },
  rmtc: { col: "rmtc_file", folder: "uploads/rmstore/rmtc" },
};

export const DOC_FILE_LINKS = {
  rm_mrn_portal: { table: R.MRN, key: "uid", slots: TC_RMTC, exts: EXT.pdfImage },
  rm_stock_adjustment: { table: R.STOCK_ADJUSTMENT, key: "adjustment_id", slots: TC_RMTC, exts: EXT.pdfImage },
  rm_qc_check: { table: R.QC_CHECK, key: "qc_check_uid", multi: "doc_files", folder: "uploads/rmstore/qc", exts: EXT.pdfImage },
  rm_in_process_request: { table: R.IN_PROCESS_REQUEST, key: "ipr_uid", multi: "doc_files", folder: "uploads/rmstore/ipr", exts: EXT.pdfImage },
  invoice_receiving: { table: I.GATE_ENTRY, key: "uid", multi: "doc_files", folder: "uploads/ims/invoice-receiving", exts: EXT.pdfImageWord },
  eng_machine_master: { table: E.MACHINE_MASTER, key: "id", multi: "doc_files", folder: "uploads/eng/machine", exts: EXT.office },
  tasks: { table: TaskT.CHAT, key: "chat_id", multi: "doc_files", folder: "uploads/task_tasks/chat", exts: EXT.pdfImageWord },
  task_self_note: { table: TaskT.SELF_NOTES, key: "self_note_id", register: true, jsonCol: "attachments", folder: "uploads/task_tasks/self", exts: EXT.pdfImageWord },
  task_recurring_chat: { table: TaskT.RECURRING_TASK_CHAT, key: "chat_id", register: true, jsonCol: "attachments", folder: "uploads/task_recurring_tasks/chat", exts: EXT.pdfImageWord },
  cl_task_master: { table: TaskT.CL_TASKS_MASTER, key: "cl_task_id", multi: "doc_files", folder: "uploads/task_cl_tasks/attachments", exts: EXT.pdfImageWord },
  cl_task_fill: { table: TaskT.CL_TASKS, key: "instance_id", register: true, folder: "uploads/task_cl_tasks/attachments", exts: EXT.pdfImageWord },
};

/** Module has its own file column(s) (`doc_files` / slots) — false for `register` modules. */
export const hasFileColumn = (cfg) => Boolean(cfg && !cfg.register && (cfg.multi || cfg.slots));

/** Slot (`tc` / `rmtc`) from an upload path, or null. */
export const slotOf = (p) => (/\/rmtc\//i.test(p) ? "rmtc" : /\/tc\//i.test(p) ? "tc" : null);

/** Folder for a module file: multi / register → its folder · slots → the slot's folder (null if unknown). */
export function folderOf(modType, slot = null) {
  const cfg = DOC_FILE_LINKS[modType];
  if (!cfg) return null;
  return cfg.slots ? cfg.slots[String(slot ?? "").toLowerCase()]?.folder ?? null : cfg.folder ?? null;
}

/** Module column + `documents.uuid`: lowercase `<uuid>.<ext>`. */
export function docFileName(doc) {
  const u = String(doc?.uuid ?? "").trim().toLowerCase();
  if (UUID_FILE_BASENAME_RE.test(u)) return u;
  const fromPath = path.basename(String(doc?.doc_path ?? "").replace(/\\/g, "/")).toLowerCase();
  if (UUID_FILE_BASENAME_RE.test(fromPath)) return fromPath;
  const ext = String(doc?.doc_type ?? "").replace(/^\./, "").toLowerCase();
  const uid = String(doc?.uuid ?? "").trim().toLowerCase();
  if (!uid) return fromPath || "";
  return ext && !uid.includes(".") ? `${uid}.${ext}` : uid;
}

/** `<folder>/<name>`. */
export const fileDocPath = (folder, name) => path.posix.join(folder, name);
