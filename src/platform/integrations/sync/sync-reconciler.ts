/**
 * @file src/platform/integrations/sync/sync-reconciler.ts
 * @summary Pure domain module for flashcard diffing, state migration, quarantine, and reconciliation.
 *
 * Responsibilities:
 * - Deterministic card signature computation (cardSignature) for change detection.
 * - Reconciling parsed note cards against existing store records.
 * - Scheduling state migration (e.g. reversed child -> basic parent).
 * - Quarantine tracking for malformed cards or missing assets.
 * - Orphan state pruning (sanitizeOrphanStates).
 *
 * @exports
 *  - SyncReconciler
 *  - ReconcileNoteCardsOptions
 *  - ReconcileNoteCardsResult
 *  - QuarantineEntry
 *  - StaleNoteCardsResult
 *  - createDefaultCardState
 */

import type { CardRecord } from "../../../platform/types/card";
import { normalizeCardOptions } from "../../../platform/types/card";
import type { ParsedCard } from "../../../engine/parser/parser";
import type { CardState } from "../../../platform/types/scheduler";
import type { State as FsrsState } from "ts-fsrs";
import { extractCompatibilityClozeIndices } from "../../../platform/core/shared-utils";

// ── Types ─────────────────────────────────────────────────────────────────────

export type QuarantineEntry = {
  id: string;
  notePath: string;
  sourceStartLine: number;
  reason: string;
  lastSeenAt: number;
};

export type SyncMutationEvent = {
  id: string;
  type: string;
  notePath: string;
  reason?: string;
};

export type ReconcileNoteCardsOptions = {
  notePath: string;
  parsedCards: Array<ParsedCard & { assignedId?: string }>;
  storeCards: Record<string, CardRecord | undefined>;
  storeStates: Record<string, CardState | undefined>;
  storeQuarantine?: Record<string, QuarantineEntry | undefined>;
  ioDefs?: Record<string, { rects?: unknown[]; maskMode?: "solo" | "all" | null; imageRef?: string | null } | undefined>;
  hqDefs?: Record<string, { rects?: unknown[]; interactionMode?: "click" | "drag-drop" | null; imageRef?: string | null } | undefined>;
  now: number;
  schedulingSnapshot?: Record<string, CardState>;
  isImageFilePresent?: (imageRef: string, notePath: string) => boolean;
  selectPreferredImageRef?: (rawRef: string, notePath: string) => string | null;
};

export type ReconcileNoteCardsResult = {
  upsertedCards: CardRecord[];
  updatedStates: Record<string, CardState>;
  quarantineEntries: Record<string, QuarantineEntry>;
  clearedQuarantineIds: string[];
  newCount: number;
  updatedCount: number;
  sameCount: number;
  quarantinedCount: number;
  quarantinedIds: string[];
  updatedCardIds: string[];
  mutationEvents: {
    added: SyncMutationEvent[];
    updated: SyncMutationEvent[];
  };
};

export type StaleNoteCardsResult = {
  removedCards: CardRecord[];
  removedStates: string[];
  removedQuarantine: string[];
  removedIoParentData: Array<{ id: string; imageRef: string | null; sourceNotePath: string }>;
  removedHqParentIds: string[];
  removedClozeParents: string[];
  removedReversedParents: string[];
  removedComboParents: string[];
  deletedDisplayCount: number;
  mutationEvents: SyncMutationEvent[];
};

// ── Utilities ─────────────────────────────────────────────────────────────────

export function createDefaultCardState(id: string, now: number): CardState {
  return {
    id,
    stage: "new",
    due: now,
    reps: 0,
    lapses: 0,
    learningStepIndex: 0,
    fsrsState: 0 as FsrsState,
    scheduledDays: 0,
  };
}

export function normalizeIoImageRef(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const embedMatch = text.match(/!\[\[([^\]]+)\]\]/);
  if (embedMatch?.[1]) {
    const inner = embedMatch[1].trim();
    return inner.split("|")[0]?.trim() || null;
  }

  const mdMatch = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (mdMatch?.[1]) {
    const inner = mdMatch[1].trim();
    return inner.split(" ")[0]?.trim() || null;
  }

  return text;
}

