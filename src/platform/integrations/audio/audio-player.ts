/**
 * Vault Audio Player & Interactive Playback State
 * Event-driven, decoupled audio playback for attached vault media (AU field / audioRef).
 * Handles wikilinks (![[audio.mp3]]), relative paths, HTML5 Audio playback, and
 * visual UI bindings (3-bar animated sound wave and hover stop icon).
 */

import { type App, TFile } from "obsidian";
import { t } from "../../translations/translator";

export interface AudioPlaybackState {
  isPlaying: boolean;
  audioRef: string | null;
  audioElement: HTMLAudioElement | null;
}

export type AudioPlaybackListener = (state: AudioPlaybackState) => void;

/**
 * Resolve an audio file reference (wikilink or path) to a TFile in the vault.
 */
export function resolveVaultAudioFile(app: App, ref: string, sourceNotePath?: string): TFile | null {
  if (!ref || !app?.vault) return null;
  const cleanRef = ref.replace(/^!\[\[/, "").replace(/\]\]$/, "").trim();
  if (!cleanRef) return null;

  const file = app.vault.getAbstractFileByPath(cleanRef);
  if (file instanceof TFile) {
    return file;
  }

  if (app.metadataCache) {
    const dest = app.metadataCache.getFirstLinkpathDest(cleanRef, sourceNotePath || "");
    if (dest) return dest;
  }

  return null;
}

function matchesAudioRef(btn: HTMLElement, currentRef: string): boolean {
  const rawRef = btn.getAttribute("data-learnkit-audio-ref");
  if (!rawRef) {
    // Buttons without a specific audio-ref attribute (e.g. general reviewer replay buttons) match
    return true;
  }
  const decoded = decodeURIComponent(rawRef);
  const cleanCurrent = currentRef.replace(/^!\[\[/, "").replace(/\]\]$/, "").trim();
  const cleanDecoded = decoded.replace(/^!\[\[/, "").replace(/\]\]$/, "").trim();
  return (
    decoded === currentRef ||
    rawRef === currentRef ||
    cleanDecoded === cleanCurrent ||
    rawRef === encodeURIComponent(currentRef)
  );
}

function createVolume2Svg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "svg-icon lucide-volume-2");

  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("points", "11 5 6 9 2 9 2 15 6 15 11 19 11 5");
  svg.appendChild(poly);

  const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path1.setAttribute("d", "M15.54 8.46a5 5 0 0 1 0 7.07");
  svg.appendChild(path1);

  const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path2.setAttribute("d", "M19.07 4.93a10 10 0 0 1 0 14.14");
  svg.appendChild(path2);

  return svg;
}

function createStopSvg(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "none");
  svg.setAttribute("class", "svg-icon lucide-square");

  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "14");
  rect.setAttribute("height", "14");
  rect.setAttribute("x", "5");
  rect.setAttribute("y", "5");
  rect.setAttribute("rx", "2");
  svg.appendChild(rect);

  return svg;
}

/**
 * Event-driven controller managing audio playback, button registrations,
 * and state notifications without direct DOM querying across views.
 */
export class AudioPlaybackController {
  private _state: AudioPlaybackState = {
    isPlaying: false,
    audioRef: null,
    audioElement: null,
  };
  private _listeners = new Set<AudioPlaybackListener>();
  private _boundButtons = new Set<HTMLElement>();
  private _activeButtons = new Set<HTMLElement>();
  private _activeButton: HTMLElement | null = null;
  private _activeCleanup: (() => void) | null = null;

  getState(): AudioPlaybackState {
    return { ...this._state };
  }

  isPlaying(): boolean {
    if (!this._state.isPlaying || !this._state.audioElement) return false;
    return !this._state.audioElement.ended;
  }

