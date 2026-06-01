import { Router } from "express";

import tasksRoutes from "./task.route.js";
import recurringRoutes from "./recurringTask.route.js";
import categoriesRoutes from "./category.route.js";
import holidaysRoutes from "./holiday.route.js";
import auditRoutes from "./log.route.js";
import remindersRoutes from "./reminder.route.js";

const router = Router();

router.use("/tasks", tasksRoutes);
router.use("/recurring-tasks", recurringRoutes);
router.use("/categories", categoriesRoutes);
router.use("/holidays", holidaysRoutes);
router.use("/logs", auditRoutes);
router.use("/reminders", remindersRoutes);

export default router;
