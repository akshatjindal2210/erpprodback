# Documents — flow per module (submit → read)

How a file goes from the upload screen into `documents`, and how it is shown again.
Setup and debugging: see `README.md` in this folder.

---

## 1. The common flow (all modules)

```
SUBMIT
  frontend  FormData (file + fields)
  route     multer → file on disk: uploads/<module folder>/<uuid>.<ext>
  stamp     images get "uploader name · IST time" (stampRmstoreUploadedFiles)
  save      ONE transaction:
              INSERT documents (uuid, doc_path = folder, doc_type, doc_size, remark,
                                mod_type = module, mod_ref = record id, created_by…)
              add "<uuid>.<ext>" to the module record (doc_files / tc_file / rmtc_file)

READ
  module row  → file names (<uuid>.<ext>)
  path        = config folder (DOC_FILE_LINKS) + name           ← no documents read, no JOIN
  metadata    = 1 batch query on documents (remark, uploader)   ← only when { metadata: true }
  API         returns the public path "uploads/…/<uuid>.<ext>"
  frontend    uploadUrl(path, moduleKey) → FILE_BASE_URL + path → served by the /uploads static route
```

| Action | `documents` | Module record |
|--------|-------------|---------------|
| Upload | new row | name added |
| Replace | old row `status = false`, new row | name swapped |
| Remove | row `status = false` | name removed (empty → `NULL`) |

Rows and files are never deleted by the documents module (history is kept).

### Where the path comes from — `listActiveDocuments` (documents.service.js)

```
listActive(ref, { metadata: true })
  1. readModuleFiles   SELECT key, doc_files FROM <module table> WHERE key = ANY(refs)
                       → [{ name: "aaa.jpg", folder: DOC_FILE_LINKS[mod].folder }]
  2. path              fileDocPath(folder, name) → "uploads/rmstore/qc/aaa.jpg"
  3. metadata          findByFileNames(names) → SELECT * FROM documents WHERE uuid = ANY(names)
  4. row               { ...documentsRow, doc_path: "uploads/rmstore/qc/aaa.jpg" }
  fallback             record has no file column value → rows straight from documents
                       (mod_type + mod_ref), path = fullDocPublicPath (folder + uuid)
```

`{ metadata: false }` (or `listPathsFromModuleFiles`) stops after step 2 — the `documents` table is not read at all.

### Module configuration — `DOC_FILE_LINKS` (documents.config.js)

| `mod_type` | Table | Key (= `mod_ref`) | File column | Folder |
|------------|-------|-------------------|-------------|--------|
| `rm_mrn_portal` | `rmstore_mrn` | `uid` | `tc_file`, `rmtc_file` (slots) | `uploads/rmstore/tc`, `uploads/rmstore/rmtc` |
| `rm_stock_adjustment` | `rmstore_stock_adjustment` | `adjustment_id` | `tc_file`, `rmtc_file` (slots) | same as MRN |
| `rm_qc_check` | `rmstore_qc_check` | `qc_check_uid` | `doc_files` | `uploads/rmstore/qc` |
| `rm_in_process_request` | `rmstore_in_process_request` | `ipr_uid` | `doc_files` | `uploads/rmstore/ipr` |
| `invoice_receiving` | `ims_gate_entry` | `uid` | `doc_files` | `uploads/ims/invoice-receiving` |
| `eng_machine_master` | `eng_machine_master` | `id` | `doc_files` | `uploads/eng/machine` |
| `tasks` | `task_chat` | `chat_id` | `doc_files` | `uploads/task_tasks/chat` |
| `task_self_note` | `task_self_notes` | `self_note_id` | — (`register`, own JSON `attachments`) | `uploads/task_tasks/self` |
| `task_recurring_chat` | `task_recurring_task_chat` | `chat_id` | — (`register`, own JSON `attachments`) | `uploads/task_recurring_tasks/chat` |
| `cl_task_master` | `task_cl_tasks_master` | `cl_task_id` | `doc_files` (multi; API field still `attachment`) | `uploads/task_cl_tasks/attachments` |
| `cl_task_fill` | `task_cl_tasks` | `instance_id` | — (`register`, inside `form_responses`) | `uploads/task_cl_tasks/attachments` |

