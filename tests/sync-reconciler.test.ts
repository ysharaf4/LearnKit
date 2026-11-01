/**
 * @file tests/sync-reconciler.test.ts
 * @summary Unit tests for the SyncReconciler domain module.
 */

import { describe, it, expect } from "vitest";
import { SyncReconciler } from "../src/platform/integrations/sync/sync-reconciler";
import type { CardRecord } from "../src/platform/types/card";
import type { CardState } from "../src/platform/types/scheduler";

describe("SyncReconciler", () => {
  it("detects added, updated, and unchanged cards accurately", () => {
    const existingCards: Record<string, CardRecord> = {
      "card-1": {
        id: "card-1",
        type: "basic",
        q: "Old Q",
        a: "Answer",
        sourceNotePath: "Notes/Test.md",
        createdAt: 1000,
        updatedAt: 1000,
      },
      "card-2": {
        id: "card-2",
        type: "basic",
        q: "Unchanged Q",
        a: "Unchanged A",
        sourceNotePath: "Notes/Test.md",
        createdAt: 1000,
        updatedAt: 1000,
      },
    };

    const parsedCards: CardRecord[] = [
      {
        id: "card-1",
        type: "basic",
        q: "New Edited Q",
        a: "Answer",
        sourceNotePath: "Notes/Test.md",
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        id: "card-2",
        type: "basic",
        q: "Unchanged Q",
        a: "Unchanged A",
        sourceNotePath: "Notes/Test.md",
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        id: "card-3",
        type: "basic",
        q: "Brand New Q",
        a: "Brand New A",
        sourceNotePath: "Notes/Test.md",
        createdAt: 2000,
        updatedAt: 2000,
      },
    ];

    const result = SyncReconciler.reconcileNoteCards({
      notePath: "Notes/Test.md",
      parsedCards,
      storeCards: existingCards,
      storeStates: {},
      now: 2000,
    });

    expect(result.newCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(result.sameCount).toBe(1);
    expect(result.quarantinedCount).toBe(0);
    expect(result.upsertedCards.length).toBe(3);
  });

  it("migrates forward reversed child scheduling state when parent becomes basic", () => {
    const existingCards: Record<string, CardRecord> = {
      "rev-card-1": {
        id: "rev-card-1",
        type: "reversed",
        q: "Dog",
        a: "Chien",
        sourceNotePath: "Notes/Lang.md",
        createdAt: 1000,
        updatedAt: 1000,
      },
    };

    const existingStates: Record<string, CardState> = {
      "rev-card-1::reversed::forward": {
        id: "rev-card-1::reversed::forward",
        stage: "review",
        reps: 8,
        lapses: 1,
        due: 1750000000000,
        scheduledDays: 30,
        learningStepIndex: 0,
      },
    };

    const parsedCards: CardRecord[] = [
      {
        id: "rev-card-1",
        type: "basic",
        q: "Dog",
        a: "Chien",
        sourceNotePath: "Notes/Lang.md",
        createdAt: 1000,
        updatedAt: 2000,
      },
    ];

    const result = SyncReconciler.reconcileNoteCards({
      notePath: "Notes/Lang.md",
      parsedCards,
      storeCards: existingCards,
      storeStates: existingStates,
      now: 2000,
    });

    expect(result.updatedStates["rev-card-1"]).toBeDefined();
    expect(result.updatedStates["rev-card-1"].stage).toBe("review");
    expect(result.updatedStates["rev-card-1"].reps).toBe(8);
  });

  it("quarantines cards with parsing errors or missing references", () => {
    const parsedWithErrors = [
      {
        id: "broken-card-1",
        type: "basic" as const,
        q: null,
        a: null,
        errors: ["Missing question delimiter"],
        sourceNotePath: "Notes/Broken.md",
        sourceStartLine: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ];

    const result = SyncReconciler.reconcileNoteCards({
      notePath: "Notes/Broken.md",
      parsedCards: parsedWithErrors,
      storeCards: {},
      storeStates: {},
      now: 2000,
    });

    expect(result.quarantinedCount).toBe(1);
    expect(result.quarantineEntries["broken-card-1"]).toBeDefined();
    expect(result.quarantineEntries["broken-card-1"].reason).toContain("Missing question delimiter");
  });

  it("quarantines IO cards when referenced image file is missing", () => {
    const parsedIoCard = [
      {
        id: "io-card-1",
        type: "io" as const,
        ioSrc: "assets/diagram.png",
        occlusions: [{ id: "r1", x: 10, y: 10, w: 50, h: 50 }],
        sourceNotePath: "Notes/Anatomy.md",
        sourceStartLine: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ];

    const result = SyncReconciler.reconcileNoteCards({
      notePath: "Notes/Anatomy.md",
      parsedCards: parsedIoCard,
      storeCards: {},
      storeStates: {},
      now: 2000,
      isImageFilePresent: (_imgRef, _path) => false, // simulate missing image
    });

    expect(result.quarantinedCount).toBe(1);
    expect(result.quarantineEntries["io-card-1"]).toBeDefined();
    expect(result.quarantineEntries["io-card-1"].reason).toContain("Image file not found: assets/diagram.png");
  });

  it("produces deterministic card signatures and detects content updates", () => {
    const cardA: CardRecord = {
      id: "card-a",
      type: "basic",
      q: "Capital of France?",
      a: "Paris",
      sourceNotePath: "Notes/Geo.md",
    };

    const cardBSame: CardRecord = {
      id: "card-a",
      type: "basic",
      q: "Capital of France?",
      a: "Paris",
      sourceNotePath: "Notes/Geo.md",
      updatedAt: 99999, // updatedAt is not part of signature
    };

    const cardCDiff: CardRecord = {
      id: "card-a",
      type: "basic",
      q: "Capital of France?",
      a: "Lyon",
      sourceNotePath: "Notes/Geo.md",
    };

    expect(SyncReconciler.cardSignature(cardA)).toBe(SyncReconciler.cardSignature(cardBSame));
    expect(SyncReconciler.cardSignature(cardA)).not.toBe(SyncReconciler.cardSignature(cardCDiff));
  });

  it("sanitizes orphan scheduling states whose cards or quarantine entries no longer exist", () => {
    const storeCards = {
      "card-live": { id: "card-live", type: "basic" as const, q: "Q", a: "A" },
    };
    const storeQuarantine = {
      "card-quarantined": { id: "card-quarantined", notePath: "Notes/Q.md", reason: "error", lastSeenAt: 1000 },
    };
    const storeStates: Record<string, CardState> = {
      "card-live": { id: "card-live", stage: "review", due: 1000, reps: 1, lapses: 0, learningStepIndex: 0, scheduledDays: 1 },
      "card-quarantined": { id: "card-quarantined", stage: "new", due: 1000, reps: 0, lapses: 0, learningStepIndex: 0, scheduledDays: 0 },
      "card-ghost-1": { id: "card-ghost-1", stage: "review", due: 1000, reps: 5, lapses: 1, learningStepIndex: 0, scheduledDays: 10 },
      "card-ghost-2": { id: "card-ghost-2", stage: "learning", due: 1000, reps: 2, lapses: 0, learningStepIndex: 1, scheduledDays: 0 },
    };

    const removed = SyncReconciler.sanitizeOrphanStates(storeCards, storeStates, storeQuarantine);

    expect(removed).toBe(2);
    expect(storeStates["card-live"]).toBeDefined();
    expect(storeStates["card-quarantined"]).toBeDefined();
    expect(storeStates["card-ghost-1"]).toBeUndefined();
    expect(storeStates["card-ghost-2"]).toBeUndefined();
  });

  it("filters stale note cards and detects parent types requiring child deletion", () => {
    const storeCards: Record<string, CardRecord> = {
      "c-keep": { id: "c-keep", type: "basic", q: "Keep Q", a: "Keep A", sourceNotePath: "Notes/Doc.md" },
      "c-del-basic": { id: "c-del-basic", type: "basic", q: "Del Q", a: "Del A", sourceNotePath: "Notes/Doc.md" },
      "c-del-io": { id: "c-del-io", type: "io", imageRef: "diagram.png", sourceNotePath: "Notes/Doc.md" },
      "c-other-note": { id: "c-other-note", type: "basic", q: "Other", a: "Other", sourceNotePath: "Notes/Other.md" },
    };

    const activeIds = new Set(["c-keep"]);
    const staleResult = SyncReconciler.filterStaleNoteCards("Notes/Doc.md", storeCards, activeIds);

    expect(staleResult.removedCards.length).toBe(2);
    expect(staleResult.removedStates).toEqual(["c-del-basic", "c-del-io"]);
    expect(staleResult.removedIoParentData.length).toBe(1);
    expect(staleResult.removedIoParentData[0].id).toBe("c-del-io");
    expect(staleResult.deletedDisplayCount).toBe(1);
  });
});
