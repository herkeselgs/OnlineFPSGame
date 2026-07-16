interface Tickable {
  tick(nowMs: number): void;
}

interface RoomManagerLike {
  allRooms(): Tickable[];
}

/**
 * Single global tick driving every active room across every mode's room
 * manager, rather than one timer per room — cheaper and keeps all rooms'
 * simulation in lockstep. Uses a self-correcting setTimeout schedule (track
 * the intended next-tick time and only wait the remaining delta) instead of
 * a plain setInterval, so small per-tick overhead doesn't accumulate into
 * drift over a long match.
 */
export class GameLoop {
  private timer: NodeJS.Timeout | null = null;
  private nextTickTime = 0;

  constructor(private managers: RoomManagerLike[], private tickIntervalMs: number) {}

  start(): void {
    this.nextTickTime = Date.now();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    const delay = Math.max(0, this.nextTickTime - Date.now());
    this.timer = setTimeout(() => this.runTick(), delay);
  }

  private runTick(): void {
    const now = Date.now();
    for (const manager of this.managers) {
      for (const room of manager.allRooms()) {
        room.tick(now);
      }
    }

    this.nextTickTime += this.tickIntervalMs;
    // If we've fallen far behind (process was suspended, GC pause, etc.),
    // resync to now rather than trying to burn through a huge backlog of
    // catch-up ticks.
    if (this.nextTickTime < Date.now() - this.tickIntervalMs * 5) {
      this.nextTickTime = Date.now();
    }
    this.scheduleNext();
  }
}