**Two kinds of modules**

| Kind | Module record stores | Screen reads path from |
|------|----------------------|------------------------|
| File column (`doc_files` / slots) | `<uuid>.<ext>` only | folder + name (built by the backend) |
| `register` | its own JSON with the full `file_path` | that JSON; `documents` keeps a matching row for every file |

---

## 2. RM Store — MRN Portal (`rm_mrn_portal`)

**Submit**
```
MrnModal → POST mrn/upload-docs  (or mrn/save-sticker-draft)
  route       docUpload("rm_mrn_portal").fields([{ name: "tc" }, { name: "rmtc" }])
              → uploads/rmstore/tc/<uuid>.pdf, uploads/rmstore/rmtc/<uuid>.jpg   (field name = slot)
  controller  mergeMrnDocUploads (mrnSticker.controller.js)
                stampRmstoreUploadedFiles(req)
                upsertTcRmtcSlot(MODULE, { modRef: uid, slot: "tc",   file, remark })
                upsertTcRmtcSlot(MODULE, { modRef: uid, slot: "rmtc", file, remark })
  upsertTcRmtcSlot
    slot already has a file → replaceDocument (old row status = false, new row, tc_file swapped)
    slot empty              → saveDocuments  (new row, tc_file = "<uuid>.pdf")
    no file, remark only    → updateDocumentRemark
```
**Read**
```
findMrnByUid / list (mrn.model.js) → attachTcRmtcRow(s)(MODULE, rows, "uid")
  listActive → tc_file + folder → tc_file_path, rmtc_file_path, tc_remark, tc_uploaded_by_name …
Frontend → uploadUrl(tc_file_path, "rm_mrn_portal")
```

## 3. RM Store — Stock Adjustment (`rm_stock_adjustment`)

Same as MRN (TC / RMTC slots).
```
Submit  POST stock-adjustment/upload-docs → docUpload(...).fields(tc, rmtc)
        → uploadSaDocs (stockAdjustmentSticker.controller.js) → upsertTcRmtcSlot per slot
Read    stockAdjustment.model.js → attachTcRmtcRows(MODULE, rows, "adjustment_id")
```

## 4. RM Store — QC Check (`rm_qc_check`)

**Submit**
```
QcCheckModal → POST qc-check/submit  (or qc-check/approve)
  route       docUpload("rm_qc_check").any()   → uploads/rmstore/qc/<uuid>.<ext>
  controller  stampRmstoreUploadedFiles(req)
              each spec's file → document_note = toRmPublicUploadPath(file)   (temporary full path)
              persistQcItemsWithDocuments(checkId, evaluated, req)
                per spec: persistQcSpecDocument(MODULE, { modRef: checkId, docPath, remark, priorDocumentId })
                  same file as before → remark update only
                  new file, had one   → replaceDocument
                  new file, had none  → saveDocuments
                item saved as { …spec, document_id: "<uuid>.<ext>", document_note: null }
              replaceQcCheckItems → rmstore_qc_check.items (JSONB)
Result: documents row + rmstore_qc_check.doc_files ["<uuid>.<ext>"] + items[].document_id
```
**Read**
```
getQcCheck → enrichQcItemsWithDocuments(MODULE, qcCheckUid, items)
  rows = listActive(qcCheckUid, { metadata: true })      ← path + remark (see section 1)
  per item:
    document_id   → match by uuid  (byUuid)
    else document_note (very old item) → match by path (byPath)
    match → { document_id, document_note: rows.doc_path, document_remark }
    document_required item still without a file → gets an unmatched file (old data)
Frontend → uploadUrl(item.document_note, "rm_qc_check")
```
Example:
```
rmstore_qc_check 45: doc_files = ["aaa.jpg"], items = [{ spec: "Diameter", document_id: "aaa.jpg" }]
listActive(45)  → [{ uuid: "aaa.jpg", doc_path: "uploads/rmstore/qc/aaa.jpg", remark: "ok" }]
enrich          → { spec: "Diameter", document_id: "aaa.jpg", document_note: "uploads/rmstore/qc/aaa.jpg", document_remark: "ok" }
frontend        → http://<server>/uploads/rmstore/qc/aaa.jpg
```