export function mcqLegacyFromParsed(c: ParsedCard): {
  options: string[];
  correctIndex: number | null;
  correctIndices: number[];
} {
  if (c.type === "mcq") {
    const allOpts = Array.isArray(c.options) ? c.options : [];
    const options: string[] = [];
    const correctIndices: number[] = [];

    for (const opt of allOpts) {
      const text = String(opt.text ?? "").trim();
      if (!text) continue;
      if (opt.isCorrect) correctIndices.push(options.length);
      options.push(text);
    }

    if (options.length === 0) {
      const correct = typeof c.a === "string" ? c.a.trim() : null;
      let wrongs: string[] = Array.isArray(c.options) ? (c.options as any[]).map((o: any) => String(o.text ?? "").trim()) : [];
      if (correct) {
        wrongs = wrongs.filter((w: string) => w !== correct);
        return { options: [correct, ...wrongs], correctIndex: 0, correctIndices: [0] };
      }
      return { options: wrongs, correctIndex: null, correctIndices: [] };
    }

    const correctIndex = correctIndices.length > 0 ? correctIndices[0] : null;
    return { options, correctIndex, correctIndices };
  }

  const opts = Array.isArray(c.options) ? c.options : [];
  const options = opts.map((o: any) => String(o?.text ?? "")).map((s: string) => s.trim());
  let correctIndex: number | null =
    Number.isFinite(c.correctIndex) && c.correctIndex !== null ? c.correctIndex : null;
  if (correctIndex === null) {
    const idx = opts.findIndex((o: any) => Boolean(o?.isCorrect));
    correctIndex = idx >= 0 ? idx : null;
  }
  const correctIndices = correctIndex !== null ? [correctIndex] : [];
  return { options, correctIndex, correctIndices };
}

export function countsAsStudyCardDeletion(cardType: string): boolean {
  return cardType !== "cloze" && cardType !== "io" && cardType !== "hq" && cardType !== "reversed";
}

// ── Primary Module ────────────────────────────────────────────────────────────

export class SyncReconciler {
  /**
   * Produces a deterministic JSON string representing a card's content.
   * Used to detect whether a card's content has changed since last sync.
   */
  static cardSignature(rec: CardRecord | null | undefined): string {
    if (!rec) return "";

    const base: Record<string, unknown> = {
      type: rec.type,
      title: rec.title || "",
      info: rec.info || "",
      audioRef: rec.audioRef || "",
      groups: Array.isArray(rec.groups) ? rec.groups : [],
    };

    if (rec.type === "basic" || rec.type === "reversed") {
      base.q = rec.q || "";
      base.a = rec.a || "";
      if (rec.extensionData && typeof rec.extensionData === "object") {
        const ext = rec.extensionData as Record<string, unknown>;
        const qv = ext.qVariants;
        const av = ext.aVariants;
        if ((Array.isArray(qv) && qv.length > 1) || (Array.isArray(av) && av.length > 1)) {
          base.extensionData = rec.extensionData;
        }
      }
    } else if (rec.type === "mcq") {
      base.stem = rec.stem || "";
      base.options = normalizeCardOptions(rec.options);
      base.correctIndex = Number.isFinite(rec.correctIndex) ? rec.correctIndex : -1;
      base.correctIndices = Array.isArray(rec.correctIndices) ? rec.correctIndices : [];
      base.a = rec.a || "";
    } else if (rec.type === "cloze") {
      base.clozeText = rec.clozeText || "";
      base.clozeChildren = Array.isArray(rec.clozeChildren) ? rec.clozeChildren : [];
    } else if (rec.type === "io") {
      const legacy = rec as unknown as Record<string, unknown>;
      base.imageRef = rec.imageRef ?? (legacy.ioSrc) ?? (legacy.src) ?? "";
      base.occlusions = (legacy.occlusions ?? legacy.rects ?? legacy.masks ?? []);
      base.maskMode = rec.maskMode ?? (legacy.mode) ?? null;
    } else if (rec.type === "hq") {
      const legacy = rec as unknown as Record<string, unknown>;
      base.imageRef = rec.imageRef ?? (legacy.hqSrc) ?? (legacy.src) ?? "";
      base.regions = (legacy.hqRegions ?? legacy.occlusions ?? legacy.rects ?? []);
      base.interactionMode = rec.interactionMode ?? null;
      base.prompt = rec.prompt ?? null;
    } else if (rec.type === "io-child") {
      base.parentId = rec.parentId || "";
      base.groupKey = rec.groupKey || "";
      base.rectIds = Array.isArray(rec.rectIds) ? rec.rectIds : [];
      base.imageRef = rec.imageRef ?? "";
      base.maskMode = rec.maskMode ?? null;
      base.retired = Boolean(rec.retired);
    } else if (rec.type === "hq-child") {
      base.parentId = rec.parentId || "";
      base.groupKey = rec.groupKey || "";
      base.rectIds = Array.isArray(rec.rectIds) ? rec.rectIds : [];
      base.imageRef = rec.imageRef ?? "";
      base.interactionMode = rec.interactionMode ?? null;
      base.prompt = rec.prompt ?? null;
      base.retired = Boolean(rec.retired);
    } else if (rec.type === "cloze-child") {
      base.parentId = rec.parentId || "";
      base.clozeIndex = Number.isFinite(rec.clozeIndex) ? rec.clozeIndex : -1;
      base.clozeText = rec.clozeText || "";
    } else if (rec.type === "reversed-child") {
      base.parentId = rec.parentId || "";
      base.reversedDirection = rec.reversedDirection || "forward";
      base.q = rec.q || "";
      base.a = rec.a || "";
    } else if (rec.type === "oq") {
      base.q = rec.q || "";
      base.oqSteps = Array.isArray(rec.oqSteps) ? rec.oqSteps : [];
    } else if (rec.type === "combo") {
      base.extensionData = rec.extensionData ?? null;
    }

    return JSON.stringify(base);
  }

