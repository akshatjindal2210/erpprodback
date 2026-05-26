import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import config from "./config/config.js";

import { morganMiddleware, requestLogger } from "./utils/logger.js";
import logger from "./utils/logger.js";
import { imsMetaMiddleware } from "./utils/imsMeta.js";

import userRoutes from "./routes/user.route.js";
import permissionRoutes from "./routes/permission.route.js";
import moduleRoutes from "./routes/module.route.js";
import categoryRoutes from "./routes/category.route.js";
import trainingVideosRoutes from "./routes/trainingVideo.routes.js";
import masterRoutes from "./routes/master.routes.js";
import locationRoutes from "./routes/locationMaster.routes.js";
import packingStandardRoutes from "./routes/packingStandard.route.js";
import boxRoutes from "./routes/box.route.js";
import inventoryInwardRoutes from "./routes/inventoryInward.route.js";
import forwardingNoteRoutes from "./routes/forwardingNote.route.js";
import outEntryRoutes from "./routes/outEntry.route.js";
import stockAdjustmentRoutes from "./routes/stockAdjustment.route.js";
import activityLogRoutes from "./routes/activityLog.routes.js";
import transactionBoxRoutes from "./routes/transactionBox.routes.js";
import inventoryReportRoutes from "./routes/inventoryReport.route.js";
import appConfigRoutes from "./routes/appConfig.route.js";

const app = express();

// ── Body parsers ───────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Logging Middlewares ───────────────
app.use(morganMiddleware);
app.use(requestLogger);

// ── CORS ──────────────────────────────
app.use(
  cors({
    origin: [
      ...config.frontend_url,
    ],
    credentials: true,
  }),
);

// ── Cookies ───────────────────────────
app.use(cookieParser());

// ── IMS / ERP warning context (attaches `ims_meta` on JSON when internal IMS calls fail) ──
app.use(imsMetaMiddleware);

// ── Static Files ──────────────────────
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// ── Health / version (public) ─────────
app.get("/", (req, res) => {
  logger.info("Health check hit");
  res.json({
    success: true,
    message: "Health check.",
    version: config.app_version,
  });
});

app.get("/api/version", (req, res) => {
  res.json({
    success: true,
    data: { version: config.app_version },
  });
});

// ── Routes ────────────────────────────
app.use("/api/users", userRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/training-videos", trainingVideosRoutes);
app.use("/api/master", masterRoutes);
app.use("/api/locations", locationRoutes);
app.use("/api/packing-standard", packingStandardRoutes);
app.use("/api/boxes", boxRoutes);
app.use("/api/inventory-inwards", inventoryInwardRoutes);
app.use("/api/forwarding-notes", forwardingNoteRoutes);
app.use("/api/out-entries", outEntryRoutes);
app.use("/api/stock-adjustment", stockAdjustmentRoutes);
app.use("/api/activity-logs", activityLogRoutes);
app.use("/api/box-transaction-logs", transactionBoxRoutes);
app.use("/api/inventory-report", inventoryReportRoutes);
app.use("/api/app-config", appConfigRoutes);

// ── 404 Handler ───────────────────────
app.use((req, res) => {
  logger.warn(`404 — ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Route not found" });
});

// ── Global Error Handler ──────────────
app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);
  res.status(500).json({ success: false, message: "Internal server error" });
});

export default app;
