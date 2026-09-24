import express from "express";
import { authenticate } from "../../../lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { invoiceReceivingUpload } from "../../../lib/middleware/upload.js";
import { deleteInvoiceReceiving, listInvoiceReceiving, updateInvoiceReceiving } from "../controllers/invoiceReceiving.controller.js";

const router = express.Router();
const M = "invoice_receiving";

router.post("/list", authenticate, accessControl(M, "view"), listInvoiceReceiving);
router.post("/update", authenticate, accessControl(M, ["add", "edit", "authorize"]), invoiceReceivingUpload.array("attachments", 20), updateInvoiceReceiving);
router.post("/delete", authenticate, accessControl(M, "delete"), deleteInvoiceReceiving);

export default router;
