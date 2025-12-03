//
// secure-server.js (COMMONJS)
//
// HTTPS + static files + proxy MLS (HTTP) + proxy Janus (WS) + API /api/new-room
//

const fs = require("fs");
const https = require("https");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const http = require("http");

const KEY  = path.join(__dirname, "..", "pki", "server", "server-key.pem");
const CERT = path.join(__dirname, "..", "pki", "server", "server.pem");

// === MLS SERVER BACKEND (HTTP) ===
const MLS_HOST = "127.0.0.1";
const MLS_PORT = 3000;

// === JANUS BACKEND (WS + HTTP) ===
const JANUS_WS_URL   = "ws://127.0.0.1:8188/janus";   // WS (proxy WSS → WS)
const JANUS_HTTP_URL = "http://127.0.0.1:8088/janus"; // HTTP REST

const app = express();

// per leggere JSON dal browser
app.use(express.json());

// ===== STATIC FILES =====
app.use(express.static(__dirname));

// Home
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>SFrame HTTPS Gateway</title></head>
      <body style="background:#0f172a; color:#e5e7eb; font-family:system-ui;">
        <h1>HTTPS/WSS + MLS + Janus server attivo ✅</h1>
        <ul>
          <li>Webapp: <code>GET /appRoom.html?room=1234</code> (esempio)</li>
          <li>API nuova stanza: <code>POST /api/new-room</code></li>
          <li>MLS join: <code>POST /mls/join</code> → http://${MLS_HOST}:${MLS_PORT}/mls/join</li>
          <li>MLS roster: <code>GET /mls/roster?room=ID</code> → http://${MLS_HOST}:${MLS_PORT}/mls/roster</li>
          <li>Janus WS proxy: <code>wss://sframe.local/janus</code> → ${JANUS_WS_URL}</li>
          <li>Janus HTTP backend: <code>${JANUS_HTTP_URL}</code></li>
        </ul>
      </body>
    </html>
  `);
});


// ============================================================================
//  PROXY MLS: POST /mls/join
// ============================================================================

app.post("/mls/join", (req, res) => {
  const payload = JSON.stringify(req.body);

  const options = {
    hostname: MLS_HOST,
    port: MLS_PORT,
    path: "/mls/join",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => (data += chunk));
    proxyRes.on("end", () => {
      try {
        const json = JSON.parse(data);
        res.status(proxyRes.statusCode || 200).json(json);
      } catch (e) {
        console.error("[MLS proxy] join parse error:", e.message);
        res.status(502).json({ error: "Invalid JSON from MLS server" });
      }
    });
  });

  proxyReq.on("error", (err) => {
    console.error("[MLS proxy] join error:", err.message);
    res.status(502).json({ error: "MLS server unreachable" });
  });

  proxyReq.write(payload);
  proxyReq.end();
});


// ============================================================================
//  PROXY MLS: GET /mls/roster?room=ID
// ============================================================================

app.get("/mls/roster", (req, res) => {
  // inoltriamo la query string così com'è (in particolare room=)
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const pathWithQs = "/mls/roster" + qs;

  const options = {
    hostname: MLS_HOST,
    port: MLS_PORT,
    path: pathWithQs,
    method: "GET",
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => (data += chunk));
    proxyRes.on("end", () => {
      try {
        const json = JSON.parse(data);
        res.status(proxyRes.statusCode || 200).json(json);
      } catch (e) {
        console.error("[MLS proxy] roster parse error:", e.message);
        res.status(502).json({ error: "Invalid JSON from MLS server" });
      }
    });
  });

  proxyReq.on("error", (err) => {
    console.error("[MLS proxy] roster error:", err.message);
    res.status(502).json({ error: "MLS server unreachable" });
  });

  proxyReq.end();
});


// ============================================================================
//  HELPER: chiamata HTTP POST JSON a Janus (REST)
// ============================================================================

function janusHttpCall(body) {
  const payload = JSON.stringify(body);
  const url = new URL(JANUS_HTTP_URL);

  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          console.error("[ROOM] Janus parse error:", e.message, "raw=", data);
          reject(new Error("Invalid JSON from Janus HTTP"));
        }
      });
    });

    req.on("error", (err) => {
      console.error("[ROOM] Janus HTTP error:", err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

function randomTx(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}


// ============================================================================
//  HELPER: create session + attach videoroom + create room
// ============================================================================

async function janusCreateSession() {
  const payload = {
    janus: "create",
    transaction: randomTx("create"),
  };

  const json = await janusHttpCall(payload);
  console.log("[ROOM] create session resp:", json);

  if (json.janus !== "success" || !json.data || !json.data.id) {
    throw new Error("Invalid Janus create response");
  }
  return json.data.id;
}

async function janusAttachVideoRoom(sessionId) {
  const payload = {
    janus: "attach",
    plugin: "janus.plugin.videoroom",
    transaction: randomTx("attach"),
    session_id: sessionId,
  };

  const json = await janusHttpCall(payload);
  console.log("[ROOM] attach videoroom resp:", json);

  if (json.janus !== "success" || !json.data || !json.data.id) {
    throw new Error("Invalid Janus attach response");
  }
  return json.data.id;
}

async function janusCreateRoom(roomId) {
  console.log("[ROOM] Creating room", roomId);

  const sessionId = await janusCreateSession();
  const handleId  = await janusAttachVideoRoom(sessionId);

  const payload = {
    janus: "message",
    transaction: randomTx("roomcreate"),
    session_id: sessionId,
    handle_id: handleId,
    body: {
      request: "create",
      room: roomId,
      publishers: 10,
    },
  };

  const json = await janusHttpCall(payload);
  console.log("[ROOM] room create resp:", json);

  // Janus può rispondere janus:"success" con data.plugindata
  if (json.janus !== "success") {
    throw new Error("Unexpected Janus response in room create");
  }

  return { roomId, sessionId, handleId };
}


// ============================================================================
//  API: POST /api/new-room  → { roomId }
// ============================================================================

app.post("/api/new-room", async (req, res) => {
  try {
    // opzionalmente client può mandare {roomId: 123456}, altrimenti random 6 cifre
    let { roomId } = req.body || {};
    if (!roomId) {
      roomId = Math.floor(100000 + Math.random() * 900000);
    }

    const result = await janusCreateRoom(roomId);
    console.log("[ROOM] Created OK:", result.roomId);

    res.json({ roomId: result.roomId });
  } catch (e) {
    console.error("[ROOM] Error:", e);
    res.status(500).json({ error: e.message || "Room creation failed" });
  }
});


// ============================================================================
//  HTTPS SERVER
// ============================================================================

const httpsServer = https.createServer(
  {
    key: fs.readFileSync(KEY),
    cert: fs.readFileSync(CERT),
  },
  app
);


// ============================================================================
//  WSS → Janus (proxy)  (uguale a prima)
// ============================================================================

const wssJanus = new WebSocketServer({
  server: httpsServer,
  path: "/janus",
});

wssJanus.on("connection", (clientWs) => {
  console.log("[Janus proxy] Browser connected, opening WS to Janus...");

  const janusWs = new WebSocket(JANUS_WS_URL, "janus-protocol");

  let janusOpen = false;
  let clientOpen = true;

  const pendingToJanus = [];

  janusWs.on("open", () => {
    janusOpen = true;
    console.log("[Janus proxy] Connected to", JANUS_WS_URL);

    pendingToJanus.forEach((msg) => {
      console.log("[Janus proxy] >> (flush) ", msg);
      janusWs.send(msg);
    });
    pendingToJanus.length = 0;
  });

  // Janus → browser
  janusWs.on("message", (msg) => {
    if (!clientOpen) return;
    const text =
      typeof msg === "string" ? msg : msg.toString("utf8");

    console.log("[Janus proxy] <<", text);
    clientWs.send(text);
  });

  janusWs.on("close", () => {
    janusOpen = false;
    console.log("[Janus proxy] Janus WS closed");
    if (clientOpen) {
      clientWs.close();
    }
  });

  janusWs.on("error", (err) => {
    console.error("[Janus proxy] Janus error:", err.message);
    if (clientOpen) {
      clientWs.close(1011, "Janus error");
    }
  });

  // Browser → Janus
  clientWs.on("message", (msg) => {
    const text =
      typeof msg === "string" ? msg : msg.toString("utf8");

    console.log("[Janus proxy] >>", text);

    if (janusWs.readyState === WebSocket.OPEN && janusOpen) {
      janusWs.send(text);
    } else {
      console.log("[Janus proxy] Janus not open yet, queueing");
      pendingToJanus.push(text);
    }
  });

  clientWs.on("close", () => {
    clientOpen = false;
    console.log("[Janus proxy] Browser WS closed");
    if (janusOpen && janusWs.readyState === WebSocket.OPEN) {
      janusWs.close();
    }
  });

  clientWs.on("error", (err) => {
    clientOpen = false;
    console.error("[Janus proxy] Browser WS error:", err.message);
    if (janusOpen && janusWs.readyState === WebSocket.OPEN) {
      janusWs.close(1011, "Client error");
    }
  });
});


// ===== START =====
httpsServer.listen(443, "0.0.0.0", () => {
  console.log("HTTPS/WSS + MLS + Janus server attivo su https://sframe.local/");
  console.log(`MLS backend:    http://${MLS_HOST}:${MLS_PORT}`);
  console.log(`Janus backend WS:   ${JANUS_WS_URL}`);
  console.log(`Janus backend HTTP: ${JANUS_HTTP_URL}`);
});
