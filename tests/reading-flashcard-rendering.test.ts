/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { buildFlashcardContentHTML } from "../src/views/reading/reading-view";
import type { LearnKitCard } from "../src/views/reading/reading-helpers";

describe("Reading View Flashcard Rendering & Structure", () => {
  it("renders integrated header with Question/Answer badge on front and back", () => {
    const card: LearnKitCard = {
      anchorId: "test-card-1",
      type: "basic",
      fields: { Q: "Capital of France?", A: "Paris" },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: false,
      includeEditButton: true,
    });

    expect(html).toContain("learnkit-flashcard-header");
    expect(html).toContain("learnkit-flashcard-badge");
    expect(html).toContain("Question");
    expect(html).toContain("Answer");
    expect(html).toContain("learnkit-flashcard-badge-icon");
  });

  it("renders MCQ options as styled option chips with letter badges", () => {
    const card: LearnKitCard = {
      anchorId: "test-mcq-1",
      type: "mcq",
      fields: {
        MCQ: "Select the prime number:",
        O: ["4", "6", "8"],
        A: "7",
      },
    };

    const html = buildFlashcardContentHTML(card, {
      includeSpeakerButton: false,
      includeEditButton: false,
    });

    expect(html).toContain("learnkit-flashcard-option-chip");
    expect(html).toContain("learnkit-option-badge");
    expect(html).toContain("learnkit-option-correct");
  });
});
