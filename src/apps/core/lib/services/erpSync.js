/** ERP sync — reuses IMS (erpInternalApi). Never throws. */
import dbQuery from "../../../../config/db/db.js";
import logger from "../utils/logging/logger.js";
import { fetchFromIMS, fetchImsDataRaw } from "../../../ims/lib/services/ims.service.js";

const ADD = {
  mstproc: ["eng_process_master", "proccode"],
  mstmac: ["eng_machine_master", "maccode"],
};

/** Before local INSERT: align PG sequence to ERP max so nextval = ERP last + 1 (not local MAX). */
export async function prepareErpAdd(requestedData) {
  const cfg = ADD[requestedData];
  if (!cfg) return;
  const [table, col] = cfg;
  try {
    const rows = await fetchFromIMS(requestedData);
    let erpMax = 0;
    for (const r of rows) {
      const n = Number(r?.[col]);
      if (n > erpMax) erpMax = n;
    }
    const [seq] = await dbQuery(`SELECT pg_get_serial_sequence($1, $2) AS s`, [table, col]);
    if (seq?.s) await dbQuery(`SELECT setval($1::regclass, $2, true)`, [seq.s, erpMax]);
  } catch (e) {
    logger.error(`[erpSync] prepareErpAdd: ${e?.message || e}`);
  }
}

/** After local CRUD → ERP add/update/delete. */
export async function syncToErp(type, data = {}, requestedData = "mstproc") {
  const filter = { type };
  for (const [k, v] of Object.entries(data)) if (v != null && v !== "") filter[k] = v;
  const json = await fetchImsDataRaw(requestedData, filter);
  const ok = Boolean(json?.success);
  if (!ok) logger.error(`[erpSync] fail ${requestedData} ${type}: ${json?.message || ""}`);
  return ok;
}

/** Next PK for eng master add — ERP mstmac/mstproc last + 1 (via prepareErpAdd + nextval). */
export async function nextErpMasterCode(requestedData) {
  const cfg = ADD[requestedData];
  if (!cfg) return null;
  await prepareErpAdd(requestedData);
  const [table, col] = cfg;
  const [seq] = await dbQuery(`SELECT pg_get_serial_sequence($1, $2) AS s`, [table, col]);
  if (!seq?.s) return null;
  const [row] = await dbQuery(`SELECT nextval($1::regclass)::int AS n`, [seq.s]);
  return Number(row?.n) > 0 ? Number(row.n) : null;
}

/** ERP must succeed before local DB write (Engineering masters). */
export async function assertErpSync(type, data, requestedData) {
  const ok = await syncToErp(type, data, requestedData);
  if (!ok) {
    throw Object.assign(new Error("ERP sync failed. Record was not saved."), { statusCode: 502 });
  }
}
