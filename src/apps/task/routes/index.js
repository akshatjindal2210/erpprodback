import { Router } from "express";

import tasksRoutes from "./task.route.js";
import recurringRoutes from "./recurringTask.route.js";
import categoriesRoutes from "./category.route.js";
import holidaysRoutes from "./holiday.route.js";
import remindersRoutes from "./reminder.route.js";
import notificationRoutes from "./notification.route.js";

const router = Router();

router.use("/tasks", tasksRoutes);
router.use("/recurring-tasks", recurringRoutes);
router.use("/categories", categoriesRoutes);
router.use("/holidays", holidaysRoutes);
router.use("/reminders", remindersRoutes);
router.use("/notifications", notificationRoutes);

export default router;
