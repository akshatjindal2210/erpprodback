import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { APP_VERSION } from "./appVersion.js";

dotenv.config();

const getUploadPath = () => {
  const envPath = process.env.UPLOAD_PATH;
  let finalPath = "uploads";
  
  if (envPath && fs.existsSync(envPath)) {
    finalPath = path.join(envPath, "uploads");
  }
  
  // Ensure the base upload directory exists
  if (!fs.existsSync(finalPath)) {
    fs.mkdirSync(finalPath, { recursive: true });
  }
  
  return finalPath;
};

const config = {
  db: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT) || 5432,
  },
  dbBackup: {
    enabled: process.env.DB_BACKUP_ENABLED !== "false",
    weeklyEnabled: process.env.DB_BACKUP_WEEKLY_ENABLED !== "false",
    hourlyEnabled: process.env.DB_BACKUP_HOURLY_ENABLED !== "false",
    
    cron: process.env.DB_BACKUP_CRON || "0 * * * *",
    
    dir: process.env.DB_BACKUP_DIR || path.join(process.cwd(), "backups"),
    weeklyDir: process.env.DB_BACKUP_WEEKLY_DIR || "weekly",
    hourlyDir: process.env.DB_BACKUP_HOURLY_DIR || "hourly",

    hourlyStartHour: parseInt(process.env.DB_BACKUP_HOURLY_START_HOUR, 10) || 8,
    hourlyEndHour: parseInt(process.env.DB_BACKUP_HOURLY_END_HOUR, 10) || 19,
    hourlyKeepCount: parseInt(process.env.DB_BACKUP_HOURLY_KEEP_COUNT, 10) || 4,
    
    pgDump: process.env.PG_DUMP_PATH || "pg_dump",
    ssl: process.env.DB_SSL === "true",
  },
  root: {
    name: process.env.ROOT_NAME,
    email: process.env.ROOT_EMAIL,
    phone: process.env.ROOT_PHONE,
    username: process.env.ROOT_USERNAME,
    password: process.env.ROOT_PASSWORD,
  },
  port: parseInt(process.env.PORT) || 8000,
  app_version: APP_VERSION,
  jwt_secret: process.env.JWT_SECRET,
  node_env: process.env.NODE_ENV || "development",
  domain: process.env.DOMAIN || "localhost",
  frontend_url: process.env.CLIENT_URL ? process.env.CLIENT_URL.split(",") : ["http://localhost:3000"],
  uploadPath: getUploadPath(),
  uploadPublicPath: "uploads",
  cookie_name: "auth_token",
  /** Live: NODE_ENV=production + DOMAIN=.jflbharat.com | Test: development + localhost */
  cookie_options: {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: (process.env.NODE_ENV || "development") === "production",
    ...((process.env.DOMAIN || "localhost") !== "localhost"
      ? { domain: process.env.DOMAIN }
      : {}),
  },
  /** ERP internal API — IMS data only (master, changepass, etc.) */
  erpInternalApi: {
    url: process.env.ERP_IMS_API_URL || "http://192.168.1.100:3200/data/imsdata",
    timeoutMs: 15000,
  },
  /** WhatsApp message API — task/template notifications (requestedData: swa | swpa) */
  waApi: {
    url: process.env.WA_API_URL || "http://192.168.1.100:3200/send/wa",
    timeoutMs: 15000,
  },
};

if (config.node_env === "production" && !config.jwt_secret) {
  throw new Error("JWT_SECRET is required when NODE_ENV=production");
}

export default config;

/** Session expires at 11:59 PM IST on the login day */
export function getSessionMaxAgeMs() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  return Math.max(60_000, new Date(`${today}T23:59:59.999+05:30`) - Date.now());
}
