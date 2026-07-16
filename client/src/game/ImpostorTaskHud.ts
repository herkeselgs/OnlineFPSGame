import { SequenceKey, TaskStationDef } from "@fps/shared";

const ARROW_GLYPH: Record<SequenceKey, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Owns the task checklist panel, the proximity interact-prompt DOM, and the
 * emergency-meeting button for Imposter mode — its own small class rather
 * than adding to Duel's Hud, same sibling-class reasoning as everything
 * else in this mode. Purely a rendering layer: every value it's given
 * (progress, sequence state) is either server-confirmed or an
 * explicitly-labeled local optimistic guess, never something this class
 * computes authoritatively itself.
 *
 * The checklist shows only THIS player's own assigned stations (see
 * ImpostorRoom's per-player task model) — a crewmate never sees anyone
 * else's list, matching Among Us.
 */
export class ImpostorTaskHud {
  private checklistEl = document.getElementById("imp-task-checklist") as HTMLDivElement;
  private aggregateEl = document.getElementById("imp-task-aggregate") as HTMLDivElement;
  private promptEl = document.getElementById("imp-task-prompt") as HTMLDivElement;
  private promptTextEl = document.getElementById("imp-task-prompt-text") as HTMLDivElement;
  private progressBarEl = document.getElementById("imp-task-progress-bar") as HTMLDivElement;
  private progressFillEl = document.getElementById("imp-task-progress-fill") as HTMLDivElement;
  private sequenceEl = document.getElementById("imp-task-sequence") as HTMLDivElement;
  private meetingBtn = document.getElementById("btn-imp-call-meeting") as HTMLButtonElement;
  private meetingRemainingEl = document.getElementById("imp-meeting-remaining") as HTMLSpanElement;

  private allStations: TaskStationDef[] = [];
  private assignedIds: string[] = [];
  private completed = new Set<string>();

  constructor(onCallMeeting: () => void) {
    this.meetingBtn.addEventListener("click", onCallMeeting);
  }

  setStations(stations: TaskStationDef[]): void {
    this.allStations = stations;
    this.renderChecklist();
  }

  setAssignment(assignedIds: string[]): void {
    this.assignedIds = assignedIds;
    this.renderChecklist();
  }

  setProgress(completedIds: string[]): void {
    this.completed = new Set(completedIds);
    this.renderChecklist();
  }

  setAggregateProgress(completed: number, total: number): void {
    this.aggregateEl.textContent = `Crew tasks: ${completed} / ${total}`;
  }

  private renderChecklist(): void {
    this.checklistEl.innerHTML = "";
    for (const id of this.assignedIds) {
      const station = this.allStations.find((s) => s.id === id);
      if (!station) continue;
      const done = this.completed.has(id);
      const row = document.createElement("div");
      row.className = "imp-task-row" + (done ? " imp-task-done" : "");
      row.textContent = `${done ? "✓" : "○"} ${station.name}`;
      this.checklistEl.appendChild(row);
    }
  }

  show(): void {
    this.checklistEl.classList.remove("hidden");
    this.aggregateEl.classList.remove("hidden");
  }

  hide(): void {
    this.checklistEl.classList.add("hidden");
    this.aggregateEl.classList.add("hidden");
    this.hidePrompt();
    this.hideMeetingButton();
  }

  showMeetingButton(remaining: number): void {
    this.meetingBtn.classList.toggle("hidden", remaining <= 0);
    this.meetingRemainingEl.textContent = String(remaining);
  }

  hideMeetingButton(): void {
    this.meetingBtn.classList.add("hidden");
  }

  /** progress01 is a locally-estimated fraction (0-1) for the fill
   * animation only — actual completion is decided server-side and arrives
   * through setProgress, so a little client/server timing drift here is
   * cosmetic and harmless. */
  showHoldPrompt(name: string, progress01: number): void {
    this.promptEl.classList.remove("hidden");
    this.promptTextEl.textContent = `Hold E — ${name}`;
    this.sequenceEl.classList.add("hidden");
    this.progressBarEl.classList.remove("hidden");
    this.progressFillEl.style.width = `${Math.max(0, Math.min(1, progress01)) * 100}%`;
  }

  showStartPrompt(name: string): void {
    this.promptEl.classList.remove("hidden");
    this.promptTextEl.textContent = `Press E — ${name}`;
    this.sequenceEl.classList.add("hidden");
    this.progressBarEl.classList.add("hidden");
  }

  showSequence(name: string, sequence: SequenceKey[], correctCount: number): void {
    this.promptEl.classList.remove("hidden");
    this.promptTextEl.textContent = name;
    this.progressBarEl.classList.add("hidden");
    this.sequenceEl.classList.remove("hidden");
    this.sequenceEl.innerHTML = "";
    sequence.forEach((key, i) => {
      const glyph = document.createElement("span");
      glyph.className = "imp-seq-key" + (i < correctCount ? " imp-seq-key-done" : i === correctCount ? " imp-seq-key-next" : "");
      glyph.textContent = ARROW_GLYPH[key];
      this.sequenceEl.appendChild(glyph);
    });
  }

  hidePrompt(): void {
    this.promptEl.classList.add("hidden");
  }
}
