import { ROOM_CODE_CHARSET, ROOM_CODE_LENGTH } from "@fps/shared";
import { ImpostorRoom } from "./ImpostorRoom.js";

/** Sibling to RoomManager, own code namespace (a code colliding with a Duel
 * room's is harmless — each mode's join message only ever looks itself up
 * in its own manager). */
export class ImpostorRoomManager {
  private rooms = new Map<string, ImpostorRoom>();

  createRoom(): ImpostorRoom {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));

    const room = new ImpostorRoom(code, () => this.rooms.delete(code));
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): ImpostorRoom | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  allRooms(): ImpostorRoom[] {
    return [...this.rooms.values()];
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
    }
    return code;
  }
}