  subscribe(listener: AudioPlaybackListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(): void {
    const currentState = this.getState();
    for (const listener of this._listeners) {
      try {
        listener(currentState);
      } catch {
        // Safe fallback for subscriber errors
      }
    }
  }

  bindButton(btn: HTMLElement, audioRef?: string): () => void {
    this._ensureButtonDom(btn);
    this._boundButtons.add(btn);
    if (audioRef) {
      btn.setAttribute("data-learnkit-audio-ref", encodeURIComponent(audioRef));
    }

    if (this.isPlaying() && this._state.audioRef) {
      if (matchesAudioRef(btn, this._state.audioRef)) {
        this.markButtonActive(btn);
      }
    }

    return () => {
      this._boundButtons.delete(btn);
      this._activeButtons.delete(btn);
      if (this._activeButton === btn) {
        this._activeButton = null;
      }
    };
  }

  markButtonActive(btn: HTMLElement): void {
    this._ensureButtonDom(btn);
    this._boundButtons.add(btn);
    this._activeButtons.add(btn);
    this._activeButton = btn;
    btn.classList.add("is-tts-playing", "is-audio-playing");

    if (!btn.hasAttribute("data-original-label")) {
      const currentLabel = btn.getAttribute("aria-label");
      if (currentLabel) {
        btn.setAttribute("data-original-label", currentLabel);
      }
    }
    btn.setAttribute("aria-label", t(undefined, "ui.common.stopPlaying", "Stop playing"));
  }

  clearActiveButtons(): void {
    const restoreBtnLabel = (b: HTMLElement) => {
      b.classList.remove("is-tts-playing", "is-audio-playing");
      const orig = b.getAttribute("data-original-label");
      if (orig) {
        b.setAttribute("aria-label", orig);
        b.removeAttribute("data-original-label");
      } else {
        b.setAttribute("aria-label", t(undefined, "ui.reading.flashcard.readAloud", "Read aloud"));
      }
    };

    const buttonsToRestore = new Set(this._activeButtons);
    if (this._activeButton) {
      buttonsToRestore.add(this._activeButton);
      this._activeButton = null;
    }
    this._activeButtons.clear();

    for (const btn of buttonsToRestore) {
      restoreBtnLabel(btn);
    }
  }

  play(
    app: App,
    ref: string,
    sourceNotePath?: string,
    onEnd?: () => void,
    targetBtn?: HTMLElement,
  ): HTMLAudioElement | null {
    this.stop(false);

    const file = resolveVaultAudioFile(app, ref, sourceNotePath);
    if (!file) {
      this.clearActiveButtons();
      return null;
    }

    this._state = {
      isPlaying: true,
      audioRef: ref,
      audioElement: null,
    };

    if (targetBtn) {
      this.markButtonActive(targetBtn);
    }

    this._syncMatchingButtons(ref);
    this._notify();

    try {
      const resourcePath = app.vault.getResourcePath(file);
      const audio = new Audio(resourcePath);
      this._state.audioElement = audio;

      const cleanup = () => {
        if (this._state.audioElement === audio) {
          this.stop(true);
        }
        onEnd?.();
      };

      const onPlayEvent = () => {
        this._syncMatchingButtons(ref);
        this._notify();
      };

      this._activeCleanup = () => {
        audio.removeEventListener("ended", cleanup);
        audio.removeEventListener("error", cleanup);
        audio.removeEventListener("play", onPlayEvent);
        audio.removeEventListener("playing", onPlayEvent);
      };

      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      audio.addEventListener("play", onPlayEvent);
      audio.addEventListener("playing", onPlayEvent);

      void audio.play().catch(() => {
        cleanup();
      });

      return audio;
    } catch {
      this.stop(true);
      return null;
    }
  }

  stop(clearButtons = true): void {
    const wasPlaying = this._state.isPlaying;
    if (this._activeCleanup) {
      this._activeCleanup();
      this._activeCleanup = null;
    }

    if (this._state.audioElement) {
      try {
        this._state.audioElement.pause();
        this._state.audioElement.currentTime = 0;
      } catch {
        // Safe fallback
      }
    }

    this._state = {
      isPlaying: false,
      audioRef: null,
      audioElement: null,
    };

    if (clearButtons) {
      this.clearActiveButtons();
    }

    if (wasPlaying) {
      this._notify();
    }
  }

  reset(): void {
    this.stop(true);
    this._boundButtons.clear();
    this._listeners.clear();
  }

  private _syncMatchingButtons(ref: string): void {
    for (const btn of this._boundButtons) {
      if (matchesAudioRef(btn, ref)) {
        this.markButtonActive(btn);
      }
    }
  }

  private _ensureButtonDom(btn: HTMLElement): void {
    if (btn.querySelector(".learnkit-sound-wave")) return;

    let idleWrap = btn.querySelector<HTMLElement>(".tts-icon-idle");
    if (!idleWrap) {
      idleWrap = document.createElement("span");
      idleWrap.className = "tts-icon-idle";
      while (btn.firstChild) {
        idleWrap.appendChild(btn.firstChild);
      }
      btn.appendChild(idleWrap);
    }

    if (!idleWrap.querySelector("svg")) {
      idleWrap.appendChild(createVolume2Svg());
    }

    const playingWrap = document.createElement("span");
    playingWrap.className = "tts-icon-playing";

    const wave = document.createElement("span");
    wave.className = "learnkit-sound-wave";
    for (let i = 0; i < 3; i++) {
      const bar = document.createElement("span");
      bar.className = `learnkit-sound-bar learnkit-sound-bar-${i + 1} bar-${i + 1}`;
      wave.appendChild(bar);
    }
    playingWrap.appendChild(wave);

    const stopIcon = document.createElement("span");
    stopIcon.className = "tts-icon-stop";
    stopIcon.appendChild(createStopSvg());
    playingWrap.appendChild(stopIcon);

    btn.appendChild(playingWrap);
  }
}

/**
 * Singleton AudioPlaybackController instance.
 */
export const audioPlaybackController = new AudioPlaybackController();

/**
 * Stop any actively playing vault audio and reset the active button state.
 */
export function stopActiveVaultAudio(clearButton = true): void {
  audioPlaybackController.stop(clearButton);
}

/**
 * Play an attached vault audio file.
 */
export function playVaultAudio(
  app: App,
  ref: string,
  sourceNotePath?: string,
  onEnd?: () => void,
  targetBtn?: HTMLElement,
): HTMLAudioElement | null {
  return audioPlaybackController.play(app, ref, sourceNotePath, onEnd, targetBtn);
}

/**
 * Check if vault audio is currently playing.
 */
export function isVaultAudioPlaying(): boolean {
  return audioPlaybackController.isPlaying();
}

/**
 * Mark a specific audio button as actively playing.
 */
export function markAudioButtonActive(btn: HTMLElement): void {
  audioPlaybackController.markButtonActive(btn);
}

/**
 * Clear the active playing button state.
 */
export function clearActiveAudioButton(): void {
  audioPlaybackController.clearActiveButtons();
}

/**
 * Bind audio playing state icons and markup to an audio button:
 * - Idle: Speaker icon (volume-2)
 * - Playing: 3-bar animated equalizer wave
 * - Hover while playing: Stop icon
 */
export function bindAudioPlayingState(btn: HTMLElement, audioRef?: string): () => void {
  return audioPlaybackController.bindButton(btn, audioRef);
}

/**
 * Subscribe to playback state changes.
 */
export function onAudioPlaybackStateChange(listener: AudioPlaybackListener): () => void {
  return audioPlaybackController.subscribe(listener);
}

/**
 * Get current playback state snapshot.
 */
export function getAudioPlaybackState(): AudioPlaybackState {
  return audioPlaybackController.getState();
}

// Backward-compatible alias exports for components transitioning from tts-service
export const bindTtsPlayingState = bindAudioPlayingState;
export const markTtsButtonActive = markAudioButtonActive;
export const clearActiveTtsButton = clearActiveAudioButton;
