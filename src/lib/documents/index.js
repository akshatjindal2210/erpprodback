/**
 * Documents module — the only import for apps and boot.
 * See README.md in this folder (flow, adding a module, debugging).
 */
export { createDocumentsTable, withDocumentsTable } from "./documents.table.js";
export { docUpload } from "./documents.upload.js";
export { updateDocumentRemark, listPathsFromModuleFiles } from "./documents.service.js";
export { findByFileNames, findActiveByUuid } from "./documents.model.js";
export { fullDocPublicPath, normFolderPath, isUuidExtFile } from "./documents.utils.js";
export { moduleDocuments, syncPathsFromList, syncDocumentPaths, attachPathListRow, attachPathListRows, receivingFileFromRows, receivingDocumentsFromRows, receivingDocRow, attachTcRmtcRow, attachTcRmtcRows, 
  upsertTcRmtcSlot, enrichQcItemsWithDocuments, persistQcSpecDocument, syncAttachmentList, attachmentsFromDocuments, syncRegisteredFiles, registerUploadedFiles } from "./documents.helpers.js";
export { multerUuidFilename, mapMulterFilesWithRemarks, parseFileRemarks, slotRemarkFromBody, publicPathOf } from "./documents.utils.js";
