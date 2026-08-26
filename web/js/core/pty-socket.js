export function executionWebSocketUrl(executionId, locationLike = location) {
  const protocol = locationLike.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${locationLike.host}/pty?execution=${encodeURIComponent(executionId)}`;
}

export function connectExecutionPty(executionId, { onOpen, onData, onClose } = {}) {
  const socket = new WebSocket(executionWebSocketUrl(executionId));
  socket.onopen = () => onOpen?.(socket);
  socket.onmessage = (event) => {
    if (typeof event.data === "string") onData?.(event.data, socket);
  };
  socket.onclose = (event) => onClose?.(event, socket);
  return socket;
}

export function sendPtyResize(socket, columns, rows) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !columns || !rows) return false;
  socket.send(`\x00resize:${columns}x${rows}`);
  return true;
}
