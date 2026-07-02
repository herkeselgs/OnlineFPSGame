import { ROOM_CODE_CHARSET, ROOM_CODE_LENGTH } from "@fps/shared";
import { Room } from "./Room.js";

export class RoomManager {
  private rooms = new Map<string, Room>();

  createRoom(): Room {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));

    const room = new Room(code, () => this.rooms.delete(code));
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  allRooms(): Room[] {
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
