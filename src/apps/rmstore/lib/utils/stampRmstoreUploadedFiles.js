import { auditUserName } from "../../../core/lib/utils/auth/approval.js";
import { applyTimestamp, UPLOAD_TIMESTAMP_TYPES } from "./applyUploadTimestamp.js";

function flattenMulterFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files.filter(Boolean);
  return Object.values(files).flatMap((entry) => {
    if (Array.isArray(entry)) return entry.filter(Boolean);
    return entry ? [entry] : [];
  });
}

/** Person name of the logged-in user performing this upload (responsible uploader). */
export function rmstoreUploadPersonName(req) {
  const name = String(req?.user?.name ?? "").trim();
  if (name) return name;
  const usercode = String(req?.user?.usercode ?? "").trim();
  if (usercode) return usercode;
  return String(auditUserName(req) ?? "").trim();
}

/** Stamp all uploaded images with uploader name + IST time. Pass the Express `req` from the upload handler. */
export async function stampRmstoreUploadedFiles(req) {
  const uploadedByName = rmstoreUploadPersonName(req);
  for (const file of flattenMulterFiles(req?.files)) {
    await applyTimestamp(file, UPLOAD_TIMESTAMP_TYPES.IMAGE, uploadedByName);
  }
}
