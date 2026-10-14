# v5.0.0 — Documents backfill · removed file path columns

**File:** `docFileBackfill.js` — auto job: runs on every boot while `package.json` is `5.0.0` (`runVersionMigrations()`).
Safe to re-run: once everything is migrated, a boot changes nothing.

## What happened

Uploaded files now live only in the `documents` table. Each module record keeps the file names in `doc_files` (many files) or `tc_file` / `rmtc_file` (one per slot).
The old columns that stored full file paths are no longer read or written by any code, so the backfill removes them.

## What it does

1. Copies every file from the old path columns into `documents`, renamed to `<uuid>.<ext>`, and fills the new file column on the record.
2. Deletes the old-named file from disk (only after the transaction commits).
3. Drops the old path columns below.

## Columns removed

| Table | Removed column(s) | Replaced by |
|-------|-------------------|-------------|
| `rmstore_mrn` | `tc_file_path`, `rmtc_file_path`, `tc_file_name`, `rmtc_file_name` | `tc_file`, `rmtc_file` + `documents` |
| `rmstore_stock_adjustment` | `tc_file_path`, `rmtc_file_path`, `tc_file_name`, `rmtc_file_name` | `tc_file`, `rmtc_file` + `documents` |
| `task_chat` | `attachments` | `doc_files` + `documents` |
| `rmstore_in_process_request` | `attachments` | `doc_files` + `documents` |
| `ims_gate_entry` | `receiving_file` | `doc_files` + `documents` (`receiving_meta` stays) |
| `eng_machine_master` | `attachments` | `doc_files` + `documents` |
| `task_cl_tasks_master` | `attachment` | `doc_files` + `documents` (API still returns `attachment`) |
| `rmstore_qc_check` | none — `items` holds checklist values and stays | `items[].document_id` + `doc_files`; `items[].document_note` is cleared |

**Not changed** (`register` modules — they keep their own JSON list, each file also gets a `documents` row):
`task_self_notes.attachments`, `task_recurring_task_chat.attachments`, `task_cl_tasks.form_responses` (and instance snapshot `task_cl_tasks.attachment`).

Table setup no longer creates the removed columns (`ims_gate_entry.receiving_file` used to be re-added on every boot).
API responses keep the same fields (`tc_file_path`, `receivingfile`, `attachments`, …), now built from `documents` — the frontend needs no change.
Only visible difference: Stock Adjustment cards show "TC Document" / "RMTC Document" instead of the original file name.

## When a column is NOT dropped

| Situation | Result | Log |
|-----------|--------|-----|
| A file failed to copy / save | Kept; retried on next boot | `old paths kept (N file(s) failed)` |
| More than half of a module's old files missing on disk (wrong `UPLOAD_PATH`) | Kept | `old paths kept — N of M old file(s) not on disk. Check UPLOAD_PATH` |
| A few old files missing on disk (deleted long ago) | **Dropped**; each lost record + path logged (also `combined.log`) | `N old file(s) not on disk, not migrated (record path): …` |
| The drop itself fails (e.g. a view uses the column) | Kept; rest of the backfill still saved | `old path columns kept — drop failed: …` |

Success, per table: `✅ [v5.0.0] documents → <table>: old column(s) dropped (…)`

## Before deploy

1. Back up the DB (`pg_dump`) **and** the `uploads` folder — the drop and the file rename cannot be undone by code.
2. Check `UPLOAD_PATH` in the live `.env` points to the real uploads folder.
3. Do **not** drop the `documents` table — the backfill converts an old one.

## Check after deploy (should return no rows)

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'public' AND (
  (table_name IN ('rmstore_mrn','rmstore_stock_adjustment') AND column_name IN ('tc_file_path','rmtc_file_path','tc_file_name','rmtc_file_name'))
  OR (table_name IN ('task_chat','rmstore_in_process_request','eng_machine_master') AND column_name = 'attachments')
  OR (table_name = 'task_cl_tasks_master' AND column_name = 'attachment')
  OR (table_name = 'ims_gate_entry' AND column_name = 'receiving_file')
);
```

## Rollback

Going back to a version before 5.0.0 needs **both** backups restored (DB + `uploads`).

## When done

All envs migrated → bump the version (the job stops running) or delete `docFileBackfill.js`.
Manual re-run after a version bump: uncomment `backfillDocFiles()` in `initDB.js` (section 5).

More: `lib/documents/README.md` (documents module), `lib/documents/FLOW.md` (per-module file flow).