  /**
   * Reconciles parsed cards against the store for a single note.
   */
  static reconcileNoteCards(options: ReconcileNoteCardsOptions): ReconcileNoteCardsResult {
    const {
      notePath,
      parsedCards,
      storeCards,
      storeStates,
      storeQuarantine = {},
      ioDefs = {},
      hqDefs = {},
      now,
      schedulingSnapshot,
      isImageFilePresent,
      selectPreferredImageRef,
    } = options;

    const upsertedCards: CardRecord[] = [];
    const updatedStates: Record<string, CardState> = {};
    const quarantineEntries: Record<string, QuarantineEntry> = {};
    const clearedQuarantineIds: string[] = [];
    let newCount = 0;
    let updatedCount = 0;
    let sameCount = 0;
    let quarantinedCount = 0;
    const quarantinedIds: string[] = [];
    const updatedCardIds: string[] = [];
    const mutationEvents: { added: SyncMutationEvent[]; updated: SyncMutationEvent[] } = {
      added: [],
      updated: [],
    };

    const hasState = (id: string): boolean => {
      return Boolean(updatedStates[id] || storeStates[id]);
    };

    for (const c of parsedCards) {
      const id = String(c.id || c.assignedId || "").trim();
      if (!id) continue;

      // 1) Quarantine syntax/parsing errors
      if (c.errors && c.errors.length) {
        quarantineEntries[id] = {
          id,
          notePath: c.sourceNotePath || notePath,
          sourceStartLine: c.sourceStartLine ?? 0,
          reason: c.errors.join("; "),
          lastSeenAt: now,
        };
        quarantinedCount += 1;
        quarantinedIds.push(id);

        if (!hasState(id)) {
          updatedStates[id] = createDefaultCardState(id, now);
        }
        continue;
      }

      // Clear any prior quarantine entry if card now valid
      if (storeQuarantine[id]) {
        clearedQuarantineIds.push(id);
      }

      const prev = storeCards[id];
      const createdAt =
        prev && Number.isFinite(prev.createdAt) && Number(prev.createdAt) > 0
          ? Number(prev.createdAt)
          : now;

      // Extract IO / HQ image & occlusions
      let imageRef: string | null = null;
      let occlusions: unknown[] | null = null;
      let maskMode: "solo" | "all" | null = null;
      let hqRegions: unknown[] | null = null;
      let interactionMode: "click" | "drag-drop" | null = null;

      if (c.type === "io") {
        const storedIoDef = ioDefs[id];
        const raw = typeof (c as Record<string, unknown>).imageRef === "string"
          ? ((c as Record<string, unknown>).imageRef as string)
          : typeof c.ioSrc === "string"
            ? c.ioSrc
            : null;
        imageRef = (selectPreferredImageRef ? selectPreferredImageRef(raw ?? "", c.sourceNotePath || notePath) : null)
          ?? normalizeIoImageRef(raw);
        const occRaw = c.occlusions ?? storedIoDef?.rects ?? null;
        occlusions = Array.isArray(occRaw) ? occRaw : null;
        maskMode = (c.maskMode ?? storedIoDef?.maskMode ?? null) as "solo" | "all" | null;

        // Image file existence check
        if (imageRef && isImageFilePresent && !isImageFilePresent(imageRef, c.sourceNotePath || notePath)) {
          quarantineEntries[id] = {
            id,
            notePath: c.sourceNotePath || notePath,
            sourceStartLine: c.sourceStartLine ?? 0,
            reason: `Image file not found: ${imageRef}`,
            lastSeenAt: now,
          };
          quarantinedCount += 1;
          quarantinedIds.push(id);
          if (!hasState(id)) {
            updatedStates[id] = createDefaultCardState(id, now);
          }
          continue;
        }
      } else if (c.type === "hq") {
        const storedHqDef = hqDefs[id];
        const raw = typeof c.hqSrc === "string" ? c.hqSrc : null;
        imageRef = (selectPreferredImageRef ? selectPreferredImageRef(raw ?? "", c.sourceNotePath || notePath) : null)
          ?? normalizeIoImageRef(raw);
        const hqRaw = c.hqRegions ?? storedHqDef?.rects ?? null;
        hqRegions = Array.isArray(hqRaw) ? hqRaw : null;
        interactionMode = (c.interactionMode ?? storedHqDef?.interactionMode ?? null) as "click" | "drag-drop" | null;

        if (imageRef && isImageFilePresent && !isImageFilePresent(imageRef, c.sourceNotePath || notePath)) {
          quarantineEntries[id] = {
            id,
            notePath: c.sourceNotePath || notePath,
            sourceStartLine: c.sourceStartLine ?? 0,
            reason: `Image file not found: ${imageRef}`,
            lastSeenAt: now,
          };
          quarantinedCount += 1;
          quarantinedIds.push(id);
          if (!hasState(id)) {
            updatedStates[id] = createDefaultCardState(id, now);
          }
          continue;
        }
      }

      // Build card record
      const clozeChildren = c.type === "cloze" ? extractCompatibilityClozeIndices(c.clozeText ?? "") : null;

      const record: CardRecord = {
        id,
        type: c.type,
        title: c.title ?? null,
        q: (c.type === "basic" || c.type === "reversed" || c.type === "oq" || c.type === "combo")
          ? (c.q ?? null)
          : null,
        a: (c.type === "basic" || c.type === "reversed" || c.type === "combo")
          ? (c.a ?? null)
          : c.type === "mcq"
            ? (c.a ?? null)
            : null,
        stem: c.type === "mcq" ? (c.stem ?? null) : null,
        ...(c.type === "mcq" ? mcqLegacyFromParsed(c) : {}),
        clozeText: c.type === "cloze" ? (c.clozeText ?? null) : null,
        clozeChildren: c.type === "cloze" ? clozeChildren : null,
        ...(c.type === "io"
          ? {
              imageRef: imageRef ?? null,
              occlusions: occlusions ?? null,
              maskMode: maskMode ?? null,
              prompt: c.prompt ?? null,
            }
          : c.type === "hq"
            ? {
                imageRef: imageRef ?? null,
                hqRegions: hqRegions ?? null,
                interactionMode: interactionMode ?? null,
                prompt: c.prompt ?? null,
              }
            : {}),
        oqSteps: c.type === "oq" ? (c.oqSteps ?? []) : undefined,
        extensionData:
          (c.type === "combo" || c.type === "basic") &&
          ((c.qVariants?.length ?? 0) > 1 || (c.aVariants?.length ?? 0) > 1)
            ? { qVariants: c.qVariants ?? [], aVariants: c.aVariants ?? [], comboMode: c.comboMode ?? "product" }
            : undefined,
        comboMode:
          (c.type === "combo" || c.type === "basic") &&
          ((c.qVariants?.length ?? 0) > 1 || (c.aVariants?.length ?? 0) > 1)
            ? (c.comboMode ?? "product")
            : undefined,
        info: c.info ?? null,
        audioRef: c.audioRef ?? null,
        groups: c.groups ?? null,
        sourceNotePath: c.sourceNotePath || notePath,
        sourceStartLine: c.sourceStartLine,
        createdAt,
        updatedAt: now,
        lastSeenAt: now,
      };

      // Signature comparison
      if (!prev) {
        newCount += 1;
        const event: SyncMutationEvent = {
          id,
          type: String(record.type),
          notePath: String(record.sourceNotePath || ""),
        };
        mutationEvents.added.push(event);
      } else if (SyncReconciler.cardSignature(prev) !== SyncReconciler.cardSignature(record)) {
        updatedCount += 1;
        updatedCardIds.push(id);
        const event: SyncMutationEvent = {
          id,
          type: String(record.type),
          notePath: String(record.sourceNotePath || ""),
        };
        mutationEvents.updated.push(event);
      } else {
        sameCount += 1;
      }

      upsertedCards.push(record);

      // State reconciliation & migration
      if (!hasState(id)) {
        const fwdChildId = `${id}::reversed::forward`;
        const fwdChildState = storeStates[fwdChildId] || updatedStates[fwdChildId] || schedulingSnapshot?.[fwdChildId];
        if (c.type === "basic" && fwdChildState) {
          // Reversed → Basic migration: inherit forward child scheduling state
          updatedStates[id] = { ...fwdChildState, id };
        } else if (schedulingSnapshot?.[id]) {
          // Restored from scheduling snapshot
          updatedStates[id] = { ...schedulingSnapshot[id], id };
        } else {
          // Initialize default state
          updatedStates[id] = createDefaultCardState(id, now);
        }
      }
    }

    return {
      upsertedCards,
      updatedStates,
      quarantineEntries,
      clearedQuarantineIds,
      newCount,
      updatedCount,
      sameCount,
      quarantinedCount,
      quarantinedIds,
      updatedCardIds,
      mutationEvents,
    };
  }

