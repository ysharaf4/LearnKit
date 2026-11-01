/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { renderSessionMode } from "../src/views/reviewer/render-session";
import type { CardRecord } from "../src/platform/types/card";

describe("Reviewer Card Reveal", () => {
  const dummyCard: CardRecord = {
    id: "123456789",
    type: "basic",
    q: "What is the capital of France?",
    a: "Paris",
    sourceNotePath: "Notes/Geography.md",
  };

  it("renders Reveal Answer button when showAnswer is false", () => {
    const container = document.createElement("div");
    let showAnswer = false;
    const setShowAnswer = vi.fn((val: boolean) => {
      showAnswer = val;
    });
    const rerender = vi.fn();

    renderSessionMode({
      container,
      session: {
        scope: { type: "vault", key: "all" },
        queue: [dummyCard],
        index: 0,
        graded: {},
        interrupted: false,
      },
      showAnswer,
      setShowAnswer,
      currentCard: () => dummyCard,
      backToDecks: vi.fn(),
      nextCard: vi.fn(),
      gradeCurrentRating: vi.fn(),
      answerMcq: vi.fn(),
      answerOq: vi.fn(),
      showInfo: false,
      clearTimer: vi.fn(),
      clearCountdown: vi.fn(),
      getNextDueInScope: () => null,
      startCountdown: vi.fn(),
      getClozeRenderOptions: () => ({ mode: "standard" }),
      renderClozeFront: vi.fn(),
      renderMarkdownInto: vi.fn(async (el, md) => {
        el.textContent = md;
      }),
      randomizeMcqOptions: false,
      randomizeOqOrder: false,
      rerender,
      skipCurrentCard: vi.fn(),
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const revealBtn = buttons.find((b) => b.textContent?.includes("Reveal Answer"));
    expect(revealBtn).toBeDefined();

    // Click Reveal Answer
    revealBtn?.click();
    expect(setShowAnswer).toHaveBeenCalledWith(true);
    expect(rerender).toHaveBeenCalled();
  });

  it("renders grading buttons when showAnswer is true", () => {
    const container = document.createElement("div");
    const gradeCurrentRating = vi.fn();

    renderSessionMode({
      container,
      session: {
        scope: { type: "vault", key: "all" },
        queue: [dummyCard],
        index: 0,
        graded: {},
        interrupted: false,
      },
      showAnswer: true,
      setShowAnswer: vi.fn(),
      currentCard: () => dummyCard,
      backToDecks: vi.fn(),
      nextCard: vi.fn(),
      gradeCurrentRating,
      answerMcq: vi.fn(),
      answerOq: vi.fn(),
      showInfo: false,
      clearTimer: vi.fn(),
      clearCountdown: vi.fn(),
      getNextDueInScope: () => null,
      startCountdown: vi.fn(),
      getClozeRenderOptions: () => ({ mode: "standard" }),
      renderClozeFront: vi.fn(),
      renderMarkdownInto: vi.fn(async (el, md) => {
        el.textContent = md;
      }),
      randomizeMcqOptions: false,
      randomizeOqOrder: false,
      rerender: vi.fn(),
      skipCurrentCard: vi.fn(),
    });

    // Should NOT show Reveal Answer button
    const buttons = Array.from(container.querySelectorAll("button"));
    const revealBtn = buttons.find((b) => b.textContent?.includes("Reveal Answer"));
    expect(revealBtn).toBeUndefined();

    // Should render Again, Good, etc.
    const againBtn = container.querySelector(".learnkit-btn-again");
    expect(againBtn).not.toBeNull();

    // The answer text block should be rendered
    const answerBlock = container.querySelector(".learnkit-a");
    expect(answerBlock).not.toBeNull();
  });

  it("renders animated waves on replay button when card is revealed while audio is playing", async () => {
    window.HTMLMediaElement.prototype.play = vi.fn().mockImplementation(() => Promise.resolve());
    window.HTMLMediaElement.prototype.pause = vi.fn();

    const { playVaultAudio, stopActiveVaultAudio } = await import(
      "../src/platform/integrations/audio/audio-player"
    );

    // Mock app vault for playVaultAudio
    const dummyFile = { path: "audio/paris.mp3", extension: "mp3" };
    const mockApp = {
      vault: {
        getAbstractFileByPath: vi.fn().mockReturnValue(dummyFile),
        getResourcePath: vi.fn().mockReturnValue("app://local/audio/paris.mp3"),
      },
      metadataCache: {
        getFirstLinkpathDest: vi.fn().mockReturnValue(dummyFile),
      },
    } as any;

    // Start playing audio
    playVaultAudio(mockApp, "audio/paris.mp3");

    const container = document.createElement("div");
    const audioCard: CardRecord = {
      ...dummyCard,
      audioRef: "audio/paris.mp3",
    };

    renderSessionMode({
      container,
      session: {
        scope: { type: "vault", key: "all" },
        queue: [audioCard],
        index: 0,
        graded: {},
        interrupted: false,
      },
      showAnswer: true, // revealed
      setShowAnswer: vi.fn(),
      currentCard: () => audioCard,
      backToDecks: vi.fn(),
      nextCard: vi.fn(),
      gradeCurrentRating: vi.fn(),
      answerMcq: vi.fn(),
      answerOq: vi.fn(),
      showInfo: false,
      clearTimer: vi.fn(),
      clearCountdown: vi.fn(),
      getNextDueInScope: () => null,
      startCountdown: vi.fn(),
      getClozeRenderOptions: () => ({ mode: "standard" }),
      renderClozeFront: vi.fn(),
      renderMarkdownInto: vi.fn(async (el, md) => {
        el.textContent = md;
      }),
      randomizeMcqOptions: false,
      randomizeOqOrder: false,
      rerender: vi.fn(),
      skipCurrentCard: vi.fn(),
      ttsEnabled: true,
      ttsReplayFront: vi.fn(),
      ttsReplayBack: vi.fn(),
    });

    const replayBtns = container.querySelectorAll<HTMLElement>(".learnkit-tts-replay-btn");
    // Only one speaker icon should be rendered on reveal (no duplicate on Answer)
    expect(replayBtns.length).toBe(1);

    for (const btn of Array.from(replayBtns)) {
      expect(btn.classList.contains("is-audio-playing")).toBe(true);
      expect(btn.classList.contains("is-tts-playing")).toBe(true);
      const wave = btn.querySelector(".learnkit-sound-wave");
      expect(wave).not.toBeNull();
      const bars = btn.querySelectorAll(".learnkit-sound-bar");
      expect(bars.length).toBe(3);
    }

    stopActiveVaultAudio(true);
    for (const btn of Array.from(replayBtns)) {
      expect(btn.classList.contains("is-audio-playing")).toBe(false);
    }
  });
});
