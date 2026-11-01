/**
 * @file tests/anki-package.test.ts
 * @summary Unit and round-trip integration tests for the deep AnkiPackage module.
 */

import { describe, it, expect, vi } from "vitest";

// Override setup-vitest.ts's empty-Uint8Array mock with the real deflated binary for real WASM execution
vi.mock("sql.js/dist/sql-wasm.wasm", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const zlib = await import("node:zlib");
  const raw = new Uint8Array(
    fs.readFileSync(path.resolve(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm")),
  );
  return {
    default: new Uint8Array(zlib.deflateSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION })),
  };
});

import { AnkiPackage } from "../src/platform/integrations/anki/anki-package";
import type { CardRecord } from "../src/platform/types/card";
import type { CardState } from "../src/platform/types/scheduler";
import type { ReviewLogEntry } from "../src/platform/types/review";

describe("AnkiPackage Deep Domain Module", () => {
  const sampleCards: CardRecord[] = [
    {
      id: "note-1#card-1",
      type: "basic",
      prompt: "What is photosynthesis?",
      answer: "The process by which plants convert sunlight into chemical energy.",
      info: "Occurs in chloroplasts.",
      sourceNotePath: "Biology/Plants.md",
      groups: ["Biology/Botany"],
      tags: ["science", "bio"],
    },
    {
      id: "note-1#card-2",
      type: "cloze",
      prompt: "Water boils at {{c1::100}} degrees Celsius at {{c2::1 atm}} pressure.",
      answer: "",
      sourceNotePath: "Chemistry/Thermodynamics.md",
      groups: ["Chemistry"],
    },
  ];

  const sampleStates: Record<string, CardState> = {
    "note-1#card-1": {
      id: "note-1#card-1",
      stage: "review",
      reps: 4,
      lapses: 0,
      due: 1750000000000,
      scheduledDays: 15,
      learningStepIndex: 0,
      fsrsState: 2,
    },
    "note-1#card-2": {
      id: "note-1#card-2",
      stage: "learning",
      reps: 1,
      lapses: 0,
      due: 1740000000000,
      scheduledDays: 1,
      learningStepIndex: 1,
      fsrsState: 1,
    },
  };

  const sampleRevlogs: ReviewLogEntry[] = [
    {
      id: "note-1#card-1",
      at: 1730000000000,
      result: "good",
      prevDue: 1720000000000,
      nextDue: 1750000000000,
      meta: null,
    },
  ];

  it("creates a package, serializes to bytes, and verifies creation stats", async () => {
    const pkg = await AnkiPackage.create({
      cards: sampleCards,
      states: sampleStates,
      revlogs: sampleRevlogs,
      defaultDeckName: "DefaultDeck",
      includeScheduling: true,
      includeRevlog: true,
    });

    const stats = pkg.stats;
    expect(stats).toBeDefined();
    expect(stats?.notesExported).toBe(2);
    expect(stats?.cardsExported).toBeGreaterThanOrEqual(2);
    expect(stats?.revlogEntries).toBe(1);

    const bytes = pkg.toBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(100);
  });

  it("reads back created bytes and provides accurate preview metadata", async () => {
    const createdPkg = await AnkiPackage.create({
      cards: sampleCards,
      states: sampleStates,
      defaultDeckName: "Science",
    });

    const bytes = createdPkg.toBytes();
    const loadedPkg = await AnkiPackage.read(bytes);

    const preview = loadedPkg.preview();
    expect(preview.noteCount).toBe(2);
    expect(preview.cardCount).toBeGreaterThanOrEqual(2);
    expect(preview.decks.length).toBeGreaterThan(0);
    expect(preview.unknownModels.length).toBe(0);
  });

  it("extracts markdown card blocks and scheduling states in memory", async () => {
    const createdPkg = await AnkiPackage.create({
      cards: sampleCards,
      states: sampleStates,
      defaultDeckName: "Science",
      includeScheduling: true,
    });

    const bytes = createdPkg.toBytes();
    const loadedPkg = await AnkiPackage.read(bytes);

    const extracted = loadedPkg.extract({
      targetFolder: "ImportedDecks",
      importScheduling: true,
    });

    expect(extracted.imported).toBe(2);
    expect(extracted.decks.length).toBeGreaterThan(0);

    const allMarkdown = extracted.decks.map((d) => d.markdownContent).join("\n");
    expect(allMarkdown).toContain("photosynthesis");
    expect(allMarkdown).toContain("The process by which plants");
    expect(allMarkdown).toContain("{{c1::100}}");

    // Scheduling state preserved
    expect(Object.keys(extracted.decks[0].cardStates).length).toBeGreaterThan(0);
  });

  it("round-trips media references and binary content", async () => {
    const mediaImage = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]); // PNG header bytes
    const mediaMap = new Map<string, Uint8Array>();
    mediaMap.set("cell-diagram.png", mediaImage);

    const cardWithMedia: CardRecord = {
      id: "media-card-1",
      type: "basic",
      prompt: "Identify the structure: ![[cell-diagram.png]]",
      answer: "Mitochondria",
      sourceNotePath: "Bio/Cells.md",
    };

    const createdPkg = await AnkiPackage.create({
      cards: [cardWithMedia],
      media: mediaMap,
      includeMedia: true,
    });

    expect(createdPkg.stats?.mediaFiles).toBe(1);

    const bytes = createdPkg.toBytes();
    const loadedPkg = await AnkiPackage.read(bytes);

    const preview = loadedPkg.preview();
    expect(preview.hasMedia).toBe(true);
    expect(preview.mediaCount).toBe(1);

    const extracted = loadedPkg.extract({ targetFolder: "Cards" });
    expect(extracted.media.has("cell-diagram.png")).toBe(true);
    expect(extracted.media.get("cell-diagram.png")?.length).toBe(mediaImage.length);

    const md = extracted.decks[0].markdownContent;
    expect(md).toContain("![[Cards/Attachments/cell-diagram.png]]");
  });
});
