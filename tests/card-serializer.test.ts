import { describe, it, expect, beforeEach } from "vitest";
import {
  setDelimiter,
  getDelimiter,
} from "../src/platform/core/delimiter";
import {
  formatDelimitedField,
  pushDelimitedField,
  serializeCard,
  splitComboVariants,
  splitZipVariants,
  COMBO_VARIANT_SEPARATOR,
  COMBO_ZIP_SEPARATOR,
} from "../src/platform/core/card-serializer";

describe("CardSerializer", () => {
  beforeEach(() => {
    setDelimiter("|");
  });

  describe("formatDelimitedField", () => {
    it("formats a single-line field", () => {
      expect(formatDelimitedField("Q", "What is TypeScript?")).toEqual([
        "Q | What is TypeScript? |",
      ]);
    });

    it("formats a multi-line field with closing delimiter on last line", () => {
      const res = formatDelimitedField("A", "Line 1\nLine 2\nLine 3");
      expect(res).toEqual([
        "A | Line 1",
        "Line 2",
        "Line 3 |",
      ]);
    });

    it("puts field header on its own line when first line is a markdown list", () => {
      const res = formatDelimitedField("A", "- Item 1\n- Item 2");
      expect(res).toEqual([
        "A |",
        "- Item 1",
        "- Item 2 |",
      ]);
    });

    it("puts field header on its own line when first line is a code fence", () => {
      const res = formatDelimitedField("Q", "```ts\nconst x = 1;\n```");
      expect(res).toEqual([
        "Q |",
        "```ts",
        "const x = 1;",
        "``` |",
      ]);
    });

    it("preserves display math ($$) with closing delimiter on its own line", () => {
      const res = formatDelimitedField("CQ", "$$\nx^2 + y^2 = z^2\n$$");
      expect(res).toEqual([
        "CQ | $$",
        "x^2 + y^2 = z^2",
        "$$",
        "|",
      ]);
    });

    it("supports passing a custom delimiter", () => {
      expect(formatDelimitedField("Q", "Hello World", "~")).toEqual([
        "Q ~ Hello World ~",
      ]);
    });
  });

  describe("pushDelimitedField", () => {
    it("appends formatted lines to an output array", () => {
      const out: string[] = ["Header"];
      pushDelimitedField(out, "Q", "Question");
      pushDelimitedField(out, "A", "Answer");
      expect(out).toEqual([
        "Header",
        "Q | Question |",
        "A | Answer |",
      ]);
    });
  });

  describe("variant splitting", () => {
    it("splits combo product variants by :: and legacy ||", () => {
      expect(splitComboVariants("Variant A :: Variant B")).toEqual(["Variant A", "Variant B"]);
      expect(splitComboVariants("Variant A || Variant B")).toEqual(["Variant A", "Variant B"]);
      expect(splitComboVariants("Single")).toEqual(["Single"]);
    });

    it("splits combo zip variants by :::", () => {
      expect(splitZipVariants("Zip 1 ::: Zip 2 ::: Zip 3")).toEqual(["Zip 1", "Zip 2", "Zip 3"]);
    });

    it("exposes canonical variant separator constants", () => {
      expect(COMBO_VARIANT_SEPARATOR).toBe(" :: ");
      expect(COMBO_ZIP_SEPARATOR).toBe(" ::: ");
    });
  });

  describe("serializeCard", () => {
    it("serializes a basic card with anchor, title, info, and groups", () => {
      const card = {
        id: "123456789",
        type: "basic" as const,
        title: "Geography",
        q: "What is the capital of France?",
        a: "Paris",
        info: "Capital and most populous city",
        groups: ["world", "capitals"],
      };

      const result = serializeCard(card);
      expect(result).toBe([
        "^learnkit-123456789",
        "T | Geography |",
        "Q | What is the capital of France? |",
        "A | Paris |",
        "I | Capital and most populous city |",
        "G | capitals, world |",
      ].join("\n"));
    });

    it("serializes a reversed card", () => {
      const card = {
        type: "reversed" as const,
        q: "Front side",
        a: "Back side",
      };

      const result = serializeCard(card);
      expect(result).toBe([
        "RQ | Front side |",
        "A | Back side |",
      ].join("\n"));
    });

    it("serializes a cloze card", () => {
      const card = {
        type: "cloze" as const,
        clozeText: "The capital of France is {{c1::Paris}}.",
      };

      const result = serializeCard(card);
      expect(result).toBe("CQ | The capital of France is {{c1::Paris}}. |");
    });

    it("serializes an MCQ card with options and explanations", () => {
      const card = {
        type: "mcq" as const,
        stem: "Which of the following is a prime number?",
        options: [
          { text: "4", isCorrect: false },
          { text: "7", isCorrect: true },
          { text: "9", isCorrect: false },
        ],
        a: "7 is only divisible by 1 and itself",
      };

      const result = serializeCard(card);
      expect(result).toBe([
        "MCQ | Which of the following is a prime number? |",
        "O | 4 |",
        "A | 7 |",
        "O | 9 |",
        "A | 7 is only divisible by 1 and itself |",
      ].join("\n"));
    });

    it("serializes an OQ (ordering) card with numbered steps", () => {
      const card = {
        type: "oq" as const,
        stem: "Order the life cycle of a butterfly:",
        oqSteps: ["Egg", "Caterpillar", "Chrysalis", "Adult"],
      };

      const result = serializeCard(card);
      expect(result).toBe([
        "OQ | Order the life cycle of a butterfly: |",
        "1 | Egg |",
        "2 | Caterpillar |",
        "3 | Chrysalis |",
        "4 | Adult |",
      ].join("\n"));
    });

    it("serializes a combo card in product and zip mode", () => {
      const productCard = {
        type: "combo" as const,
        comboMode: "product" as const,
        qVariants: ["Dog", "Cat"],
        aVariants: ["Bark", "Meow"],
      };
      expect(serializeCard(productCard)).toBe([
        "Q | Dog :: Cat |",
        "A | Bark :: Meow |",
      ].join("\n"));

      const zipCard = {
        type: "combo" as const,
        comboMode: "zip" as const,
        qVariants: ["1", "2"],
        aVariants: ["One", "Two"],
      };
      expect(serializeCard(zipCard)).toBe([
        "Q | 1 ::: 2 |",
        "A | One ::: Two |",
      ].join("\n"));
    });

    it("serializes with a custom delimiter", () => {
      const card = {
        type: "basic" as const,
        q: "Question",
        a: "Answer",
      };
      expect(serializeCard(card, { delimiter: "~" })).toBe([
        "Q ~ Question ~",
        "A ~ Answer ~",
      ].join("\n"));
    });
  });
});
