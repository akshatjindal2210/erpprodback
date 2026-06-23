import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import config from "./config/config.js";

import { morganMiddleware, requestLogger } from "./apps/core/utils/logger.js";
import logger from "./apps/core/utils/logger.js";
import { imsMetaMiddleware } from "./apps/ims/utils/erp-api/imsMeta.js";
import { activityLogger } from "./apps/core/middleware/activityLogger.js";

import imsRoutes from "./apps/ims/routes/index.js";
import taskRoutes from "./apps/task/routes/index.js";
import coreRoutes from "./apps/core/routes/index.js";

const app = express();

app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(morganMiddleware);
app.use(requestLogger);

app.use(
  cors({
    origin: [...config.frontend_url],
    credentials: true,
  }),
);

app.use(cookieParser());
app.use(imsMetaMiddleware);
app.use(`/${config.uploadPublicPath}`, express.static(path.resolve(config.uploadPath)));

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

app.use("/api/core", activityLogger("portal"), coreRoutes);
app.use("/api/task", activityLogger("task"), taskRoutes);
app.use("/api", activityLogger("ims"), imsRoutes);

app.use((req, res) => {
  logger.warn(`404 — ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);
  res.status(500).json({ success: false, message: "Internal server error" });
});

export default app;
