/**
 * One-time: if eng_* master tables empty → pull ERP list → store in DB.
 * Safe to re-run (skips when rows exist). Comment `export default` body to disable.
 */
import dbQuery from "../../config/db/db.js";
import { fetchFromIMS } from "../../apps/ims/lib/services/ims.service.js";

async function setSerial(table, col) {
  const [local] = await dbQuery(`SELECT COALESCE(MAX(${col}), 0)::int AS m FROM ${table}`);
  const [seq] = await dbQuery(`SELECT pg_get_serial_sequence($1, $2) AS s`, [table, col]);
  if (seq?.s && Number(local?.m) > 0) {
    await dbQuery(`SELECT setval($1::regclass, $2, true)`, [seq.s, Number(local.m)]);
  }
}

async function pull(requestedData, table, col, insertRow) {
  const [cnt] = await dbQuery(`SELECT COUNT(*)::int AS c FROM ${table}`);
  if (Number(cnt?.c) > 0) return;

  const rows = await fetchFromIMS(requestedData);
  for (const r of rows) await insertRow(r);
  await setSerial(table, col);
  console.log(`[migration] seedErpMasters: ${requestedData} → ${table} (${rows.length})`);
}

export default async function seedErpMasters() {
  // Comment out calls below to turn OFF.
  await pull("mstproc", "eng_process_master", "proccode", async (r) => {
    const proccode = Number(r.proccode);
    const procname = String(r.procname ?? "").trim();
    if (!proccode || !procname) return;
    await dbQuery(
      `INSERT INTO eng_process_master (proccode, procname, approved, created_by, created_at)
       VALUES ($1, $2, false, 'System', NOW()) ON CONFLICT (proccode) DO NOTHING`,
      [proccode, procname]
    );
  });

  await pull("mstmac", "eng_machine_master", "maccode", async (r) => {
    const maccode = Number(r.maccode);
    const macname = String(r.macname ?? "").trim().toUpperCase();
    const macno = String(r.macno ?? macname).trim().toUpperCase();
    const macproccode = Number(r.macproccode);
    if (!maccode || !macname || !macno || !macproccode) return;
    try {
      await dbQuery(
        `INSERT INTO eng_machine_master (maccode, macname, macno, cavity, maccycletime, macproccode, approved, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, 'System', NOW()) ON CONFLICT (maccode) DO NOTHING`,
        [
          maccode, macname, macno,
          r.cavity != null && r.cavity !== "" ? String(r.cavity) : null,
          Number(r.maccycletime) > 0 ? Number(r.maccycletime) : 60,
          macproccode,
        ]
      );
    } catch (e) {
      console.warn(`[migration] seedErpMasters skip maccode=${maccode}:`, e?.message || e);
    }
  });
}
