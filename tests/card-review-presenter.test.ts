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

    // Enter must NOT reveal answer
    const enterEv = new KeyboardEvent("keydown", { key: "Enter" });
    const handledEnter = presenter.handleKeyDown(enterEv);
    expect(handledEnter).toBe(false);
    expect(presenter.isAnswerRevealed).toBe(false);

    // Number keys must NOT reveal answer
    for (const key of ["1", "2", "3", "4"]) {
      const numEv = new KeyboardEvent("keydown", { key });
      expect(presenter.handleKeyDown(numEv)).toBe(false);
      expect(presenter.isAnswerRevealed).toBe(false);
    }

    // Enter inside a textarea must NOT reveal answer
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    const textareaEnterEv = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(textareaEnterEv, "target", { value: textarea, writable: false });
    expect(presenter.handleKeyDown(textareaEnterEv)).toBe(false);
    expect(presenter.isAnswerRevealed).toBe(false);

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

  it("renders live FSRS schedule interval previews and tooltips on rating buttons when showGradeIntervals is enabled", () => {
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
      showGradeIntervals: true,
      schedulingSettings: {
        algorithm: "fsrs",
        fsrs: {
          requestRetention: 0.9,
          maximumInterval: 36500,
          w: [0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18, 0.05, 0.34, 1.26, 0.29, 2.61],
          enableFuzz: false,
        },
        sm2: {
          startingEase: 2.5,
          easyBonus: 1.3,
          intervalModifier: 1.0,
          hardIntervalFactor: 1.2,
          minimumInterval: 1,
          maximumInterval: 36500,
        },
      },
      getCardStateForPreview: (id, now) => mockStore.ensureState(id, now),
      fourButtonMode: true,
    });
    presenter.mount();

    // Reveal the answer to show rating buttons
    presenter.revealAnswer();

    const againBtn = container.querySelector(".learnkit-btn-again") as HTMLButtonElement;
    const hardBtn = container.querySelector(".learnkit-btn-hard") as HTMLButtonElement;
    const goodBtn = container.querySelector(".learnkit-btn-good") as HTMLButtonElement;
    const easyBtn = container.querySelector(".learnkit-btn-easy") as HTMLButtonElement;

    expect(againBtn).not.toBeNull();
    expect(hardBtn).not.toBeNull();
    expect(goodBtn).not.toBeNull();
    expect(easyBtn).not.toBeNull();

    // Check subtitle presence and contents
    const againSub = againBtn.querySelector(".learnkit-btn-subtitle");
    const hardSub = hardBtn.querySelector(".learnkit-btn-subtitle");
    const goodSub = goodBtn.querySelector(".learnkit-btn-subtitle");
    const easySub = easyBtn.querySelector(".learnkit-btn-subtitle");

    expect(againSub).not.toBeNull();
    expect(hardSub).not.toBeNull();
    expect(goodSub).not.toBeNull();
    expect(easySub).not.toBeNull();

    expect(againSub?.textContent).toBeTruthy();
    expect(goodSub?.textContent).toBeTruthy();

    // Verify accessible tooltips explaining grading criteria
    expect(againBtn.title).toBe("Not recalled easily (1)");
    expect(hardBtn.title).toBe("Recalled with difficulty (2)");
    expect(goodBtn.title).toBe("Recalled with effort (3)");
    expect(easyBtn.title).toBe("Recalled easily (4)");

    presenter.destroy();
  });

  it("distills session chrome: places Decks, Edit Card, and More Menu in topbar, reserving study dock for active recall", async () => {
    const onBackToDecks = vi.fn();
    const onEditCard = vi.fn();
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: dummyCards,
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
      onBackToDecks,
      onEditCard,
      enableSkipButton: true,
    });
    presenter.mount();

    const topbar = container.querySelector("header.learnkit-session-topbar");
    expect(topbar).not.toBeNull();

    // 1. Topbar holds back navigation ("Decks"), edit card, and more menu
    const backBtn = topbar?.querySelector(".learnkit-btn-back") as HTMLButtonElement;
    expect(backBtn).not.toBeNull();
    expect(backBtn.textContent).toContain("Decks");
    expect(backBtn.textContent).toContain("Q");
    backBtn.click();
    expect(onBackToDecks).toHaveBeenCalledOnce();

    const editBtn = topbar?.querySelector(".lk-review-edit-icon-btn") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    expect(editBtn.getAttribute("aria-label")).toBeTruthy();
    editBtn.click();
    expect(onEditCard).toHaveBeenCalledWith(dummyCards[0]);

    const moreTrigger = topbar?.querySelector("[data-bc-action='reviewer-more-trigger']") as HTMLButtonElement;
    expect(moreTrigger).not.toBeNull();

    // 2. Footer dock is strictly active recall (Reveal Answer on front, no Decks or Edit Card)
    const dock = container.querySelector("footer.learnkit-session-study-dock");
    expect(dock).not.toBeNull();
    expect(dock?.querySelector(".learnkit-btn-back")).toBeNull();
    expect(dock?.querySelector(".lk-review-edit-icon-btn")).toBeNull();
    expect(dock?.querySelector("[data-bc-action='reviewer-more-trigger']")).toBeNull();

    // Reveal button is centered in dock on front
    const revealBtn = dock?.querySelector(".learnkit-reveal-btn");
    expect(revealBtn).not.toBeNull();

    // Ghost skip button is present on the right
    const skipBtn = dock?.querySelector(".learnkit-btn-dock-skip") as HTMLButtonElement;
    expect(skipBtn).not.toBeNull();
    expect(skipBtn.textContent).toContain("Skip");

    // 3. Reveal answer: dock switches to rating group
    presenter.revealAnswer();
    const activeDock = container.querySelector("footer.learnkit-session-study-dock");
    expect(activeDock?.querySelector(".learnkit-reveal-btn")).toBeNull();
    expect(activeDock?.querySelector(".learnkit-session-study-dock-grade-group")).not.toBeNull();

    // 4. Submit rating, then verify Undo appears on next card
    await presenter.gradeCurrentRating("good");
    expect(session.canUndo).toBe(true);

    const undoBtn = container.querySelector("footer.learnkit-session-study-dock .learnkit-btn-dock-undo") as HTMLButtonElement;
    expect(undoBtn).not.toBeNull();
    expect(undoBtn.textContent).toContain("Undo");

    presenter.destroy();
  });

  it("renders celebratory Session Summary Glass Card when review queue completes", async () => {
    const onStartPractice = vi.fn();
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: [dummyCards[0]],
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
      onStartPractice,
    });
    presenter.mount();

    // Review the single card
    presenter.revealAnswer();
    await presenter.gradeCurrentRating("good");

    // Queue exhausted -> renders completion state
    const summary = container.querySelector(".learnkit-session-summary-wrap");
    expect(summary).not.toBeNull();

    // Headline confirms session complete
    const headline = container.querySelector(".learnkit-session-summary-headline");
    expect(headline?.textContent).toBe("Session Complete!");

    // Metric tiles grid
    const tiles = container.querySelectorAll(".learnkit-session-summary-tile");
    expect(tiles.length).toBe(3);

    const values = Array.from(tiles).map((t) => t.querySelector(".learnkit-session-summary-tile-val")?.textContent);
    expect(values[0]).toBe("1"); // 1 card reviewed
    expect(values[1]).toBe("100%"); // 100% retention ("good")

    // Dock has Return to Decks and Practice More
    const dock = container.querySelector("footer.learnkit-session-study-dock");
    expect(dock?.textContent).toContain("Return to Decks");
    expect(dock?.textContent).toContain("Practice More");

    // Pressing 'P' triggers practice
    const pEv = new KeyboardEvent("keydown", { key: "p" });
    presenter.handleKeyDown(pEv);
    expect(onStartPractice).toHaveBeenCalledOnce();

    presenter.destroy();
  });

  it("renders serene all caught up empty state when deck has no due cards initially", () => {
    const onStartPractice = vi.fn();
    const session = StudySession.start({
      scope: { type: "vault", key: "all", name: "Vault" },
      store: mockStore,
      cards: [],
    });

    const presenter = new CardReviewPresenter({
      container,
      session,
      onStartPractice,
    });
    presenter.mount();

    const summary = container.querySelector(".learnkit-session-summary-wrap");
    expect(summary).not.toBeNull();

    const headline = container.querySelector(".learnkit-session-summary-headline");
    expect(headline?.textContent).toBe("All Caught Up!");

    const dock = container.querySelector("footer.learnkit-session-study-dock");
    expect(dock?.textContent).toContain("Return to Decks");
    expect(dock?.textContent).toContain("Start Practice");

    presenter.destroy();
  });
});
