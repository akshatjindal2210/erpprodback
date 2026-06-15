import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import app from "./src/index.js";
import config from "./src/config/config.js";
import { initDB } from "./src/config/initDB.js";
import { seedCoreRootUser } from "./src/apps/core/config/seed.js";
import { seedImsData } from "./src/apps/ims/config/seed.js";
import logger from "./src/utils/logger.js";
import { initRecurringTasksCron, initTaskNotificationsCron, startDbBackupCron } from "./src/jobs/index.js";
import { initSocket } from "./src/utils/socket.js";
import { deliverUnreadInboxToSocket } from "./src/apps/task/services/taskPwaPush.service.js";

const server = http.createServer(app);

export const io = new Server(server, {
  cors: {
    origin: config.frontend_url,
    credentials: true,
  },
});

initSocket(io);

io.use((socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) return next(new Error("Unauthorized"));

    const regex = new RegExp(`${config.cookie_name}=([^;]+)`);
    const match = cookieHeader.match(regex);
    if (!match) return next(new Error("Unauthorized"));

    const token = match[1];
    const decoded = jwt.verify(token, config.jwt_secret);
    // console.log("decoded - ",decoded)
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const userId = Number(socket.user.id);
  socket.join(`user_${userId}`);
  console.log(`User connected: ${userId}`);

  void deliverUnreadInboxToSocket(userId);

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${userId}`);
  });
});

async function startServer() {
  try {
    await initDB();
    await seedCoreRootUser();
    await seedImsData();
    initRecurringTasksCron();
    initTaskNotificationsCron();

    server.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} (API v${config.app_version})`);
      console.log(`🚀 Server running on port ${config.port} — API v${config.app_version}`);
      startDbBackupCron();
    });
  } catch (error) {
    logger.error(`Server failed to start: ${error.message}`);
    console.error("❌ Server failed to start:", error.message);
    process.exit(1);
  }
}

startServer();