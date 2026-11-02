// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CardReviewPresenter } from "../src/views/reviewer/card-review-presenter";
import { StudySession } from "../src/engine/study-session/study-session";
import type { CardRecord } from "../src/platform/types/card";
import type { IStore } from "../src/platform/core/store-interface";
import type { CardState } from "../src/platform/types/scheduler";

describe("CardReviewPresenter", () => {
  let container: HTMLElement;
  let mockStore: IStore;
  let dummyCards: CardRecord[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    dummyCards = [
      {
        id: "card-1",
        type: "basic",
        q: "What is the capital of Japan?",
        a: "Tokyo",
        sourceNotePath: "Notes/Geography.md",
      },
      {
        id: "card-2",
        type: "basic",
        q: "What is the powerhouse of the cell?",
        a: "Mitochondria",
        sourceNotePath: "Notes/Biology.md",
      },
    ];

    const defaultState: CardState = {
      cardId: "card-1",
      state: 0,
      due: Date.now(),
      stability: 1,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      lastReview: Date.now(),
    };

    mockStore = {
      data: {
        cards: dummyCards,
        states: {},
        reviewLog: [],
        analytics: { events: [] },
      },
      getAllCards: vi.fn(() => dummyCards),
      getCardsByNote: vi.fn(() => dummyCards),
      getState: vi.fn((id: string) => ({ ...defaultState, cardId: id })),
      ensureState: vi.fn((id: string) => ({ ...defaultState, cardId: id })),
      upsertState: vi.fn(),
      appendReviewLog: vi.fn(),
      appendAnalyticsReview: vi.fn(),
      persist: vi.fn(async () => {}),
    } as unknown as IStore;
  });

  it("mounts and renders the question front with Reveal Answer button", () => {
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
    });
    presenter.mount();

    expect(presenter.isAnswerRevealed).toBe(false);
    expect(presenter.currentCard?.id).toBe("card-1");

    const revealBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Reveal Answer"),
    );
    expect(revealBtn).toBeDefined();

    const qEl = container.querySelector(".learnkit-q");
    expect(qEl?.textContent).toContain("What is the capital of Japan?");
    const aEl = container.querySelector(".learnkit-a");
    expect(aEl).toBeNull();

    presenter.destroy();
  });

  it("reveals answer when revealAnswer() is called or reveal button clicked", () => {
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
    });
    presenter.mount();

    presenter.revealAnswer();
    expect(presenter.isAnswerRevealed).toBe(true);

    const aEl = container.querySelector(".learnkit-a");
    expect(aEl?.textContent).toContain("Tokyo");

    // Reveal button should be replaced by grading buttons
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    const againBtn = buttons.find((b) => b.textContent?.includes("Again"));
    const goodBtn = buttons.find((b) => b.textContent?.includes("Good"));
    expect(againBtn).toBeDefined();
    expect(goodBtn).toBeDefined();

    presenter.destroy();
  });

  it("advances to next card when rating is submitted", async () => {
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
    });
    presenter.mount();
    presenter.revealAnswer();

    await presenter.gradeCurrentRating("good");

    expect(presenter.currentCard?.id).toBe("card-2");
    expect(presenter.isAnswerRevealed).toBe(false);

    const qEl = container.querySelector(".learnkit-q");
    expect(qEl?.textContent).toContain("What is the powerhouse of the cell?");

    presenter.destroy();
  });

  it("handles keyboard events for reveal and rating", async () => {
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
    });
    presenter.mount();

    // Space reveals answer
    const spaceEv = new KeyboardEvent("keydown", { key: " " });
    const handledReveal = presenter.handleKeyDown(spaceEv);
    expect(handledReveal).toBe(true);
    expect(presenter.isAnswerRevealed).toBe(true);

    // Key '2' grades good
    const key2Ev = new KeyboardEvent("keydown", { key: "2" });
    const handledGrade = presenter.handleKeyDown(key2Ev);
    expect(handledGrade).toBe(true);

    presenter.destroy();
  });

  it("triggers onComplete when queue is exhausted", async () => {
    const onComplete = vi.fn();
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: [dummyCards[0]],
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
      onComplete,
    });
    presenter.mount();
    presenter.revealAnswer();

    await presenter.gradeCurrentRating("good");

    expect(onComplete).toHaveBeenCalled();
    expect(presenter.currentCard).toBeNull();

    presenter.destroy();
  });

  it("supports burying, suspending, and skipping current card", async () => {
    const cards: CardRecord[] = [
      ...dummyCards,
      {
        id: "card-3",
        type: "basic",
        q: "What is the speed of light?",
        a: "299,792,458 m/s",
        sourceNotePath: "Notes/Physics.md",
      },
    ];

    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
    });
    presenter.mount();

    expect(presenter.currentCard?.id).toBe("card-1");
    await presenter.buryCurrentCard();

    // Now on card-2
    expect(presenter.currentCard?.id).toBe("card-2");

    // Skip card-2: it moves to back, card-3 becomes current
    presenter.skipCurrentCard();
    expect(presenter.currentCard?.id).toBe("card-3");

    // Suspend card-3: card-2 is now current
    await presenter.suspendCurrentCard();
    expect(presenter.currentCard?.id).toBe("card-2");

    // Bury card-2: queue is now empty
    await presenter.buryCurrentCard();
    expect(presenter.currentCard).toBeNull();

    presenter.destroy();
  });
});
