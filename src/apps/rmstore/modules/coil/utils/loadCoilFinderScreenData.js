/**
 * Coil Finder screen payload — QC, docs, journey (frontend builds Full record from coil + config).
 */

import { loadCoilFinderReportData } from "./loadCoilFinderReportData.js";
import { findCoilTransactions } from "../../../manage/log/models/coilTransaction.model.js";
import { COIL_TX_TYPE_LABELS } from "../../../lib/constants/coilTransactionTypes.js";

/** Per-coil journey is usually small; avoids 10k-row scans on helper. */
const FINDER_JOURNEY_TX_LIMIT = 500;

export async function loadCoilFinderScreenData(coil_no_uid, permission = {}, existingCoil = null) {
  const uid = String(coil_no_uid || "").trim();
  if (!uid) return null;

  const [report, txResult] = await Promise.all([
    loadCoilFinderReportData(uid, existingCoil),
    findCoilTransactions({
      filters: { journey: uid },
      sort: { by: "created_at", order: "DESC" },
      page: 1,
      limit: FINDER_JOURNEY_TX_LIMIT,
      skipCount: true,
      permission,
      user_id: null,
    }),
  ]);

  if (!report) return null;

  return {
    details: [],
    qcChecks: report.qcChecks,
    documents: report.documents,
    transactionLogs: txResult?.data || [],
    typeLabels: COIL_TX_TYPE_LABELS,
  };
}
