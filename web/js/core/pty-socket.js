// Shared browser transport for every owner-local Agent terminal. Every product
// surface attaches to the same validated /pty relay; no surface should grow a
// separate websocket protocol for the same tmux session.
export function ptyWebSocketUrl(query, lang, locationLike = location) {
  const protocol = locationLike.protocol === "https:" ? "wss" : "ws";
  const suffix = query ? `${query}&` : "";
  return `${protocol}://${locationLike.host}/pty?${suffix}lang=${encodeURIComponent(lang || "en")}`;
}

export function connectPty(query, { lang, onOpen, onData, onClose } = {}) {
  const socket = new WebSocket(ptyWebSocketUrl(query, lang));
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
