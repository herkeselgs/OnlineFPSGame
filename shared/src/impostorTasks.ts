import { Vec3 } from "./vec.js";

/** "hold": stand in range and hold the interact key for a fixed duration.
 * "sequence": stand in range, press interact to start, then repeat a short
 * randomly-generated arrow-key sequence shown on screen. Two kinds is
 * deliberately the whole catalog for this milestone — enough variety to not
 * feel repetitive across a handful of stations without building a full
 * minigame suite. */
export type TaskKind = "hold" | "sequence";

export interface TaskStationDef {
  id: string;
  kind: TaskKind;
  name: string;
  position: Vec3;
  radius: number;
  /** Only meaningful for "hold" stations. */
  holdDurationMs: number;
  /** Only meaningful for "sequence" stations. */
  sequenceLength: number;
}

export const HOLD_TASK_DURATION_MS = 3000;
export const SEQUENCE_TASK_LENGTH = 4;
export const TASK_INTERACT_RADIUS = 2.4;

/** Arrow keys rather than WASD — WASD already means movement, and a task
 * that asks you to stand still while pressing "move" keys would read as
 * self-contradictory. Arrow keys are unused by anything else in the game. */
export const SEQUENCE_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;
export type SequenceKey = (typeof SEQUENCE_KEYS)[number];

export interface TaskStationState {
  id: string;
  completed: boolean;
}
