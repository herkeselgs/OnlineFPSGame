import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "fps-server" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (socket) => {
  // Room system, authoritative simulation, and message protocol land in the
  // multiplayer-sync milestone. For now this just proves the transport works.
  socket.send(JSON.stringify({ type: "hello", message: "connected to fps-server" }));

  socket.on("message", (data) => {
    socket.send(data.toString());
  });
});

httpServer.listen(PORT, () => {
  console.log(`[fps-server] listening on :${PORT} (ws path /ws, health at /health)`);
});
