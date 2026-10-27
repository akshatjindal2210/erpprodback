# Documents module

One common module for every file upload: MRN, Stock Adjustment, QC Check, In-Process Request, Invoice Receiving, Machine Master, **Task** (chat / self-note / recurring), and **CL Task** (master + fill).

Apps import **only** `lib/documents/index.js`. Config registry: `documents.config.js` → `DOC_FILE_LINKS`.

---

## Files

| File | What is in it |
|------|---------------|
| `index.js` | Public API — the only import for apps and boot |
| `documents.config.js` | **Which modules have uploads**: table, key, file column(s), folder, allowed types, max size |
| `documents.table.js` | **Table structure only** — `documents` table + module file columns (every boot, from `initDB.js`) |
| `documents.model.js` | All SQL (`documents` table + module file columns) |
| `documents.service.js` | Core flow: save / replace / remove / list — one transaction per write |
| `documents.helpers.js` | What controllers call: `moduleDocuments()`, path lists (IPR, Invoice Receiving), TC/RMTC, QC, attachments (Machine, Task) |
| `documents.upload.js` | `docUpload(MODULE)` — multer (folder, types, size, `<uuidv7>.<ext>` name) |
| `documents.utils.js` | uuid file names, upload paths on disk, uploader / remarks from the request |

One-time fix for old data: `migrations/v5.0.0/docFileBackfill.js` — auto migration of v5.0.0 (runs on boot via `runVersionMigrations()`, safe to re-run). Moves old file paths from module tables (and old `documents` rows) into the new format.

**Pattern for any future global module:** `lib/<name>/` with `index.js`, `README.md` and `<name>.config.js` · `<name>.table.js` · `<name>.model.js` · `<name>.service.js` (+ `helpers` / `upload` / `utils` only if needed).

---

## How it works

```
route        docUpload(MODULE).array("attachments")   → uploads/<module folder>/<uuidv7>.<ext>
controller   moduleDocuments(MODULE).saveFiles(recordId, mapMulterFilesWithRemarks(req), req)
service      one transaction:
               INSERT documents (uuid, doc_path, doc_type, doc_size, remark, mod_type, mod_ref, created_by…)
               add "<uuid>.<ext>" to the module record (doc_files JSONB, or tc_file / rmtc_file)
read         Module row: `<uuid>.<ext>` only (slots or `doc_files` JSONB). Public path = `DOC_FILE_LINKS[mod].folder` + name.
metadata     `listActiveDocuments(..., { metadata: true })` → batch `findByFileNames` (remark, size, id, uploader). Default is path-only.
path-only    `listPathsFromModuleFiles` or `listActiveDocuments` without `metadata: true` — never reads `documents`.
remarks      Stored in `documents.remark`; **Invoice Receiving** UI sends/shows per-file remarks.
```

**No SQL JOIN:** module tables never store full paths after v5 backfill (legacy path columns dropped). `documents.doc_path` = folder only; `documents.uuid` = `<uuid>.<ext>`. Display path = config folder + module file name.

| Action | `documents` | Module record |
|--------|-------------|---------------|
| Upload | new row | name added |
| Replace | old row `status = false`, new row | name swapped |
| Remove | row `status = false` | name removed (empty → `NULL`) |
| **Parent delete** | all active rows for that `mod_ref` → `status = false` via `deactivateModuleDocuments(MODULE, ref)` / `moduleDocuments(MODULE).removeAllActive(ref)` **before** soft/hard delete | file columns cleared |

Rows and physical files are never deleted.

### `documents` table

| Column | Meaning |
|--------|---------|
| `uuid` | Primary key — file id `<uuid>.<ext>` (e.g. `01a12f51-….jpg`) |
| `doc_path` | Module folder only (e.g. `uploads/rmstore/tc/`) |
| `doc_type` | Extension (`pdf`, `jpg`, …) |
| `doc_size` | Size in KB |
| `remark` | Per-file note |
| `mod_type` / `mod_ref` | Module name (= route `MODULE`) / record id as text |
| `created_by`, `created_by_name`, `created_at` | Uploader and time. Rows moved by the backfill: `created_by = NULL`, `created_by_name = system` |
| `status` | `true` active · `false` replaced / removed |

