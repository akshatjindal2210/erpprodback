import fs from "fs";
import path from "path";

import { getLogSettings } from "./config.js";

/** Log files written by winston (see apps/core/utils/logger.js). */
export const LOG_FILES = ["combined.log", "error.log"];

export function getLogDir() {
  const dir = getLogSettings().dir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getLogFilePath(name) {
  return path.join(getLogDir(), name);
}
