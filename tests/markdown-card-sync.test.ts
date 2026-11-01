/**
 * @file tests/markdown-card-sync.test.ts
 * @summary Unit tests for the headless MarkdownCardSync module.
 */

import { describe, it, expect } from "vitest";
import { MarkdownCardSync } from "../src/platform/integrations/sync/markdown-card-sync";

describe("MarkdownCardSync", () => {
  it("inserts anchors for unanchored cards while preserving note structure", () => {
    const markdown = [
      "# Anatomy",
      "",
      "Q | What is the femur? |",
      "A | The thigh bone. |",
      "",
      "## Next Section",
    ].join("\n");

    const result = MarkdownCardSync.syncText(markdown, "Notes/Anatomy.md", {
      syncMode: "simple-safe",
    });

    expect(result.idsInserted).toBe(1);
    expect(result.hadEdits).toBe(true);
    expect(result.updatedText).toMatch(/\^(?:learnkit|sprout)-\d+/);
    expect(result.cards.length).toBe(1);
    expect(result.cards[0].q).toBe("What is the femur?");
  });

  it("converts shorthand cards to canonical table format in full sync mode", () => {
    const markdown = [
      "Mitochondria :: Powerhouse of the cell",
    ].join("\n");

    const result = MarkdownCardSync.syncText(markdown, "Notes/Biology.md", {
      syncMode: "full",
    });

    expect(result.idsInserted).toBe(1);
    expect(result.hadEdits).toBe(true);
    expect(result.updatedText).toContain("Q |");
    expect(result.updatedText).toContain("A |");
    expect(result.cards.length).toBe(1);
    expect(result.cards[0].q).toBe("Mitochondria");
    expect(result.cards[0].a).toBe("Powerhouse of the cell");
  });

  it("removes orphan anchors when their card blocks are deleted", () => {
    const markdown = [
      "# Section",
      "",
      "^learnkit-999999999",
      "",
      "Some notes with no flashcard.",
    ].join("\n");

    const result = MarkdownCardSync.syncText(markdown, "Notes/Clean.md", {
      syncMode: "simple-safe",
    });

    expect(result.anchorsRemoved).toBe(1);
    expect(result.hadEdits).toBe(true);
    expect(result.updatedText).not.toContain("^learnkit-999999999");
  });

  it("preserves list prefixes when inserting anchors", () => {
    const markdown = [
      "- Q | Question in list |",
      "- A | Answer in list |",
    ].join("\n");

    const result = MarkdownCardSync.syncText(markdown, "Notes/List.md", {
      syncMode: "simple-safe",
    });

    expect(result.idsInserted).toBe(1);
    expect(result.updatedText).toMatch(/- \^(?:learnkit|sprout)-\d+/);
  });
});
