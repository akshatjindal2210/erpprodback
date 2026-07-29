import { Router } from "express";

import tasksRoutes from "../modules/tasks/routes/task.route.js";
import recurringRoutes from "../modules/recurring-task/routes/recurringTask.route.js";
import categoriesRoutes from "../modules/category/routes/category.route.js";
import holidaysRoutes from "../modules/holidays/routes/holiday.route.js";
import remindersRoutes from "../modules/reminders/routes/reminder.route.js";
import clTaskRoutes from "../modules/cl-task/routes/clTask.route.js";
import redTicketRoutes from "../modules/red-ticket/routes/redTicket.route.js";
import reportRoutes from "../modules/reports/routes/report.route.js";
import notificationRoutes from "../manage/notifications/routes/notification.route.js";

const router = Router();

router.use("/tasks", tasksRoutes);
router.use("/recurring-tasks", recurringRoutes);
router.use("/categories", categoriesRoutes);
router.use("/holidays", holidaysRoutes);
router.use("/reminders", remindersRoutes);
router.use("/cl-tasks", clTaskRoutes);
router.use("/red-tickets", redTicketRoutes);
router.use("/reports", reportRoutes);
router.use("/notifications", notificationRoutes);

export default router;
