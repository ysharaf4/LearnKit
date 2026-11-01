/**
 * Vault Audio Player & Interactive Playback State
 * Lightweight, zero-dependency audio playback for attached vault media (AU field / audioRef).
 * Handles wikilinks (![[audio.mp3]]), relative paths, HTML5 Audio playback, and
 * visual UI bindings (3-bar animated sound wave and hover stop icon).
 */

import type { App, TFile } from "obsidian";

let _activeAudioElement: HTMLAudioElement | null = null;
let _activeAudioBtn: HTMLElement | null = null;
let _activeAudioCleanup: (() => void) | null = null;

/**
 * Resolve an audio file reference (wikilink or path) to a TFile in the vault.
 */
export function resolveVaultAudioFile(app: App, ref: string, sourceNotePath?: string): TFile | null {
  if (!ref || !app?.vault) return null;
  const cleanRef = ref.replace(/^!\[\[/, "").replace(/\]\]$/, "").trim();
  if (!cleanRef) return null;

  let file = app.vault.getAbstractFileByPath(cleanRef);
  if (file && "extension" in file) {
    return file as TFile;
  }

  if (app.metadataCache) {
    const dest = app.metadataCache.getFirstLinkpathDest(cleanRef, sourceNotePath || "");
    if (dest) return dest;
  }

  return null;
}

/**
 * Stop any actively playing vault audio and reset the active button state.
 */
export function stopActiveVaultAudio(clearButton = true): void {
  if (_activeAudioCleanup) {
    _activeAudioCleanup();
    _activeAudioCleanup = null;
  }

  if (_activeAudioElement) {
    try {
      _activeAudioElement.pause();
      _activeAudioElement.currentTime = 0;
    } catch {
      // Safe fallback
    }
    _activeAudioElement = null;
  }

  if (clearButton) {
    clearActiveAudioButton();
  }
}

/**
 * Play an attached vault audio file.
 */
export function playVaultAudio(
  app: App,
  ref: string,
  sourceNotePath?: string,
  onEnd?: () => void,
): HTMLAudioElement | null {
  stopActiveVaultAudio(false);

  const file = resolveVaultAudioFile(app, ref, sourceNotePath);
  if (!file) {
    clearActiveAudioButton();
    return null;
  }

  try {
    const resourcePath = app.vault.getResourcePath(file);
    const audio = new Audio(resourcePath);
    _activeAudioElement = audio;

    const cleanup = () => {
      if (_activeAudioElement === audio) {
        _activeAudioElement = null;
      }
      clearActiveAudioButton();
      onEnd?.();
    };

    _activeAudioCleanup = () => {
      audio.removeEventListener("ended", cleanup);
      audio.removeEventListener("error", cleanup);
    };

    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });

    void audio.play().catch(() => {
      cleanup();
    });

    return audio;
  } catch {
    clearActiveAudioButton();
    return null;
  }
}

/**
 * Check if vault audio is currently playing.
 */
export function isVaultAudioPlaying(): boolean {
  return !!_activeAudioElement && !_activeAudioElement.paused;
}

/**
 * Mark a specific audio button as actively playing.
 */
export function markAudioButtonActive(btn: HTMLElement): void {
  if (_activeAudioBtn && _activeAudioBtn !== btn) {
    _activeAudioBtn.classList.remove("is-tts-playing", "is-audio-playing");
    _activeAudioBtn.setAttribute("aria-label", "Read aloud");
  }
  _activeAudioBtn = btn;
  btn.classList.add("is-tts-playing", "is-audio-playing");
  btn.setAttribute("aria-label", "Stop playing");
}

/**
 * Clear the active playing button state.
 */
export function clearActiveAudioButton(): void {
  if (_activeAudioBtn) {
    _activeAudioBtn.classList.remove("is-tts-playing", "is-audio-playing");
    _activeAudioBtn.setAttribute("aria-label", "Read aloud");
    _activeAudioBtn = null;
  }
}

/**
 * Bind audio playing state icons and markup to an audio button:
 * - Idle: Speaker icon (volume-2)
 * - Playing: 3-bar animated equalizer wave
 * - Hover while playing: Stop icon
 */
export function bindAudioPlayingState(btn: HTMLElement): void {
  // If already bound, do not duplicate
  if (btn.querySelector(".learnkit-sound-wave")) return;

  const idleWrap = document.createElement("span");
  idleWrap.className = "tts-icon-idle";

  while (btn.firstChild) {
    idleWrap.appendChild(btn.firstChild);
  }
  btn.appendChild(idleWrap);

  const playingWrap = document.createElement("span");
  playingWrap.className = "tts-icon-playing";

  const wave = document.createElement("span");
  wave.className = "learnkit-sound-wave";
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement("span");
    bar.className = `learnkit-sound-bar learnkit-sound-bar-${i + 1}`;
    wave.appendChild(bar);
  }
  playingWrap.appendChild(wave);

  const stopIcon = document.createElement("span");
  stopIcon.className = "tts-icon-stop";
  stopIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  playingWrap.appendChild(stopIcon);

  btn.appendChild(playingWrap);
}

// Backward-compatible alias exports for components transitioning from tts-service
export const bindTtsPlayingState = bindAudioPlayingState;
export const markTtsButtonActive = markAudioButtonActive;
export const clearActiveTtsButton = clearActiveAudioButton;
