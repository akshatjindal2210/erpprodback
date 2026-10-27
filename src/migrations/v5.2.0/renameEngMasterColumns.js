/**
 * Rename eng_process_master + eng_machine_master columns (RENAME COLUMN — data preserved).
 * Idempotent via renameColumnIfExists. Rollback: export `down`.
 */
import dbQuery from "../../config/db/db.js";
import { ENGINEERING_TABLES as T } from "../../config/db/dbTables.js";
import { renameColumnIfExists } from "../../config/db/ensureDbColumns.js";

const PROCESS_UP = [
  { from: "ProcCode", to: "proccode" },
  { from: "ProcName", to: "procname" },
];
const PROCESS_DOWN = [
  { from: "proccode", to: "ProcCode" },
  { from: "procname", to: "ProcName" },
];

const MACHINE_UP = [
  { from: "id", to: "maccode" },
  { from: "number", to: "macno" },
  { from: "speed", to: "cavity" },
  { from: "duration", to: "maccycletime" },
  { from: "process_id", to: "macproccode" },
];
const MACHINE_DOWN = [
  { from: "macproccode", to: "process_id" },
  { from: "maccycletime", to: "duration" },
  { from: "cavity", to: "speed" },
  { from: "macno", to: "number" },
  { from: "maccode", to: "id" },
];

async function applyRenames(table, pairs) {
  for (const { from, to } of pairs) {
    await renameColumnIfExists(dbQuery, table, from, to);
  }
}

/** Up — run on boot via runVersionMigrations (package version 5.2.0). */
export default async function up() {
  // Process PK first so machine FK column rename still resolves cleanly
  await applyRenames(T.PROCESS_MASTER, PROCESS_UP);
  await applyRenames(T.MACHINE_MASTER, MACHINE_UP);
}

/** Down — rollback renames (call manually if needed). */
export async function down() {
  await applyRenames(T.MACHINE_MASTER, MACHINE_DOWN);
  await applyRenames(T.PROCESS_MASTER, PROCESS_DOWN);
}
