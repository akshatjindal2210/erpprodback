import { Router } from "express";

import tasksRoutes from "./task.route.js";
import recurringRoutes from "./recurringTask.route.js";
import categoriesRoutes from "./category.route.js";
import holidaysRoutes from "./holiday.route.js";
import remindersRoutes from "./reminder.route.js";
// import clTaskRoutes from "./clTask.route.js";
// import redTicketRoutes from "./redTicket.route.js";
// import reportRoutes from "./report.route.js";
import notificationRoutes from "./notification.route.js";

const router = Router();

router.use("/tasks", tasksRoutes);
router.use("/recurring-tasks", recurringRoutes);
router.use("/categories", categoriesRoutes);
router.use("/holidays", holidaysRoutes);
router.use("/reminders", remindersRoutes);
// router.use("/cl-tasks", clTaskRoutes);
// router.use("/red-tickets", redTicketRoutes);
// router.use("/reports", reportRoutes);
router.use("/notifications", notificationRoutes);

export default router;
