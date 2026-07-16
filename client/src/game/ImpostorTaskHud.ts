import { SequenceKey, TaskStationDef, TaskStationState } from "@fps/shared";

const ARROW_GLYPH: Record<SequenceKey, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * Owns the task checklist panel and the proximity interact-prompt DOM for
 * Imposter mode — its own small class rather than adding to Duel's Hud,
 * same sibling-class reasoning as everything else in this mode. Purely a
 * rendering layer: every value it's given (progress, sequence state) is
 * either server-confirmed or an explicitly-labeled local optimistic guess,
 * never something this class computes authoritatively itself.
 */
export class ImpostorTaskHud {
  private checklistEl = document.getElementById("imp-task-checklist") as HTMLDivElement;
  private promptEl = document.getElementById("imp-task-prompt") as HTMLDivElement;
  private promptTextEl = document.getElementById("imp-task-prompt-text") as HTMLDivElement;
  private progressBarEl = document.getElementById("imp-task-progress-bar") as HTMLDivElement;
  private progressFillEl = document.getElementById("imp-task-progress-fill") as HTMLDivElement;
  private sequenceEl = document.getElementById("imp-task-sequence") as HTMLDivElement;

  private stations: TaskStationDef[] = [];
  private completed = new Set<string>();

  setStations(stations: TaskStationDef[]): void {
    this.stations = stations;
    this.renderChecklist();
  }

  setProgress(states: TaskStationState[]): void {
    this.completed = new Set(states.filter((s) => s.completed).map((s) => s.id));
    this.renderChecklist();
  }

  private renderChecklist(): void {
    this.checklistEl.innerHTML = "";
    for (const s of this.stations) {
      const done = this.completed.has(s.id);
      const row = document.createElement("div");
      row.className = "imp-task-row" + (done ? " imp-task-done" : "");
      row.textContent = `${done ? "✓" : "○"} ${s.name}`;
      this.checklistEl.appendChild(row);
    }
  }

  show(): void {
    this.checklistEl.classList.remove("hidden");
  }

  hide(): void {
    this.checklistEl.classList.add("hidden");
    this.hidePrompt();
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
