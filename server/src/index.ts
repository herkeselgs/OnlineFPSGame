import { ClientMessage, ImpostorClientMessage, PlayerId, SIM_DT } from "@fps/shared";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { GameLoop } from "./GameLoop.js";
import { ImpostorRoom } from "./rooms/ImpostorRoom.js";
import { ImpostorRoomManager } from "./rooms/ImpostorRoomManager.js";
import { Room } from "./rooms/Room.js";
import { RoomManager } from "./rooms/RoomManager.js";

const PORT = Number(process.env.PORT ?? 8787);

const roomManager = new RoomManager();
const impostorRoomManager = new ImpostorRoomManager();
const gameLoop = new GameLoop([roomManager, impostorRoomManager], SIM_DT * 1000);
gameLoop.start();

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "fps-server",
        rooms: roomManager.allRooms().length + impostorRoomManager.allRooms().length,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

interface SocketState {
  room: Room | null;
  impostorRoom: ImpostorRoom | null;
  playerId: PlayerId | null;
}

wss.on("connection", (socket: WebSocket) => {
  const state: SocketState = { room: null, impostorRoom: null, playerId: null };

  socket.on("message", (data) => {
    let msg: ClientMessage | ImpostorClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "create_room") {
      const room = roomManager.createRoom();
      const id = room.addPlayer(socket, msg.name, msg.color);
      if (typeof id !== "string") {
        socket.send(JSON.stringify({ type: "room_error", message: id.error }));
        return;
      }
      state.room = room;
      state.playerId = id;
      socket.send(
        JSON.stringify({ type: "room_created", code: room.code, selfId: id, reconnectToken: room.getToken(id) })
      );
      return;
    }

    if (msg.type === "join_room") {
      const room = roomManager.getRoom(msg.code);
      if (!room) {
        socket.send(JSON.stringify({ type: "room_error", message: "Room not found" }));
        return;
      }
      const id = room.addPlayer(socket, msg.name, msg.color);
      if (typeof id !== "string") {
        socket.send(JSON.stringify({ type: "room_error", message: id.error }));
        return;
      }
      state.room = room;
      state.playerId = id;
      socket.send(
        JSON.stringify({
          type: "room_joined",
          code: room.code,
          selfId: id,
          mapId: room.map.id,
          reconnectToken: room.getToken(id),
        })
      );
      return;
    }

    if (msg.type === "imp_create_room") {
      const room = impostorRoomManager.createRoom();
      const id = room.addPlayer(socket, msg.name, msg.color);
      if (typeof id !== "string") {
        socket.send(JSON.stringify({ type: "imp_room_error", message: id.error }));
        return;
      }
      state.impostorRoom = room;
      state.playerId = id;
      socket.send(
        JSON.stringify({ type: "imp_room_created", code: room.code, selfId: id, reconnectToken: room.getToken(id) })
      );
      return;
    }

    if (msg.type === "imp_join_room") {
      const room = impostorRoomManager.getRoom(msg.code);
      if (!room) {
        socket.send(JSON.stringify({ type: "imp_room_error", message: "Room not found" }));
        return;
      }
      const id = room.addPlayer(socket, msg.name, msg.color);
      if (typeof id !== "string") {
        socket.send(JSON.stringify({ type: "imp_room_error", message: id.error }));
        return;
      }
      state.impostorRoom = room;
      state.playerId = id;
      socket.send(
        JSON.stringify({ type: "imp_room_joined", code: room.code, selfId: id, reconnectToken: room.getToken(id) })
      );
      return;
    }

    if (msg.type === "rejoin_room") {
      const room = roomManager.getRoom(msg.code);
      if (room) {
        const id = room.rejoin(msg.token, socket);
        if (id) {
          state.room = room;
          state.playerId = id;
          socket.send(
            JSON.stringify({
              type: "room_joined",
              code: room.code,
              selfId: id,
              mapId: room.map.id,
              reconnectToken: room.getToken(id),
            })
          );
          room.resendStateTo(id);
          return;
        }
      }

      const impRoom = impostorRoomManager.getRoom(msg.code);
      if (impRoom) {
        const id = impRoom.rejoin(msg.token, socket);
        if (id) {
          state.impostorRoom = impRoom;
          state.playerId = id;
          socket.send(
            JSON.stringify({ type: "imp_room_joined", code: impRoom.code, selfId: id, reconnectToken: impRoom.getToken(id) })
          );
          impRoom.resendStateTo(id);
          return;
        }
      }

      socket.send(JSON.stringify({ type: "rejoin_failed", message: "Could not reconnect to that match" }));
      return;
    }

    if (state.room && state.playerId) {
      state.room.handleMessage(state.playerId, msg as ClientMessage);
      return;
    }
    if (state.impostorRoom && state.playerId) {
      state.impostorRoom.handleMessage(state.playerId, msg as ImpostorClientMessage);
    }
  });

  socket.on("close", () => {
    if (state.room && state.playerId) {
      state.room.handleDisconnect(state.playerId);
    }
    if (state.impostorRoom && state.playerId) {
      state.impostorRoom.handleDisconnect(state.playerId);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[fps-server] listening on :${PORT} (ws path /ws, health at /health)`);
});