## 5. RM Store — In-Process Request (`rm_in_process_request`)

**Submit**
```
POST in-process-request/create | update | approve
  route       docUpload("rm_in_process_request").array("attachments")
  controller  stampRmstoreUploadedFiles(req)
              paths = existing_attachments (kept) + new files (toRmPublicUploadPath)
              saveIprAttachmentsToDocuments → syncPathsFromList(MODULE, ipr_uid, paths, req)
                path not in list anymore → removeDocument (status = false)
                new path                 → saveDocuments
```
**Read**
```
inProcessRequest.model.js → attachPathListRow(s)(MODULE, rows, "ipr_uid")
  → attachments: [path, …], attachment_documents: [{ path, remark }]
```

## 6. IMS — Invoice Receiving (`invoice_receiving`)

**Submit**
```
POST invoice-receiving/update
  route       docUpload("invoice_receiving").array("attachments", 20)
  controller  mapMulterFilesWithRemarks(req)            (file_remarks[i] → remark of file i)
              syncDocumentPaths(irDocuments, { modRef: gate.uid, keepPaths, newFiles })
                kept files keep their saved remark; new files saved with their remark
Delete       irDocuments.removeAllActive(gate.uid)
```
**Read**
```
invoiceReceiving.controller.js
  one gate : irDocuments.listActive(gate.uid, { metadata: true })
  list     : irDocuments.listActiveMany(uids, { metadata: true })   (one batch for the page)
  → receivingfile (paths) + receiving_documents [{ path, remark }]
```

## 7. Engineering — Machine Master (`eng_machine_master`)

**Submit**
```
POST machine-master/create | update
  route       docUpload("eng_machine_master").array("attachments", 20)
  controller  stampRmstoreUploadedFiles(req)
              attachments = kept + mapUploadedFiles(req)
              syncAttachmentList(MODULE, id, attachments, req)   (same idea as syncPathsFromList)
```
**Read**
```
machineMaster.model.js → attachmentsFromDocuments(MODULE, id, row.attachments, "machine")
  → [{ id, uuid, file_name, path, size, remark, by }]   (falls back to row.attachments when none)
Frontend → FilePreviewLink (in-app preview)
```

---

## 8. Task app

### 8.1 Task chat / task create / task edit (`tasks`, file column `task_chat.doc_files`)

**Submit**
```
TaskModal → POST /tasks  |  POST /tasks/self  |  PUT /tasks/:id
SubPage   → POST /tasks/:id/chat
  route       chatUpload.array("attachments")  /  docUpload("tasks").array("files")
              → uploads/task_tasks/chat/<uuid>.<ext>
  controller  chat row first: Task.addChatMessage / sendChatMessage  (INSERT … RETURNING chat_id)
              persistTaskChatUploads(req, chat_id)
                stampRmstoreUploadedFiles(req)
                moduleDocuments("tasks").saveFiles(chat_id, mapMulterFilesWithRemarks(req), req)
Result: documents (mod_ref = chat_id) + task_chat.doc_files ["<uuid>.<ext>"]
```
`chat_id` must come from `RETURNING chat_id`. The generic `insertId` of `dbQuery` returns
`task_id` for `task_chat` rows (it checks `task_id` before `chat_id`), which links files to the wrong message.

