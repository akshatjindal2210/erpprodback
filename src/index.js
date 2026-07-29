import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import config from "./config/app/config.js";
import { corsOptions } from "./config/app/cors.js";

import { morganMiddleware, requestLogger } from "./apps/core/lib/utils/logging/logger.js";
import logger from "./apps/core/lib/utils/logging/logger.js";
import { imsMetaMiddleware } from "./apps/ims/lib/utils/erp-api/lookup/imsMeta.js";
import { activityLogger } from "./apps/core/lib/middleware/activityLogger.js";

import imsRoutes from "./apps/ims/routes/index.js";
import taskRoutes from "./apps/task/routes/index.js";
import coreRoutes from "./apps/core/routes/index.js";
import dashboardRoutes from "./apps/dashboard/routes/index.js";
// import rmstoreRoutes from "./apps/rmstore/routes/index.js";

const app = express();

app.set("trust proxy", 1);

// CORS before body parsers so 413/parse errors still get Access-Control headers
// (otherwise the browser reports a generic "Failed to fetch" / "Server not responding").
app.use(cors(corsOptions));

// Match/exceed file-upload size (multer 20mb) and large dashboard JSON.
app.use(express.json({ limit: config.bodyParserLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyParserLimit }));

app.use(morganMiddleware);
app.use(requestLogger);

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
app.use("/api/dashboard", activityLogger("dashboard"), dashboardRoutes);
// app.use("/api/rmstore", activityLogger("rmstore"), rmstoreRoutes);
app.use("/api", activityLogger("ims"), imsRoutes);

app.use((req, res) => {
  logger.warn(`404 — ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    logger.warn(`Payload too large — ${req.method} ${req.originalUrl}`);
    return res.status(413).json({
      success: false,
      message: "Request payload is too large. Try saving fewer widgets or contact support.",
    });
  }
  logger.error(`${err.message} — ${req.method} ${req.originalUrl}`);
  res.status(500).json({ success: false, message: "Internal server error" });
});

export default app;