  /**
   * Identifies stale cards in store belonging to notePath that were not present in activeIds.
   */
  static filterStaleNoteCards(
    notePath: string,
    storeCards: Record<string, CardRecord | undefined>,
    activeIds: Set<string>,
  ): StaleNoteCardsResult {
    const removedCards: CardRecord[] = [];
    const removedStates: string[] = [];
    const removedQuarantine: string[] = [];
    const removedIoParentData: Array<{ id: string; imageRef: string | null; sourceNotePath: string }> = [];
    const removedHqParentIds: string[] = [];
    const removedClozeParents: string[] = [];
    const removedReversedParents: string[] = [];
    const removedComboParents: string[] = [];
    let deletedDisplayCount = 0;
    const mutationEvents: SyncMutationEvent[] = [];

    for (const [id, rec] of Object.entries(storeCards)) {
      if (!rec) continue;
      if (rec.sourceNotePath !== notePath) continue;

      // Ignore child card types here; they are managed through their parent card
      const type = String(rec.type);
      if (
        type === "io-child" ||
        type === "hq-child" ||
        type === "cloze-child" ||
        type === "reversed-child" ||
        type === "combo-child"
      ) {
        continue;
      }

      if (!activeIds.has(id)) {
        removedCards.push(rec);
        removedStates.push(id);
        removedQuarantine.push(id);

        if (type === "io") {
          removedIoParentData.push({ id, imageRef: rec.imageRef || null, sourceNotePath: rec.sourceNotePath || notePath });
        } else if (type === "hq") {
          removedHqParentIds.push(id);
        } else if (type === "cloze") {
          removedClozeParents.push(id);
        } else if (type === "reversed") {
          removedReversedParents.push(id);
        } else if (type === "combo") {
          removedComboParents.push(id);
        } else if (type === "basic") {
          const ext = rec.extensionData as Record<string, unknown> | undefined;
          if (ext && typeof ext === "object" && !Array.isArray(ext)) {
            if ((Array.isArray(ext.qVariants) && ext.qVariants.length > 1) || (Array.isArray(ext.aVariants) && ext.aVariants.length > 1)) {
              removedComboParents.push(id);
            }
          }
        }

        if (countsAsStudyCardDeletion(type)) {
          deletedDisplayCount += 1;
        }

        mutationEvents.push({
          id,
          type,
          notePath: rec.sourceNotePath || notePath,
          reason: "missing-in-source-note",
        });
      }
    }

    return {
      removedCards,
      removedStates,
      removedQuarantine,
      removedIoParentData,
      removedHqParentIds,
      removedClozeParents,
      removedReversedParents,
      removedComboParents,
      deletedDisplayCount,
      mutationEvents,
    };
  }

  /**
   * Prunes orphan scheduling states whose IDs are not in liveIds (cards or quarantine).
   * Modifies storeStates in-place and returns the number of states removed.
   */
  static sanitizeOrphanStates(
    storeCards: Record<string, unknown>,
    storeStates: Record<string, unknown>,
    storeQuarantine?: Record<string, unknown>,
  ): number {
    const liveIds = new Set<string>([
      ...Object.keys(storeCards || {}),
      ...Object.keys(storeQuarantine || {}),
    ]);

    let removed = 0;
    for (const id of Object.keys(storeStates || {})) {
      if (liveIds.has(id)) continue;
      delete storeStates[id];
      removed += 1;
    }

    return removed;
  }
}
