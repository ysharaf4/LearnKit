/**
 * Vault Audio Player & Interactive Playback State
 * Lightweight, zero-dependency audio playback for attached vault media (AU field / audioRef).
 * Handles wikilinks (![[audio.mp3]]), relative paths, HTML5 Audio playback, and
 * visual UI bindings (3-bar animated sound wave and hover stop icon).
 */

import type { App, TFile } from "obsidian";

let _activeAudioElement: HTMLAudioElement | null = null;
let _activeAudioBtn: HTMLElement | null = null;
const _activeAudioBtns = new Set<HTMLElement>();
let _activeAudioCleanup: (() => void) | null = null;
let _isAudioPlaying = false;
let _activeAudioRef: string | null = null;

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
  _isAudioPlaying = false;
  _activeAudioRef = null;

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
  targetBtn?: HTMLElement,
): HTMLAudioElement | null {
  stopActiveVaultAudio(false);

  const file = resolveVaultAudioFile(app, ref, sourceNotePath);
  if (!file) {
    clearActiveAudioButton();
    return null;
  }

  _isAudioPlaying = true;
  _activeAudioRef = ref;

  const activateMatchingButtons = () => {
    if (typeof document === "undefined") return;
    const selector = ref
      ? `.learnkit-flashcard-speak-btn[data-learnkit-audio-ref="${encodeURIComponent(ref)}"], .learnkit-tts-replay-btn`
      : ".learnkit-flashcard-speak-btn, .learnkit-tts-replay-btn";
    const matching = document.querySelectorAll<HTMLElement>(selector);
    matching.forEach((b) => markAudioButtonActive(b));
  };

  // Automatically mark the matching audio button as active to animate waves
  if (targetBtn) {
    markAudioButtonActive(targetBtn);
  }
  activateMatchingButtons();

  try {
    const resourcePath = app.vault.getResourcePath(file);
    const audio = new Audio(resourcePath);
    _activeAudioElement = audio;

    const cleanup = () => {
      _isAudioPlaying = false;
      _activeAudioRef = null;
      if (_activeAudioCleanup) {
        _activeAudioCleanup();
        _activeAudioCleanup = null;
      }
      if (_activeAudioElement === audio) {
        _activeAudioElement = null;
      }
      clearActiveAudioButton();
      onEnd?.();
    };

    const onPlayEvent = () => {
      activateMatchingButtons();
    };

    _activeAudioCleanup = () => {
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
    _isAudioPlaying = false;
    _activeAudioRef = null;
    clearActiveAudioButton();
    return null;
  }
}

/**
 * Check if vault audio is currently playing.
 */
export function isVaultAudioPlaying(): boolean {
  if (!_isAudioPlaying || !_activeAudioElement) return false;
  if (_activeAudioElement.ended) return false;
  return true;
}

/**
 * Mark a specific audio button as actively playing.
 */
export function markAudioButtonActive(btn: HTMLElement): void {
  bindAudioPlayingState(btn);
  _activeAudioBtns.add(btn);
  _activeAudioBtn = btn;
  btn.classList.add("is-tts-playing", "is-audio-playing");
  btn.setAttribute("aria-label", "Stop playing");
}

/**
 * Clear the active playing button state.
 */
export function clearActiveAudioButton(): void {
  for (const btn of _activeAudioBtns) {
    btn.classList.remove("is-tts-playing", "is-audio-playing");
    btn.setAttribute("aria-label", "Read aloud");
  }
  _activeAudioBtns.clear();
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
    idleWrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-volume-2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
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
  stopIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  playingWrap.appendChild(stopIcon);

  btn.appendChild(playingWrap);
}

// Backward-compatible alias exports for components transitioning from tts-service
export const bindTtsPlayingState = bindAudioPlayingState;
export const markTtsButtonActive = markAudioButtonActive;
export const clearActiveTtsButton = clearActiveAudioButton;