---

## Common changes

| Need | Do this |
|------|---------|
| **New module with attachments** | 1. Add it to `DOC_FILE_LINKS` in `documents.config.js` (`table`, `key`, `multi: "doc_files"` + `folder`, `exts`). 2. Route: `docUpload(MODULE).array("attachments", 20)`. 3. Controller: `moduleDocuments(MODULE).saveFiles(id, mapMulterFilesWithRemarks(req), req)`; show with `listActive(id)` or `attachmentsFromDocuments(MODULE, id)`. 4. Restart — the column is created by `documents.table.js`. |
| **One file per slot** (like TC / RMTC) | Use `slots: { name: { col, folder } }` instead of `multi`; the multer field name picks the slot. Save with `upsertTcRmtcSlot`. |
| **New file type** | Add it to the module's `exts` (or a shared `EXT` list). Add the same extension in `frontend/src/lib/documents/index.js` (`CFG` for that module). |
| **Bigger files** | `maxMb` on the module entry, or `DEFAULT_MAX_MB` for all. |
| **Folder path change** | `documents.config.js` only for v5 modules; re-run / adjust backfill if old rows need moving. Also check legacy helpers (QC/IPR/IR) if they still hardcode a folder string. |

**Frontend (preview + file input only):** `frontend/src/lib/documents/index.js` — keep `CFG` in sync with `DOC_FILE_LINKS`. Import `uploadUrl`, `uploadAccept` from `@/lib/documents`. Backend validates type/size; FE does not duplicate that logic.

---

## Debugging

```sql
-- files on a record
SELECT doc_files FROM rmstore_in_process_request WHERE ipr_uid = 123;  -- multi
SELECT tc_file, rmtc_file FROM rmstore_mrn WHERE uid = '4130_1';       -- slots

-- their rows (incl. replaced / removed)
SELECT uuid, doc_path, doc_type, status, remark, created_by_name, created_at
FROM documents WHERE mod_type = 'rm_in_process_request' AND mod_ref = '123' ORDER BY created_at;
```

| Symptom | Check |
|---------|-------|
| File not shown | Name in the module column **and** a `documents` row with that uuid and `status = true`? (A name without its row is hidden.) |
| "Invalid file type" | Extension not in the module's `exts`, or an unknown slot field name. |
| "File is too large" | The module's `maxMb` / `DEFAULT_MAX_MB`. |
| Log `[documents] … file not on disk, skipped` | An old path whose file is gone (e.g. after `uploads` was cleared). It is skipped so the save still works; nothing to fix unless the file should exist. |
| File missing on disk | `doc_path` is under `UPLOAD_PATH/uploads/`; folders are created automatically. |
| Column missing / `relation "documents" does not exist` | Created automatically on the next documents call (`withDocumentsTable`, e.g. after a DB restore) and on every boot. |
| After the backfill | Log `✅ [v5.0.0] documents → <n> files (<module> <n>, …), <n> missing on disk` — printed only when something was moved; nothing to do = no line. |
| Legacy columns | Backfill step **G** drops every old path column of a table that has `doc_files` / `tc_file`: `tc_file_path` / `rmtc_file_path` / `*_file_name` (MRN, SA), `attachments` (Task chat, IPR, Machine), `attachment` (CL master) and `receiving_file` (Gate Entry / IR), once every file in them that exists on disk is in `documents`. QC keeps `items` (checklist values) — only `document_note` of a file gone from disk is cleared. A failed file keeps them (warning, retried next boot); a file gone from disk is logged (record + path, combined.log) and does not block — unless more than half of the module's files are missing (wrong `UPLOAD_PATH`) → kept. Table init never adds them back; no code reads or writes them. |

**`register` modules** (`task_self_note`, `task_recurring_chat`, `cl_task_fill`): the module keeps its own JSON list; every file also gets a `documents` row via `syncRegisteredFiles` / `registerUploadedFiles`, and the backfill covers them. **`cl_task_master`** is multi (`doc_files`); legacy `attachment` is dropped by the backfill. Not stored: holiday CSV import (read in memory), HRMS device events.
