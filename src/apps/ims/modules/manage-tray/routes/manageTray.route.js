import { Router } from "express";
import { authenticate } from "../../../../core/lib/middleware/auth.js";
import { accessControl } from "../../../../core/lib/middleware/accessControl.js";
import { getManageTrays, getManageTrayDetail, getManageTrayReportKpis, getManageTrayReportLedger, scanManageTraySticker, scanManageTrayTray, receiveManageTray, scanReassignSticker, scanReassignTray, saveReassignTray, saveManageTrayLinks, moveManageTrayToPending, deleteManageTrayRecord } from "../controllers/manageTray.controller.js";

const router = Router();
const view = accessControl("manage_tray", "view");
const edit = accessControl("manage_tray", ["add", "edit"]);

router.post("/list", authenticate, view, getManageTrays);
router.post("/get", authenticate, view, getManageTrayDetail);
router.post("/report-summary", authenticate, view, getManageTrayReportKpis);
router.post("/report-ledger", authenticate, view, getManageTrayReportLedger);
router.post("/scan-sticker", authenticate, edit, scanManageTraySticker);
router.post("/scan-tray", authenticate, edit, scanManageTrayTray);
router.post("/receive", authenticate, edit, receiveManageTray);
router.post("/reassign-sticker", authenticate, edit, scanReassignSticker);
router.post("/reassign-tray", authenticate, edit, scanReassignTray);
router.post("/reassign", authenticate, edit, saveReassignTray);
router.post("/save-links", authenticate, edit, saveManageTrayLinks);
router.post("/move-pending", authenticate, edit, moveManageTrayToPending);
router.post("/delete", authenticate, accessControl("manage_tray", "delete"), deleteManageTrayRecord);

export default router;
