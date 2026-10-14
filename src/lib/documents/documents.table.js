import dbQuery from "../../config/db/db.js";
import { patchTableSchema, patchCol } from "../../config/db/ensureDbColumns.js";
import { DOC_FILE_LINKS, hasFileColumn } from "./documents.config.js";

async function createTable() {
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS documents (
      uuid              VARCHAR(80) PRIMARY KEY,
      doc_path          VARCHAR(500) NOT NULL,
      doc_type          VARCHAR(10) NOT NULL DEFAULT '',
      doc_size          BIGINT NOT NULL DEFAULT 0,
      remark            VARCHAR(500),
      mod_type          VARCHAR(50) NOT NULL,
      mod_ref           VARCHAR(100) NOT NULL,
      created_by        BIGINT,
      created_by_name   VARCHAR(255),
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      status            BOOLEAN NOT NULL DEFAULT true
    );
    CREATE INDEX IF NOT EXISTS documents_mod_ref_status_idx ON documents (mod_type, mod_ref, status);
  `);

  // File column on each module table in DOC_FILE_LINKS (doc_files JSONB, or one VARCHAR per slot). `register` modules have none.
  for (const cfg of Object.values(DOC_FILE_LINKS)) {
    if (!hasFileColumn(cfg)) continue;
    const columns = cfg.multi
      ? [patchCol(cfg.multi, "JSONB NULL")]
      : Object.values(cfg.slots).map((s) => patchCol(s.col, "VARCHAR(60) NULL"));
    await patchTableSchema(dbQuery, cfg.table, { columns });
  }
}

let running = null;

/** Boot (initDB) — and again whenever `documents` / a file column is found missing at runtime. Concurrent calls share one run. */
export function createDocumentsTable() {
  running ??= createTable().finally(() => {
    running = null;
  });
  return running;
}

/** Postgres "relation / column does not exist" for the documents structure (e.g. DB restored from an old backup). */
const isMissingDocsStructure = (err) =>
  (err?.code === "42P01" && /documents/i.test(err.message)) ||
  (err?.code === "42703" && /doc_files|tc_file|rmtc_file/i.test(err.message));

/** Run `fn`; if the documents table / file column is missing, create it once and retry. */
export async function withDocumentsTable(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingDocsStructure(err)) throw err;
    console.warn(`[documents] ${err.message} — creating documents structure and retrying`);
    await createDocumentsTable();
    return fn();
  }
}
