let io;

export const initSocket = (ioInstance) => {
  io = ioInstance;
};

export const getIO = () => {
  if (!io) {
    // console.warn("Socket.io not initialized");
  }
  return io;
};

export const emitToAll = (event, data) => {
  if (io) {
    io.emit(event, data);
  }
};

export const emitToUser = (userId, event, data) => {
  if (io && userId != null && userId !== "") {
    io.to(`user_${Number(userId)}`).emit(event, data);
  }
};
