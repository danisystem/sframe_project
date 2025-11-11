// ─────────────── Full-duplex relay server (Node.js + ws) ───────────────
import WebSocket, { WebSocketServer } from "ws";

const PORT = 4000;
const wss = new WebSocketServer({ host: "0.0.0.0", port: PORT });
const peers = new Set();

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  peers.add(ws);
  console.log(`[conn] ${ip} connected (${peers.size} peers)`);

  ws.on("message", (data, isBinary) => {
    // broadcast binario a tutti gli altri peer
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(data, { binary: isBinary });
      }
    }
  });

  ws.on("close", () => {
    peers.delete(ws);
    console.log(`[disc] ${ip} disconnected (${peers.size} peers)`);
  });
});

console.log(`Relay full-duplex su ws://0.0.0.0:${PORT}`);