**Read**
```
getChat (taskChat.controller.js) → Task.getChatMessages (selects c.doc_files)
  attachmentsForChatMessage(row)
    doc_files → folder + name → [{ file_name, file_path }]     ← no documents read
    no doc_files → attachmentsFromDocuments("tasks", chat_id, [], "task")
```

### 8.2 Recurring task → daily task (cron)
```
jobs/task/recurringTasks.cron.js
  copies task_recurring_task_chat rows into the new task:
    INSERT task_chat … RETURNING chat_id
    copyRecurringChatAttachments → uploads/task_tasks/chat/…
    moduleDocuments("tasks").saveFiles(chat_id, files, { userId })   ← same flow as 8.1
```

### 8.3 Recurring task chat (`task_recurring_chat`, register)
**Submit**
```
RecurringTaskModal → POST /tasks (is_recurring)  |  PUT /recurring-task/:id  |  remove-attachment API
  create  saveAttachments → uploads/task_recurring_tasks/chat/<uuid>.<ext>
  model   RecurringTask.addChatMessage(…, attachments)      → syncRegisteredFiles(MODULE, chat_id, list)
          RecurringTask.updateChatAttachments(chat_id, list) → syncRegisteredFiles (removed → status = false)
```
**Read**: `task_recurring_task_chat.attachments` JSON (full `file_path`), unchanged.

### 8.4 Personal note (`task_self_note`, register)
**Submit**
```
SubPage → PUT /tasks/:id/self-note  (files + remove_files)
  route       selfUpload.array("files") → uploads/task_tasks/self/<uuid>.<ext>
  controller  stampRmstoreUploadedFiles(req)
              merged = kept attachments + new files
              Task.upsertSelfNote(…, merged)          → task_self_notes.attachments
              syncRegisteredFiles("task_self_note", self_note_id, merged, req)
Delete       syncRegisteredFiles(…, [])  (all rows status = false)
```
**Read**: `task_self_notes.attachments` JSON, unchanged.

### 8.5 CL task master (`cl_task_master`, multi) + fill (`cl_task_fill`, register)
**Submit**
```
ClTaskModal → POST cl-task/create | update
  route       docUpload("cl_task_master").array("attachments") → uploads/task_cl_tasks/attachments/<uuid>.<ext>
  controller  stamp → attachment = kept + new → createMaster / updateMaster (no master attachment column)
              syncAttachmentList("cl_task_master", cl_task_id, …) → documents + doc_files
              pending instances still get a snapshot on task_cl_tasks.attachment

ClTaskSubmitModal / ClTaskHistoryEditModal / ClVerificationFormModal
  → POST cl-task/submit | submission-update   (field name e<entry>__<fieldId>)
  controller  stamp → mergeEntryUploadedFiles → form_responses
              registerUploadedFiles("cl_task_fill", instance_id, files, req)   (adds rows, no removal tracking)
```
**Read**: master `attachment` from documents; instance uses its snapshot or falls back to master docs.

### `syncRegisteredFiles` (register modules)
```
active = documents rows of (mod_type, ref)
JSON list path missing from active  → saveFiles (new row)
active row not in JSON list         → removeFile (status = false)
remark changed                      → updateDocumentRemark
file saved under a new name (old name / name already used by another record)
                                    → new path written back to the module JSON (updateRegisterJson)
errors are logged, never thrown — the module JSON stays the source for the screen
```

---

## 9. Safety nets

| Situation | What happens |
|-----------|--------------|
| `documents` table / file column missing (DB restored from an old backup) | `withDocumentsTable` creates it and retries the call once |
| Old data (paths in old columns) | `migrations/v5.0.0/docFileBackfill.js` on boot copies it into `documents`; safe to re-run |
| Old path columns (`tc_file_path`, `attachments` of task chat / IPR / machine, CL master `attachment`, gate `receiving_file`) | dropped by the backfill once every file still on disk is in `documents` (failed file → kept; file gone from disk → logged, not blocking) |
| Same image stamped twice in one request | `stampRmstoreUploadedFiles` runs once per request |
