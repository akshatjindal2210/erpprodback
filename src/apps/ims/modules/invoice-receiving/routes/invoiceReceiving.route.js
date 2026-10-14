import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { docUpload } from "../../../../../lib/documents/index.js";
import { deleteInvoiceReceiving, listInvoiceReceiving, updateInvoiceReceiving } from "../controllers/invoiceReceiving.controller.js";

const router = express.Router();
export const MODULE = "invoice_receiving";
const M = MODULE;

router.post("/list", authenticate, accessControl(M, "view"), listInvoiceReceiving);
router.post("/update", authenticate, accessControl(M, ["add", "edit", "authorize"]), docUpload(M).array("attachments", 20), updateInvoiceReceiving);
router.post("/delete", authenticate, accessControl(M, "delete"), deleteInvoiceReceiving);

export default router;
