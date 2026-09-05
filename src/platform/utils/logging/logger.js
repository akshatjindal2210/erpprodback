import winston from "winston";
import morgan from "morgan";

import { getLogFilePath } from "../../../logging/paths.js";

const LOG_FORMAT = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] ${level.toUpperCase()} — ${message}`;
  }),
);

function createFileTransports() {
  return [
    new winston.transports.File({
      filename: getLogFilePath("error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: getLogFilePath("combined.log"),
    }),
  ];
}

/** Keeps winston from buffering logs when file handles are closed for retention on Windows. */
function createPauseFallbackTransport() {
  return new winston.transports.Console({
    format: LOG_FORMAT,
    silent: true,
  });
}

function closeFileTransport(transport) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const dest = transport?._dest;
    const timer = setTimeout(() => {
      if (dest && typeof dest.destroy === "function" && !dest.destroyed) {
        dest.destroy();
      }
      done();
    }, 4000);

    const finish = () => {
      clearTimeout(timer);
      if (dest && typeof dest.destroy === "function" && !dest.destroyed) {
        dest.destroy();
      }
      done();
    };

    if (!transport?._stream) {
      finish();
      return;
    }

    try {
      transport.close(finish);
    } catch {
      finish();
    }
  });
}

let fileTransports = createFileTransports();

const logger = winston.createLogger({
  level: "info",
  format: LOG_FORMAT,
  transports: fileTransports,
});

/** Close winston file handles so retention can replace logs on Windows. */
export async function withFileLoggingPaused(fn) {
  const current = fileTransports;
  const fallbackTransport = createPauseFallbackTransport();

  for (const transport of current) {
    logger.remove(transport);
  }
  logger.add(fallbackTransport);

  await Promise.all(current.map(closeFileTransport));
  try {
    return await fn();
  } finally {
    logger.remove(fallbackTransport);
    fileTransports = createFileTransports();
    for (const transport of fileTransports) {
      logger.add(transport);
    }
  }
}

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
