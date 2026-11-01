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
});
