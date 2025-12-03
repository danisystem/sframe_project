//
// secure-server.js (COMMONJS)
//
// HTTPS + static files + proxy MLS (HTTP) + proxy Janus (WS)
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

// === JANUS BACKEND (WS) ===
const JANUS_WS_URL = "ws://127.0.0.1:8188/janus"; // adatta se usi path /janus

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
        <h1>HTTPS/WSS + MLS + Janus Gateway ✅</h1>
        <ul>
          <li>Webapp: <code>GET /</code></li>
          <li>MLS join: <code>POST /mls/join</code> → http://${MLS_HOST}:${MLS_PORT}/mls/join</li>
          <li>MLS roster: <code>GET /mls/roster</code> → http://${MLS_HOST}:${MLS_PORT}/mls/roster</li>
          <li>Janus WS proxy: <code>wss://sframe.local/janus</code> → ${JANUS_WS_URL}</li>
        </ul>
      </body>
    </html>
  `);
});

// ===== PROXY MLS: POST /mls/join =====
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

// ===== PROXY MLS: GET /mls/roster =====
app.get("/mls/roster", (req, res) => {
  const options = {
    hostname: MLS_HOST,
    port: MLS_PORT,
    path: "/mls/roster",
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

// ===== HTTPS SERVER =====
const httpsServer = https.createServer(
  {
    key: fs.readFileSync(KEY),
    cert: fs.readFileSync(CERT),
  },
  app
);

// ===== WSS → Janus (proxy) =====
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
  console.log("Server HTTPS/WSS + MLS + Janus proxy attivo su https://sframe.local/");
  console.log(`MLS backend: http://${MLS_HOST}:${MLS_PORT}`);
  console.log(`Janus backend WS: ${JANUS_WS_URL}`);
});
