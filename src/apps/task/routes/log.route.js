import { Router } from "express";
import { authenticate, authorize } from "../shared/index.js";
import {
  getUserLogs,
  getUserLogById,
  deleteUserLog,
  bulkDeleteUserLogs,
} from "../controllers/log.controller.js";

const router = Router();
const allRoles = authorize("super_admin", "admin", "user", "executive_assistant");
const superOnly = authorize("super_admin");

router.use(authenticate);

router.get("/", allRoles, getUserLogs);
router.delete("/bulk", superOnly, bulkDeleteUserLogs);
router.get("/:id", allRoles, getUserLogById);
router.delete("/:id", superOnly, deleteUserLog);

export default router;
