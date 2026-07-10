import { WeaponId } from "@fps/shared";

/**
 * All sound in the game is synthesized at runtime via the Web Audio API —
 * no external audio files. That keeps the bundle tiny and load instant (the
 * "playable in under 5 seconds on decent wifi" goal), and every sound is
 * cheap enough to generate on the fly that there's no pooling/streaming
 * complexity to get right.
 *
 * Browsers block audio until a user gesture, so the AudioContext is created
 * lazily on first call to resume() rather than at module load.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientNodes: { stop(): void } | null = null;
  private volume = 0.6;

  /** Call from a real user-gesture handler (button click) before any other
   * method — no-ops safely if called again. */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.buildNoiseBuffer(this.ctx);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  playShot(weapon: WeaponId): void {
    if (!this.ready()) return;
    if (weapon === "rifle") {
      this.noiseBurst({ freq: 2400, q: 0.8, type: "bandpass", duration: 0.05, gain: 0.5 });
      this.tone({ freq: 160, freqEnd: 90, duration: 0.06, gain: 0.35, type: "sine" });
    } else if (weapon === "smg") {
      this.noiseBurst({ freq: 2800, q: 0.7, type: "bandpass", duration: 0.035, gain: 0.32 });
      this.tone({ freq: 190, freqEnd: 120, duration: 0.04, gain: 0.22, type: "sine" });
    } else {
      this.noiseBurst({ freq: 550, q: 0.5, type: "lowpass", duration: 0.22, gain: 0.7 });
      this.tone({ freq: 90, freqEnd: 45, duration: 0.2, gain: 0.5, type: "sine" });
    }
  }

  playReloadStart(): void {
    if (!this.ready()) return;
    this.noiseBurst({ freq: 1800, q: 3, type: "bandpass", duration: 0.03, gain: 0.2 });
  }

  playReloadFinish(): void {
    if (!this.ready()) return;
    this.noiseBurst({ freq: 2200, q: 3, type: "bandpass", duration: 0.03, gain: 0.22 });
  }

  playHitmarker(killed: boolean, headshot = false): void {
    if (!this.ready()) return;
    // Headshot ping is layered independently of kill/body-hit tone below, so
    // a headshot kill gets both the bright "ding" and the kill confirmation.
    if (headshot) {
      this.tone({ freq: 1900, duration: 0.045, gain: 0.32, type: "sine" });
      this.tone({ freq: 2600, duration: 0.05, gain: 0.22, type: "sine", delaySec: 0.03 });
    }
    if (killed) {
      this.tone({ freq: 700, duration: 0.05, gain: 0.3, type: "triangle" });
      this.tone({ freq: 1100, duration: 0.08, gain: 0.32, type: "triangle", delaySec: 0.045 });
    } else if (!headshot) {
      this.tone({ freq: 1300, duration: 0.035, gain: 0.22, type: "triangle" });
    }
  }

  playDamageTaken(): void {
    if (!this.ready()) return;
    this.tone({ freq: 260, freqEnd: 120, duration: 0.14, gain: 0.28, type: "sawtooth" });
    this.noiseBurst({ freq: 350, q: 0.6, type: "lowpass", duration: 0.1, gain: 0.25 });
  }

  playRespawn(): void {
    if (!this.ready()) return;
    this.tone({ freq: 440, freqEnd: 660, duration: 0.18, gain: 0.25, type: "sine" });
  }

  playUIClick(): void {
    if (!this.ready()) return;
    this.tone({ freq: 520, duration: 0.025, gain: 0.18, type: "square" });
  }

  playCountdownBeep(isGo: boolean): void {
    if (!this.ready()) return;
    this.tone({ freq: isGo ? 920 : 600, duration: isGo ? 0.22 : 0.09, gain: 0.3, type: "sine" });
  }

  startAmbient(): void {
    if (!this.ready() || this.ambientNodes) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    filter.Q.value = 0.5;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    const gain = ctx.createGain();
    gain.gain.value = 0.05;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    src.start();
    lfo.start();

    this.ambientNodes = {
      stop() {
        src.stop();
        lfo.stop();
      },
    };
  }

  stopAmbient(): void {
    this.ambientNodes?.stop();
    this.ambientNodes = null;
  }

  private ready(): boolean {
    return this.ctx !== null && this.master !== null;
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private noiseBurst(opts: {
    freq: number;
    q: number;
    type: BiquadFilterType;
    duration: number;
    gain: number;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(opts.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + opts.duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    src.start(now);
    src.stop(now + opts.duration + 0.02);
  }

  private tone(opts: {
    freq: number;
    freqEnd?: number;
    duration: number;
    gain: number;
    type: OscillatorType;
    delaySec?: number;
  }): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    const gain = ctx.createGain();
    const now = ctx.currentTime + (opts.delaySec ?? 0);

    osc.frequency.setValueAtTime(opts.freq, now);
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqEnd), now + opts.duration);
    }
    gain.gain.setValueAtTime(opts.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + opts.duration);

    osc.connect(gain);
    gain.connect(this.master!);
    osc.start(now);
    osc.stop(now + opts.duration + 0.02);
  }
}

export const soundEngine = new SoundEngine();
