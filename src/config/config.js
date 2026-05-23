import dotenv from "dotenv";
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
  mssql: {
    server: process.env.MSSQL_HOST,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DB,
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
      encrypt: false,
      enableArithAbort: true
    }
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
