import { describe, it, expect } from "vitest";
import {
  BASIC_SHORTHAND_RE,
  REVERSED_SHORTHAND_RE,
  CLOZE_SHORTHAND_RE,
  SR_MULTILINE_BASIC_SEP_RE,
  SR_MULTILINE_REVERSED_SEP_RE,
  SR_CLOZE_DELETION_RE,
  isMarkdownHeading,
  convertSrClozeToShorthand,
  mergeSrMultilineBlocks,
  preprocessSrText,
} from "../src/platform/core/shorthand-preprocessor";

describe("ShorthandPreprocessor", () => {
  describe("regex patterns", () => {
    it("matches basic shorthand (::) and rejects reversed (:::)", () => {
      expect(BASIC_SHORTHAND_RE.test("Question::Answer")).toBe(true);
      expect(BASIC_SHORTHAND_RE.test("Question:::Answer")).toBe(false);
      expect(BASIC_SHORTHAND_RE.test("Not a shorthand line")).toBe(false);

      const match = "What is 2+2?::4".match(BASIC_SHORTHAND_RE);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("What is 2+2?");
      expect(match![2]).toBe("4");
    });

    it("matches reversed shorthand (:::)", () => {
      expect(REVERSED_SHORTHAND_RE.test("Front:::Back")).toBe(true);
      expect(REVERSED_SHORTHAND_RE.test("Front::Back")).toBe(false);

      const match = "Apple:::Fruit".match(REVERSED_SHORTHAND_RE);
      expect(match).not.toBeNull();
      expect(match![1]).toBe("Apple");
      expect(match![2]).toBe("Fruit");
    });

    it("matches cloze shorthand (cloze::, cq::, CQ::) case-insensitively", () => {
      expect(CLOZE_SHORTHAND_RE.test("cloze::The capital is {{Paris}}")).toBe(true);
      expect(CLOZE_SHORTHAND_RE.test("cq::The capital is {{Paris}}")).toBe(true);
      expect(CLOZE_SHORTHAND_RE.test("CQ::The capital is {{Paris}}")).toBe(true);
      expect(CLOZE_SHORTHAND_RE.test("cloze:::invalid triple colon")).toBe(false);
    });

    it("identifies Markdown headings accurately", () => {
      expect(isMarkdownHeading("# Heading 1")).toBe(true);
      expect(isMarkdownHeading("## Heading 2")).toBe(true);
      expect(isMarkdownHeading("###### Heading 6")).toBe(true);
      expect(isMarkdownHeading("#NotAHeading")).toBe(false);
      expect(isMarkdownHeading("Just plain text")).toBe(false);
    });

    it("matches standalone ? and ?? separators", () => {
      expect(SR_MULTILINE_BASIC_SEP_RE.test("?")).toBe(true);
      expect(SR_MULTILINE_BASIC_SEP_RE.test("? ")).toBe(false);
      expect(SR_MULTILINE_REVERSED_SEP_RE.test("??")).toBe(true);
      expect(SR_MULTILINE_REVERSED_SEP_RE.test("???")).toBe(false);
    });
  });

  describe("convertSrClozeToShorthand", () => {
    it("returns null if no SR cloze syntax is present", () => {
      expect(convertSrClozeToShorthand("Plain line with no clozes")).toBeNull();
    });

    it("converts simple unnumbered clozes to sequential c1, c2", () => {
      const line = "The ==capital== of ==France== is Paris";
      const converted = convertSrClozeToShorthand(line);
      expect(converted).toBe("cloze::The {{c1::capital}} of {{c2::France}} is Paris");
    });

    it("converts clozes with hints", () => {
      const line = "The capital of France is ==Paris==^[city]";
      const converted = convertSrClozeToShorthand(line);
      expect(converted).toBe("cloze::The capital of France is {{c1::Paris::city}}");
    });

    it("groups clozes sharing the same [^N] sequence number", () => {
      const line = "==Canberra==[^1] is the capital of ==Australia==[^2], not ==Sydney==[^1]";
      const converted = convertSrClozeToShorthand(line);
      expect(converted).toBe("cloze::{{c1::Canberra}} is the capital of {{c2::Australia}}, not {{c1::Sydney}}");
    });

    it("combines hints and group numbers", () => {
      const line = "==Paris==^[city][^1] and ==France==^[country][^1]";
      const converted = convertSrClozeToShorthand(line);
      expect(converted).toBe("cloze::{{c1::Paris::city}} and {{c1::France::country}}");
    });
  });

  describe("mergeSrMultilineBlocks", () => {
    it("merges basic multi-line block (? separator)", () => {
      const lines = [
        "What is the capital",
        "of France?",
        "?",
        "Paris,",
        "in Europe",
      ];
      const fenceMask = new Array(lines.length).fill(false);
      const isHeaderLine = () => false;

      const merged = mergeSrMultilineBlocks(lines, fenceMask, isHeaderLine);
      expect(merged).toEqual([
        "What is the capital of France?::Paris, in Europe",
      ]);
    });

    it("merges reversed multi-line block (?? separator)", () => {
      const lines = [
        "Term",
        "??",
        "Definition",
      ];
      const fenceMask = new Array(lines.length).fill(false);
      const isHeaderLine = () => false;

      const merged = mergeSrMultilineBlocks(lines, fenceMask, isHeaderLine);
      expect(merged).toEqual([
        "Term:::Definition",
      ]);
    });

    it("does not merge inside code fences", () => {
      const lines = [
        "```",
        "Question",
        "?",
        "Answer",
        "```",
      ];
      const fenceMask = [true, true, true, true, true];
      const isHeaderLine = () => false;

      const merged = mergeSrMultilineBlocks(lines, fenceMask, isHeaderLine);
      expect(merged).toEqual(lines);
    });

    it("stops collecting questions at headers or blank lines", () => {
      const lines = [
        "## Header",
        "Actual Question",
        "?",
        "Answer",
      ];
      const fenceMask = new Array(lines.length).fill(false);
      const isHeaderLine = (l: string) => l.startsWith("##");

      const merged = mergeSrMultilineBlocks(lines, fenceMask, isHeaderLine);
      expect(merged).toEqual([
        "## Header",
        "Actual Question::Answer",
      ]);
    });
  });

  describe("preprocessSrText", () => {
    it("returns unchanged text if no SR blocks exist", () => {
      const text = "Q | Question |\nA | Answer |";
      expect(preprocessSrText(text, true, isMarkdownHeading)).toBe(text);
    });

    it("transforms text with SR multiline blocks", () => {
      const text = "Question\n?\nAnswer\n\nOther text";
      const processed = preprocessSrText(text, true, isMarkdownHeading);
      expect(processed).toBe("Question::Answer\n\nOther text");
    });
  });
});
