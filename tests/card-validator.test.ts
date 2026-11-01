import { describe, it, expect } from "vitest";
import {
  validateAndNormalizeCard,
  createEmptyParsedCard,
  parseGroups,
  normaliseMultiline,
} from "../src/engine/parser/card-validator";
import type { ParsedCard } from "../src/engine/parser/card-validator";

function makeCard(type: ParsedCard["type"], overrides?: Partial<ParsedCard>): ParsedCard {
  return {
    ...createEmptyParsedCard("note.md", 1, type),
    ...overrides,
  };
}

describe("CardValidator", () => {
  describe("normaliseMultiline", () => {
    it("trims trailing spaces per line and outer whitespace", () => {
      expect(normaliseMultiline("  line 1   \n  line 2   \n")).toBe("line 1\n  line 2");
      expect(normaliseMultiline(null)).toBeNull();
      expect(normaliseMultiline("")).toBe("");
    });
  });

  describe("parseGroups", () => {
    it("splits groups by comma and delimiter, normalizing and sorting them", () => {
      expect(parseGroups("science, biology | nature")).toEqual(["biology", "nature", "science"]);
      expect(parseGroups("")).toBeNull();
      expect(parseGroups(null)).toBeNull();
    });
  });

  describe("basic card validation & combo auto-detection", () => {
    it("validates a standard basic card", () => {
      const card = makeCard("basic", { q: "Question", a: "Answer" });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
      expect(card.comboMode).toBeNull();
    });

    it("errors when Q or A is missing", () => {
      const card = makeCard("basic", { q: null, a: null });
      validateAndNormalizeCard(card);
      expect(card.errors).toContain("Missing Q:");
      expect(card.errors).toContain("Missing A:");
    });

    it("auto-detects Cartesian product combo cards (:: inside fields)", () => {
      const card = makeCard("basic", {
        q: "France :: Spain",
        a: "Paris :: Madrid",
      });
      validateAndNormalizeCard(card);
      expect(card.comboMode).toBe("product");
      expect(card.qVariants).toEqual(["France", "Spain"]);
      expect(card.aVariants).toEqual(["Paris", "Madrid"]);
      expect(card.errors).toHaveLength(0);
    });

    it("auto-detects zip combo cards (::: inside fields)", () => {
      const card = makeCard("basic", {
        q: "France ::: Spain",
        a: "Paris ::: Madrid",
      });
      validateAndNormalizeCard(card);
      expect(card.comboMode).toBe("zip");
      expect(card.qVariants).toEqual(["France", "Spain"]);
      expect(card.aVariants).toEqual(["Paris", "Madrid"]);
      expect(card.errors).toHaveLength(0);
    });

    it("errors when zip combo has mismatched variant counts", () => {
      const card = makeCard("basic", {
        q: "France ::: Spain ::: Italy",
        a: "Paris ::: Madrid",
      });
      validateAndNormalizeCard(card);
      expect(card.errors.some((e) => e.includes("mismatched variant counts"))).toBe(true);
    });
  });

  describe("reversed card validation", () => {
    it("validates a standard reversed card", () => {
      const card = makeCard("reversed", { q: "Front", a: "Back" });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
    });

    it("errors when Q or A is missing", () => {
      const card = makeCard("reversed");
      validateAndNormalizeCard(card);
      expect(card.errors).toContain("Missing Q:");
      expect(card.errors).toContain("Missing A:");
    });
  });

  describe("MCQ card validation", () => {
    it("validates a well-formed MCQ and orders correct options first", () => {
      const card = makeCard("mcq", {
        stem: "What is 2+2?",
        options: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
          { text: "5", isCorrect: false },
        ],
      });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
      expect(card.correctIndex).toBe(0);
      expect(card.options).toEqual([
        { text: "4", isCorrect: true },
        { text: "3", isCorrect: false },
        { text: "5", isCorrect: false },
      ]);
      expect(card.a).toBe("4");
    });

    it("errors when stem, correct option, or wrong option is missing", () => {
      const card = makeCard("mcq", { stem: null, options: [] });
      validateAndNormalizeCard(card);
      expect(card.errors).toContain("Missing MCQ:");
      expect(card.errors).toContain("MCQ requires at least one A | correct answer | line.");
      expect(card.errors).toContain("MCQ requires at least one O | wrong option | line.");
    });
  });

  describe("cloze card validation", () => {
    it("validates a valid cloze card", () => {
      const card = makeCard("cloze", { clozeText: "The capital of France is {{c1::Paris}}." });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
    });

    it("errors on missing cloze text or missing cloze tokens", () => {
      const card = makeCard("cloze", { clozeText: null });
      validateAndNormalizeCard(card);
      expect(card.errors).toContain("Missing CQ:");
    });
  });

  describe("IO card validation", () => {
    it("validates a valid IO card with image embed and valid occlusions JSON", () => {
      const card = makeCard("io", {
        ioSrc: "IO | ![[diagram.png]] |",
        ioOcclusionsRaw: JSON.stringify([{ id: 1, x: 10, y: 10 }]),
        maskMode: "solo",
      });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
      expect(card.occlusions).toHaveLength(1);
    });

    it("errors when image embed is missing or occlusions JSON is invalid", () => {
      const card = makeCard("io", {
        ioSrc: "just plain text without embed",
        ioOcclusionsRaw: "{ not valid json array }",
        maskMode: "invalid" as any,
      });
      validateAndNormalizeCard(card);
      expect(card.errors.some((e) => e.includes("embedded image"))).toBe(true);
      expect(card.errors.some((e) => e.includes("occlusions JSON is invalid"))).toBe(true);
      expect(card.errors).toContain('IO mask mode must be "solo" or "all".');
    });
  });

  describe("HQ card validation", () => {
    it("validates a valid HQ card", () => {
      const card = makeCard("hq", {
        hqSrc: "HQ | ![[map.png]] |",
        hqRegionsRaw: JSON.stringify([{ id: 1, label: "Region" }]),
        interactionMode: "click",
      });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
      expect(card.hqRegions).toHaveLength(1);
    });

    it("errors when image embed or interaction mode is invalid", () => {
      const card = makeCard("hq", {
        hqSrc: "No image",
        interactionMode: "swipe" as any,
      });
      validateAndNormalizeCard(card);
      expect(card.errors.some((e) => e.includes("HQ card requires an embedded image"))).toBe(true);
      expect(card.errors).toContain('HQ interaction mode must be "click" or "drag-drop".');
    });
  });

  describe("OQ (ordering) card validation", () => {
    it("validates a valid OQ card with steps", () => {
      const card = makeCard("oq", {
        q: "Order steps:",
        oqSteps: [" Step 1 ", " Step 2 ", " Step 3 "],
      });
      validateAndNormalizeCard(card);
      expect(card.errors).toHaveLength(0);
      expect(card.oqSteps).toEqual(["Step 1", "Step 2", "Step 3"]);
    });

    it("errors when question is missing or has fewer than 2 steps", () => {
      const card = makeCard("oq", {
        q: null,
        oqSteps: ["Only one step"],
      });
      validateAndNormalizeCard(card);
      expect(card.errors).toContain("Missing OQ question.");
      expect(card.errors).toContain("OQ requires at least 2 numbered steps (1 | ... |, 2 | ... |).");
    });
  });

  describe("pending ID and title attachment", () => {
    it("attaches pending title and ID when missing on card", () => {
      const card = makeCard("basic", {
        q: "Question",
        a: "Answer",
      });
      validateAndNormalizeCard(card, {
        pendingId: "123456789",
        pendingTitle: "Chapter 1",
      });
      expect(card.id).toBe("123456789");
      expect(card.title).toBe("Chapter 1");
    });
  });
});
