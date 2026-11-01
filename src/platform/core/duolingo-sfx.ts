/**
 * Duolingo Web Audio Synthesizer
 * High-fidelity, zero-asset audio synthesis replicating Duolingo's iconic sound design:
 * - Warm marimba victory chime on correct reviews (G5 -> C6 -> E6 harmonic chime)
 * - Gentle, supportive wooden double-thud on incorrect reviews (warm filtered low marimba)
 * - Tactile wooden bubble pop on button clicks and card reveals
 * - Triumphant bell/arpeggio fanfare on session completion
 */

export class DuolingoSoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private enabled = true;
  private unlockAttached = false;

  constructor() {
    this.attachUnlockListeners();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Unlock and resume AudioContext on user gesture
   */
  unlock(): void {
    if (this.init() && this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
  }

  private attachUnlockListeners(): void {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function" || this.unlockAttached) return;
    this.unlockAttached = true;

    const onFirstGesture = () => {
      this.unlock();
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("pointerdown", onFirstGesture);
        window.removeEventListener("keydown", onFirstGesture);
      }
    };

    window.addEventListener("pointerdown", onFirstGesture, { passive: true, capture: true });
    window.addEventListener("keydown", onFirstGesture, { passive: true, capture: true });
  }

  private init(): boolean {
    if (typeof window === "undefined") return false;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        try {
          this.ctx = new AudioCtx();
          // Dynamics compressor to prevent digital clipping / distortion
          this.compressor = this.ctx.createDynamicsCompressor();
          this.compressor.threshold.setValueAtTime(-14, this.ctx.currentTime);
          this.compressor.knee.setValueAtTime(30, this.ctx.currentTime);
          this.compressor.ratio.setValueAtTime(8, this.ctx.currentTime);
          this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
          this.compressor.release.setValueAtTime(0.2, this.ctx.currentTime);

          // Master volume gain
          this.masterGain = this.ctx.createGain();
          this.masterGain.gain.setValueAtTime(0.32, this.ctx.currentTime);

          // Gentle lowpass filter for warm acoustic feel
          this.filter = this.ctx.createBiquadFilter();
          this.filter.type = "lowpass";
          this.filter.frequency.setValueAtTime(5000, this.ctx.currentTime);

          // Graph: source -> filter -> compressor -> masterGain -> destination
          this.filter.connect(this.compressor);
          this.compressor.connect(this.masterGain);
          this.masterGain.connect(this.ctx.destination);
        } catch {
          return false;
        }
      }
    }

    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }

    return !!this.ctx && !!this.filter;
  }

  /**
   * Synthesize a single warm marimba/bell tone with fundamental + harmonic overtone
   */
  private playMarimbaTone(
    freq: number,
    startTime: number,
    duration: number,
    volume: number = 0.35,
    decayRate: number = 0.0001,
  ): void {
    if (!this.ctx || !this.filter) return;

    // 1. Fundamental tone (warm sine wave)
    const osc1 = this.ctx.createOscillator();
    const gain1 = this.ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(freq, startTime);

    gain1.gain.setValueAtTime(0.0001, startTime);
    gain1.gain.linearRampToValueAtTime(volume, startTime + 0.004);
    gain1.gain.exponentialRampToValueAtTime(decayRate, startTime + duration);

    osc1.connect(gain1);
    gain1.connect(this.filter);
    osc1.start(startTime);
    osc1.stop(startTime + duration + 0.02);

    // 2. Harmonic overtone (2.0x frequency for acoustic mallet depth)
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, startTime);

    gain2.gain.setValueAtTime(0.0001, startTime);
    gain2.gain.linearRampToValueAtTime(volume * 0.22, startTime + 0.003);
    gain2.gain.exponentialRampToValueAtTime(decayRate, startTime + duration * 0.5);

    osc2.connect(gain2);
    gain2.connect(this.filter);
    osc2.start(startTime);
    osc2.stop(startTime + duration * 0.5 + 0.02);
  }

  /**
   * Tactile button click / wooden bubble pop (460Hz -> 160Hz slide)
   */
  playClick(): void {
    if (!this.enabled || !this.init() || !this.ctx || !this.filter) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(460, now);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.045);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.24, now + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

      osc.connect(gain);
      gain.connect(this.filter);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch {
      // Safe fallback
    }
  }

  /**
   * Duolingo Victory Chime (Correct answer / Good / Easy)
   * Crisp, warm, uplifting 3-note chime: G5 (784Hz) -> C6 (1046.5Hz) -> E6 (1318.5Hz)
   */
  playCorrect(): void {
    if (!this.enabled || !this.init() || !this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const notes = [
        { freq: 783.99, delay: 0.0, dur: 0.28, vol: 0.32 },
        { freq: 1046.5, delay: 0.075, dur: 0.32, vol: 0.36 },
        { freq: 1318.51, delay: 0.155, dur: 0.42, vol: 0.38 },
      ];

      for (const note of notes) {
        this.playMarimbaTone(note.freq, now + note.delay, note.dur, note.vol);
      }
    } catch {
      // Safe fallback
    }
  }

  /**
   * Duolingo Supportive Error Thud (Incorrect answer / Again / Hard)
   * Soft, warm wooden double-thud: F3 (174.6Hz) -> C#3 (138.6Hz) with filtered warmth
   * NEVER harsh or abrasive — gentle acoustic encouragement
   */
  playIncorrect(): void {
    if (!this.enabled || !this.init() || !this.ctx || !this.filter) return;
    try {
      const now = this.ctx.currentTime;
      const tones = [
        { freq: 174.61, delay: 0.0, dur: 0.16, vol: 0.38 },
        { freq: 138.59, delay: 0.11, dur: 0.22, vol: 0.34 },
      ];

      for (const tone of tones) {
        const start = now + tone.delay;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        // Warm triangle wave filtered down feels like soft wood
        osc.type = "triangle";
        osc.frequency.setValueAtTime(tone.freq, start);
        osc.frequency.exponentialRampToValueAtTime(tone.freq * 0.88, start + tone.dur);

        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(tone.vol, start + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.dur);

        osc.connect(gain);
        gain.connect(this.filter);
        osc.start(start);
        osc.stop(start + tone.dur + 0.02);
      }
    } catch {
      // Safe fallback
    }
  }

  /**
   * Duolingo Fanfare / Session Complete celebration
   * Bright, triumphant arpeggio with rich sustaining chord
   */
  playFanfare(): void {
    if (!this.enabled || !this.init() || !this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      // Arpeggio: C5 -> E5 -> G5 -> C6 -> chord
      const arpeggio = [
        { freq: 523.25, delay: 0.0, dur: 0.22, vol: 0.3 },
        { freq: 659.25, delay: 0.09, dur: 0.24, vol: 0.32 },
        { freq: 783.99, delay: 0.18, dur: 0.26, vol: 0.34 },
        { freq: 1046.5, delay: 0.27, dur: 0.55, vol: 0.4 },
      ];

      for (const note of arpeggio) {
        this.playMarimbaTone(note.freq, now + note.delay, note.dur, note.vol);
      }

      // Sustaining harmony chord at the peak
      const chordDelay = now + 0.36;
      [659.25, 783.99, 1046.5].forEach((freq) => {
        this.playMarimbaTone(freq, chordDelay, 0.65, 0.22, 0.0001);
      });
    } catch {
      // Safe fallback
    }
  }
}

export const soundEngine = new DuolingoSoundEngine();
