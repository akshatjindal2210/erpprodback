import winston from "winston";
import morgan from "morgan";
import path from "path";
import fs from "fs";

const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()} — ${message}`;
    }),
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logDir, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(logDir, "combined.log"),
    }),
  ],
});

const isLoginPost = (req) =>
  req.method === "POST" && req.originalUrl.endsWith("/login");

export const morganMiddleware = morgan(
  ":method :url :status :res[content-length] - :response-time ms",
  {
    skip: (req) => req.method === "OPTIONS" || isLoginPost(req),
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  },
);

export const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    if (req.method === "OPTIONS") return;

    const duration = Date.now() - start;

    // Login attempts — file log only (username from body; no DB / activity module)
    if (isLoginPost(req)) {
      const raw = req.body?.username ?? req.body?.email;
      const username =
        raw != null && String(raw).trim() ? String(raw).trim() : "(empty)";
      const ip = req.ip || req.headers["x-forwarded-for"] || "-";
      const msg = `LOGIN | username:${username} | status:${res.statusCode} | ${duration}ms | ip:${ip}`;
      if (res.statusCode >= 400) logger.warn(msg);
      else logger.info(msg);
      return;
    }

    const user = req.user?.id ?? "guest";
    const msg = `${req.method} ${req.originalUrl} | user:${user} | ${res.statusCode} | ${duration}ms`;

    if (res.statusCode >= 400) {
      logger.error(msg);
    } else {
      logger.info(msg);
    }
  });

  next();
};

export default logger;
