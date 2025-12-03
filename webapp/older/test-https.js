import https from "https";
import fs from "fs";

https.createServer({
  key: fs.readFileSync("../pki/server/server-key.pem"),
  cert: fs.readFileSync("../pki/server/server.pem")
}, (req, res) => {
  res.writeHead(200);
  res.end("HTTPS TEST OK");
}).listen(443, () => {
  console.log("Server HTTPS attivo su https://sframe.local/");
});
