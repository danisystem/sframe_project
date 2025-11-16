const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: 3001 });

/**
 * rooms: roomId -> {
 *   peers: Set<ws>,
 *   lastOffer: RTCSessionDescriptionInit | null,
 *   pendingCandidates: any[]
 * }
 */
const rooms = new Map();

function ensureRoom(room) {
  if (!rooms.has(room)) {
    rooms.set(room, { peers: new Set(), lastOffer: null, pendingCandidates: [] });
  }
  return rooms.get(room);
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[conn] ${ip} connected`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { room, type, data } = msg || {};
    if (!room) return;
    const r = ensureRoom(room);

    if (type === "join") {
      r.peers.add(ws);
      console.log(`[room ${room}] join (${r.peers.size} peers)`);

      // Replay immediato verso il nuovo peer
      if (r.lastOffer) {
        send(ws, { type: "offer", data: r.lastOffer });
        for (const cand of r.pendingCandidates) {
          send(ws, { type: "candidate", data: cand });
        }
      }
      return;
    }

    if (type === "offer") {
      r.lastOffer = data;                 // salva per i nuovi joiner
      console.log(`[room ${room}] offer`);
      for (const peer of r.peers) if (peer !== ws) send(peer, { type, data });
      return;
    }

    if (type === "candidate") {
      r.pendingCandidates.push(data);     // accoda per i nuovi joiner
      console.log(`[room ${room}] candidate`);
      for (const peer of r.peers) if (peer !== ws) send(peer, { type, data });
      return;
    }

    if (type === "answer") {
      console.log(`[room ${room}] answer`);
      for (const peer of r.peers) if (peer !== ws) send(peer, { type, data });
      return;
    }
  });

  ws.on("close", () => {
    for (const [room, r] of rooms.entries()) {
      if (r.peers.delete(ws)) {
        console.log(`[room ${room}] leave (${r.peers.size} peers)`);
        if (r.peers.size === 0) {
          rooms.delete(room); // pulizia room vuote
        }
      }
    }
  });
});

console.log("Signaling WS server on ws://0.0.0.0:3001");
