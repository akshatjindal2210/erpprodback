import dotenv from "dotenv";
import path from "path";
import { APP_VERSION } from "./appVersion.js";

dotenv.config();

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
  frontend_url: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",") : ["http://localhost:3000"],
  cookie_name: "auth_token",
  cookie_max_age: 1 * 24 * 60 * 60 * 1000, // 1 days
};

if (config.node_env === "production" && !config.jwt_secret) {
  throw new Error("JWT_SECRET is required when NODE_ENV=production");
}

export default config;
