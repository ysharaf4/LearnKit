// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ForgettingCurveChart } from "../src/views/analytics/charts/forgetting-curve-chart";
import type { CardRecord, CardState, ReviewLogEntry } from "../src/platform/core/store";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Mock resize observer for recharts in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("ForgettingCurveChart", () => {
  const baseNow = new Date("2026-11-02T12:00:00Z").getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  const mockCards: CardRecord[] = [
    {
      id: "card-166363903",
      type: "basic",
      title: "Cell Biology",
      q: "What is photosynthesis?",
      a: "Process converting light into chemical energy",
      sourceNotePath: "Biology/Cell.md",
    },
    {
      id: "card-166175035",
      type: "basic",
      title: "Cell Respiration",
      q: "Where does glycolysis occur?",
      a: "In the cytoplasm",
      sourceNotePath: "Biology/Metabolism.md",
    },
    {
      id: "card-165403032",
      type: "basic",
      title: "Genetics",
      q: "What is a nucleotide composed of?",
      a: "Sugar, phosphate, and nitrogenous base",
      sourceNotePath: "Genetics/DNA.md",
    },
  ];

  const mockStates: Record<string, CardState> = {
    "card-166363903": {
      id: "card-166363903",
      stage: "review",
      due: baseNow + 5 * dayMs,
      reps: 3,
      lapses: 0,
      learningStepIndex: 0,
      scheduledDays: 10,
      stabilityDays: 12,
    },
    "card-166175035": {
      id: "card-166175035",
      stage: "review",
      due: baseNow - 2 * dayMs, // overdue
      reps: 2,
      lapses: 1,
      learningStepIndex: 0,
      scheduledDays: 5,
      stabilityDays: 4,
    },
    "card-165403032": {
      id: "card-165403032",
      stage: "review",
      due: baseNow + 20 * dayMs,
      reps: 5,
      lapses: 0,
      learningStepIndex: 0,
      scheduledDays: 25,
      stabilityDays: 30,
    },
  };

  const mockReviews: ReviewLogEntry[] = [
    {
      id: "card-166363903",
      at: baseNow - 7 * dayMs,
      result: "good",
      durationMs: 4000,
      scheduledDays: 10,
    },
    {
      id: "card-166175035",
      at: baseNow - 6 * dayMs,
      result: "again",
      durationMs: 6000,
      scheduledDays: 5,
    },
    {
      id: "card-165403032",
      at: baseNow - 5 * dayMs,
      result: "easy",
      durationMs: 3000,
      scheduledDays: 25,
    },
  ];

  it("renders empty state when no cards have been reviewed", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ForgettingCurveChart, {
          cards: [],
          states: {},
          reviewLog: [],
          nowMs: baseNow,
          enableAnimations: false,
        })
      );
    });

    expect(container.textContent).toContain("Search for cards to plot forgetting curves.");
    root.unmount();
    container.remove();
  });

  it("auto-selects recently reviewed cards and displays readable question labels", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ForgettingCurveChart, {
          cards: mockCards,
          states: mockStates,
          reviewLog: mockReviews,
          nowMs: baseNow,
          enableAnimations: false,
        })
      );
    });

    // Check that human-readable question snippets appear in the legend
    expect(container.textContent).toContain("What is photosynthesis?");
    expect(container.textContent).toContain("Where does glycolysis");
    expect(container.textContent).toContain("What is a nucleotide");

    // Check that target retention indicator is present
    expect(container.textContent).toContain("Target retention (90%)");

    root.unmount();
    container.remove();
  });

  it("opens filter popover with preset buttons and card list", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ForgettingCurveChart, {
          cards: mockCards,
          states: mockStates,
          reviewLog: mockReviews,
          nowMs: baseNow,
          enableAnimations: false,
        })
      );
    });

    const filterButton = container.querySelector<HTMLButtonElement>("button.learnkit-btn-filter");
    expect(filterButton).not.toBeNull();

    await act(async () => {
      filterButton?.click();
    });

    // Verify presets are rendered
    expect(container.textContent).toContain("Presets");
    expect(container.textContent).toContain("Recent");
    expect(container.textContent).toContain("Hardest");
    expect(container.textContent).toContain("Due Soon");

    // Verify search input and selected cards section are completely removed
    const searchInput = container.querySelector<HTMLInputElement>("input.input");
    expect(searchInput).toBeNull();
    expect(container.textContent).not.toContain("Search cards");
    expect(container.textContent).not.toContain("Selected cards");

    // Verify active preset styling is applied to Recent
    const recentBtn = container.querySelector<HTMLButtonElement>("button.learnkit-btn-pill:first-of-type");
    expect(recentBtn?.classList.contains("is-active")).toBe(true);
    expect(recentBtn?.getAttribute("aria-pressed")).toBe("true");

    root.unmount();
    container.remove();
  });

  it("switches cards when preset buttons are clicked", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ForgettingCurveChart, {
          cards: mockCards,
          states: mockStates,
          reviewLog: mockReviews,
          nowMs: baseNow,
          enableAnimations: false,
        })
      );
    });

    const filterButton = container.querySelector<HTMLButtonElement>("button.learnkit-btn-filter");
    await act(async () => {
      filterButton?.click();
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button.learnkit-btn-pill"));
    const hardestBtn = buttons.find((b) => b.textContent?.includes("Hardest"));
    expect(hardestBtn).toBeDefined();

    await act(async () => {
      hardestBtn?.click();
    });

    // Hardest button is now active
    expect(hardestBtn?.classList.contains("is-active")).toBe(true);

    // Click Reset filters
    const resetBtn = Array.from(container.querySelectorAll<HTMLDivElement>("div")).find((d) => d.textContent === "Reset filters");
    expect(resetBtn).toBeDefined();
    await act(async () => {
      resetBtn?.click();
    });

    // Selections cleared and active preset is null
    expect(hardestBtn?.classList.contains("is-active")).toBe(false);

    // Click Hardest again and close filter to check legend
    await act(async () => {
      hardestBtn?.click();
      filterButton?.click();
    });

    // Legend now displays hardest card
    expect(container.textContent).toContain("Where does glycolysis");

    root.unmount();
    container.remove();
  });

  it("strips markdown formatting like bold asterisks from card titles", async () => {
    const markdownCards: CardRecord[] = [
      {
        id: "card-german-1",
        type: "basic",
        title: "German A1",
        q: "**die Spüle, die Spülen**",
        a: "the sink, the sinks",
        sourceNotePath: "German/Vocab.md",
      },
    ];
    const markdownStates: Record<string, CardState> = {
      "card-german-1": {
        id: "card-german-1",
        stage: "review",
        due: baseNow + dayMs,
        reps: 1,
        lapses: 0,
        learningStepIndex: 0,
        scheduledDays: 1,
        stabilityDays: 2,
      },
    };
    const markdownReviews: ReviewLogEntry[] = [
      {
        id: "card-german-1",
        at: baseNow - dayMs,
        result: "good",
        durationMs: 2000,
        scheduledDays: 1,
      },
    ];

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ForgettingCurveChart, {
          cards: markdownCards,
          states: markdownStates,
          reviewLog: markdownReviews,
          nowMs: baseNow,
          enableAnimations: false,
        })
      );
    });

    // Verify raw asterisks are removed and clean text is rendered
    expect(container.textContent).toContain("die Spüle, die Spülen");
    expect(container.textContent).not.toContain("**die Spüle");

    // Open filter and verify legend is hidden to prevent overlap
    const filterButton = container.querySelector<HTMLButtonElement>("button.learnkit-btn-filter");
    await act(async () => {
      filterButton?.click();
    });

    // When filter is open, legend container content is hidden so it never collides with the popover
    const legendContainer = container.querySelector<HTMLDivElement>(".learnkit-ana-scroll-48");
    expect(legendContainer?.children.length).toBe(0);

    // Close filter and verify legend content reappears
    await act(async () => {
      filterButton?.click();
    });
    expect(legendContainer?.children.length).toBeGreaterThan(0);

    root.unmount();
    container.remove();
  });
});
