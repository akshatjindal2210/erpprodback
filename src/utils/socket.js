let io;

export function toUserId(userId) {
  const id = Number(userId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export const initSocket = (ioInstance) => {
  io = ioInstance;
};

export const getIO = () => io;

export const emitToAll = (event, data) => {
  if (io) io.emit(event, data);
};

export const emitToUser = (userId, event, data) => {
  const id = toUserId(userId);
  if (io && id) io.to(`user_${id}`).emit(event, data);
};
