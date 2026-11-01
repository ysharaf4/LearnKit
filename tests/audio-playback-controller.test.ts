// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TFile } from "obsidian";
import {
  AudioPlaybackController,
  type AudioPlaybackState,
  bindAudioPlayingState,
  markAudioButtonActive,
  clearActiveAudioButton,
  stopActiveVaultAudio,
  playVaultAudio,
  isVaultAudioPlaying,
  onAudioPlaybackStateChange,
  audioPlaybackController,
} from "../src/platform/integrations/audio/audio-player";

describe("AudioPlaybackController (Event-Driven Playback)", () => {
  let controller: AudioPlaybackController;
  const mockFile = Object.assign(new TFile(), { path: "audio/sample.mp3", extension: "mp3" });
  const mockApp = {
    vault: {
      getAbstractFileByPath: vi.fn().mockReturnValue(mockFile),
      getResourcePath: vi.fn().mockReturnValue("app://local/audio/sample.mp3"),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn().mockReturnValue(mockFile),
    },
  } as any;

  beforeEach(() => {
    controller = new AudioPlaybackController();
    audioPlaybackController.reset();
  });

  afterEach(() => {
    controller.reset();
    audioPlaybackController.reset();
  });

  it("notifies subscribers when playback starts and stops", () => {
    const states: AudioPlaybackState[] = [];
    const unsubscribe = controller.subscribe((state) => {
      states.push(state);
    });

    controller.play(mockApp, "audio/sample.mp3");
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0].isPlaying).toBe(true);
    expect(states[0].audioRef).toBe("audio/sample.mp3");

    controller.stop();
    expect(states[states.length - 1].isPlaying).toBe(false);
    expect(states[states.length - 1].audioRef).toBeNull();

    unsubscribe();
    controller.play(mockApp, "audio/sample.mp3");
    // After unsubscribe, no new states pushed
    const countAfterUnsub = states.length;
    controller.stop();
    expect(states.length).toBe(countAfterUnsub);
  });

  it("automatically synchronizes bound buttons without document.querySelectorAll", () => {
    const btn1 = document.createElement("button");
    const btn2 = document.createElement("button");
    const btnDifferent = document.createElement("button");

    controller.bindButton(btn1, "audio/sample.mp3");
    controller.bindButton(btn2, "audio/sample.mp3");
    controller.bindButton(btnDifferent, "audio/other.mp3");

    expect(btn1.classList.contains("is-audio-playing")).toBe(false);
    expect(btn2.classList.contains("is-audio-playing")).toBe(false);

    controller.play(mockApp, "audio/sample.mp3");

    expect(btn1.classList.contains("is-audio-playing")).toBe(true);
    expect(btn2.classList.contains("is-audio-playing")).toBe(true);
    expect(btnDifferent.classList.contains("is-audio-playing")).toBe(false);

    controller.stop();

    expect(btn1.classList.contains("is-audio-playing")).toBe(false);
    expect(btn2.classList.contains("is-audio-playing")).toBe(false);
  });

  it("immediately activates a button if bound while audio is already playing", () => {
    controller.play(mockApp, "audio/sample.mp3");
    expect(controller.isPlaying()).toBe(true);

    const lateButton = document.createElement("button");
    controller.bindButton(lateButton, "audio/sample.mp3");

    expect(lateButton.classList.contains("is-audio-playing")).toBe(true);
    expect(lateButton.querySelector(".learnkit-sound-wave")).not.toBeNull();

    controller.stop();
    expect(lateButton.classList.contains("is-audio-playing")).toBe(false);
  });

  it("preserves and restores original aria-label", () => {
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "Custom Play Note");

    controller.bindButton(btn, "audio/sample.mp3");
    controller.markButtonActive(btn);

    expect(btn.getAttribute("aria-label")).toBe("Stop playing");
    expect(btn.getAttribute("data-original-label")).toBe("Custom Play Note");

    controller.clearActiveButtons();
    expect(btn.getAttribute("aria-label")).toBe("Custom Play Note");
    expect(btn.hasAttribute("data-original-label")).toBe(false);
  });

  it("delegates module-level exports to the singleton controller seamlessly", () => {
    const states: AudioPlaybackState[] = [];
    const unsub = onAudioPlaybackStateChange((s) => states.push(s));

    const btn = document.createElement("button");
    bindAudioPlayingState(btn, "audio/sample.mp3");

    playVaultAudio(mockApp, "audio/sample.mp3");
    expect(isVaultAudioPlaying()).toBe(true);
    expect(btn.classList.contains("is-audio-playing")).toBe(true);

    stopActiveVaultAudio(true);
    expect(isVaultAudioPlaying()).toBe(false);
    expect(btn.classList.contains("is-audio-playing")).toBe(false);

    unsub();
  });
});
