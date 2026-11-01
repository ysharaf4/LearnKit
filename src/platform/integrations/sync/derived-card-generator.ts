/**
 * @file src/platform/integrations/sync/derived-card-generator.ts
 * @summary Pure domain module for generating and managing derived flashcards.
 *
 * Handles child-card generation and lifecycle for parent flashcard types:
 * - Cloze deletions (cloze-child for each {{c1::...}} deletion index)
 * - Reversed cards (reversed-child for forward Q→A and back A→Q directions)
 * - Image Occlusion masks (io-child for each mask group)
 * - Hierarchical Question regions (hq-child for each region group)
 * - Combo and sequential zip variants (combo-child)
 * - Pure domain logic with no Obsidian Vault dependencies
 *
 * @exports
 *  - DerivedCardGenerator
 *  - StoredIODefinition
 *  - StoredHqDefinition
 *  - DerivedCardGenerationOptions
 */

import type { CardRecord } from "../../../platform/types/card";
import { extractCompatibilityClozeIndices } from "../../../platform/core/shared-utils";
import { stableHqChildId, stableIoChildId, normaliseGroupKey } from "../../../platform/image-occlusion/mask-tool";
import type { StoredIORect } from "../../../platform/image-occlusion/image-occlusion-types";
import { splitComboVariants, splitZipVariants } from "../../../platform/core/delimiter";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StoredIODefinition = {
  imageRef?: string | null;
  maskMode?: "solo" | "all" | null;
  rects: StoredIORect[];
};

export type StoredHqDefinition = {
  imageRef?: string | null;
  interactionMode?: "click" | "drag-drop" | null;
  rects: StoredIORect[];
};

export type DerivedCardGenerationOptions = {
  ioDefinitions?: Record<string, StoredIODefinition | undefined>;
  hqDefinitions?: Record<string, StoredHqDefinition | undefined>;
  existingCards?: Record<string, CardRecord | undefined>;
};

// ── ID Factories ──────────────────────────────────────────────────────────────

export function stableClozeChildId(parentId: string, idx: number): string {
  return `${parentId}::cloze::c${idx}`;
}

export function stableReversedChildId(parentId: string, dir: "forward" | "back"): string {
  return `${parentId}::reversed::${dir}`;
}

export function stableComboChildId(parentId: string, qi: number, ai: number): string {
  return `${parentId}::combo::q${qi + 1}::a${ai + 1}`;
}

const NUMBER_WORDS: string[] = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
];

function toNumberWord(n: number): string {
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  return NUMBER_WORDS[safe] ?? String(safe);
}

export function formatHotspotPrompt(label: string): string {
  const clean = String(label || "").trim();
  if (!clean) return "Click on the hotspot location.";
  const normalized = clean.replace(/\.+$/, "").trim();
  if (!normalized) return "Click on the hotspot location.";
  return `Click on ${normalized}.`;
}

function resolveChildCreatedAt(prev: CardRecord | undefined, parent: CardRecord, now: number): number {
  if (prev && Number.isFinite(prev.createdAt) && (prev.createdAt as number) > 0) {
    return Number(prev.createdAt);
  }
  if (parent && Number.isFinite(parent.createdAt) && (parent.createdAt as number) > 0) {
    return Number(parent.createdAt);
  }
  return now;
}

// ── Primary Module ────────────────────────────────────────────────────────────

export class DerivedCardGenerator {
  /**
   * Generates all derived child card records for a given parent card definition.
   */
  static generateChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions = {},
  ): CardRecord[] {
    const parentId = String(parent.id ?? "").trim();
    if (!parentId) return [];

    switch (parent.type) {
      case "cloze":
        return DerivedCardGenerator.generateClozeChildren(parent, now, options);
      case "reversed":
        return DerivedCardGenerator.generateReversedChildren(parent, now, options);
      case "io":
        return DerivedCardGenerator.generateIoChildren(parent, now, options);
      case "hq":
        return DerivedCardGenerator.generateHqChildren(parent, now, options);
      case "combo":
      case "basic":
        return DerivedCardGenerator.generateComboChildren(parent, now, options);
      default:
        return [];
    }
  }

  // ── Cloze Children ──────────────────────────────────────────────────────────

  private static generateClozeChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions,
  ): CardRecord[] {
    const parentId = String(parent.id);
    const text = String(parent.clozeText ?? "");
    const indices = extractCompatibilityClozeIndices(text);
    if (!indices.length) return [];

    const titleBase = String(parent.title ?? "").trim();
    const children: CardRecord[] = [];

    for (const idx of indices) {
      const childId = stableClozeChildId(parentId, idx);
      const prev = options.existingCards?.[childId];
      const childTitle = titleBase ? `${titleBase} • Cloze ${idx}` : null;

      children.push({
        id: childId,
        type: "cloze-child",
        title: childTitle,
        parentId,
        clozeIndex: idx,
        clozeText: parent.clozeText ?? null,
        info: parent.info ?? null,
        audioRef: parent.audioRef ?? null,
        groups: parent.groups ?? null,
        sourceNotePath: String(parent.sourceNotePath || ""),
        sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
        createdAt: resolveChildCreatedAt(prev, parent, now),
        updatedAt: now,
        lastSeenAt: now,
      });
    }

    return children;
  }

  // ── Reversed Children ───────────────────────────────────────────────────────

  private static generateReversedChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions,
  ): CardRecord[] {
    const parentId = String(parent.id);
    const directions: Array<"forward" | "back"> = ["forward", "back"];
    const titleBase = String(parent.title ?? "").trim();
    const children: CardRecord[] = [];

    for (const dir of directions) {
      const childId = stableReversedChildId(parentId, dir);
      const prev = options.existingCards?.[childId];
      const dirLabel = dir === "forward" ? "Q→A" : "A→Q";
      const childTitle = titleBase ? `${titleBase} • ${dirLabel}` : null;

      const q = dir === "forward" ? (parent.q ?? null) : (parent.a ?? null);
      const a = dir === "forward" ? (parent.a ?? null) : (parent.q ?? null);

      children.push({
        id: childId,
        type: "reversed-child",
        title: childTitle,
        parentId,
        reversedDirection: dir,
        q,
        a,
        info: parent.info ?? null,
        audioRef: parent.audioRef ?? null,
        groups: parent.groups ?? null,
        sourceNotePath: String(parent.sourceNotePath || ""),
        sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
        createdAt: resolveChildCreatedAt(prev, parent, now),
        updatedAt: now,
        lastSeenAt: now,
      });
    }

    return children;
  }

  // ── Image Occlusion Children ────────────────────────────────────────────────

  private static generateIoChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions,
  ): CardRecord[] {
    const parentId = String(parent.id);
    const ioDef = options.ioDefinitions?.[parentId];
    if (!ioDef || !Array.isArray(ioDef.rects) || !ioDef.rects.length) return [];

    const groupToRectIds = new Map<string, string[]>();
    for (const r of ioDef.rects) {
      const g = normaliseGroupKey(r.groupKey);
      const arr = groupToRectIds.get(g) ?? [];
      arr.push(String(r.rectId));
      groupToRectIds.set(g, arr);
    }

    const titleBase = String(parent.title ?? "").trim();
    const children: CardRecord[] = [];

    for (const [groupKey, rectIds] of groupToRectIds.entries()) {
      const childId = stableIoChildId(parentId, groupKey);
      const prev = options.existingCards?.[childId];

      children.push({
        id: childId,
        type: "io-child",
        title: titleBase || null,
        parentId,
        groupKey,
        rectIds: rectIds.slice(),
        retired: false,
        prompt: parent.prompt ?? null,
        info: parent.info ?? null,
        audioRef: parent.audioRef ?? null,
        groups: parent.groups ?? null,
        sourceNotePath: String(parent.sourceNotePath || ""),
        sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
        imageRef: ioDef.imageRef || null,
        maskMode: ioDef.maskMode || null,
        createdAt: resolveChildCreatedAt(prev, parent, now),
        updatedAt: now,
        lastSeenAt: now,
      });
    }

    return children;
  }

  // ── Hierarchical Question Children ──────────────────────────────────────────

  private static generateHqChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions,
  ): CardRecord[] {
    const parentId = String(parent.id);
    const hqDef = options.hqDefinitions?.[parentId];
    if (!hqDef || !Array.isArray(hqDef.rects) || !hqDef.rects.length) return [];

    const groupToRectIds = new Map<string, string[]>();
    const groupToLabel = new Map<string, string>();
    for (const r of hqDef.rects) {
      const g = normaliseGroupKey(r.groupKey);
      const arr = groupToRectIds.get(g) ?? [];
      arr.push(String(r.rectId));
      groupToRectIds.set(g, arr);
      const labelValue = (r as { label?: unknown }).label;
      const label = typeof labelValue === "string" ? labelValue.trim() : "";
      if (label && !groupToLabel.has(g)) groupToLabel.set(g, label);
    }

    const titleBase = String(parent.title ?? "").trim();
    const children: CardRecord[] = [];

    for (const [groupKey, rectIds] of groupToRectIds.entries()) {
      const childId = stableHqChildId(parentId, groupKey);
      const prev = options.existingCards?.[childId];
      const targetLabel = groupToLabel.get(groupKey) || groupKey;

      children.push({
        id: childId,
        type: "hq-child",
        title: titleBase || null,
        parentId,
        groupKey,
        rectIds: rectIds.slice(),
        retired: false,
        prompt: formatHotspotPrompt(targetLabel),
        info: parent.info ?? null,
        audioRef: parent.audioRef ?? null,
        groups: parent.groups ?? null,
        sourceNotePath: String(parent.sourceNotePath || ""),
        sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
        imageRef: hqDef.imageRef || null,
        interactionMode: hqDef.interactionMode || null,
        createdAt: resolveChildCreatedAt(prev, parent, now),
        updatedAt: now,
        lastSeenAt: now,
      });
    }

    return children;
  }

  // ── Combo Children ──────────────────────────────────────────────────────────

  private static generateComboChildren(
    parent: CardRecord,
    now: number,
    options: DerivedCardGenerationOptions,
  ): CardRecord[] {
    const parentId = String(parent.id);
    const ext = (parent.extensionData ?? {}) as Record<string, unknown>;
    let qVariants: string[] = Array.isArray(ext.qVariants) ? (ext.qVariants as string[]) : [];
    let aVariants: string[] = Array.isArray(ext.aVariants) ? (ext.aVariants as string[]) : [];
    const comboMode = String(ext.comboMode || parent.comboMode || "product");

    if (qVariants.length <= 1 && aVariants.length <= 1) {
      const qRaw = String(parent.q ?? "").trim();
      const aRaw = String(parent.a ?? "").trim();
      if (comboMode === "zip") {
        qVariants = splitZipVariants(qRaw);
        aVariants = splitZipVariants(aRaw);
      } else {
        qVariants = splitComboVariants(qRaw);
        aVariants = splitComboVariants(aRaw);
      }
    }

    if (qVariants.length < 1 || aVariants.length < 1) return [];

    const titleBase = String(parent.title ?? "").trim();
    const children: CardRecord[] = [];

    if (comboMode === "zip") {
      const count = Math.min(qVariants.length, aVariants.length);
      for (let i = 0; i < count; i++) {
        const childId = stableComboChildId(parentId, i, i);
        const prev = options.existingCards?.[childId];
        const pairLabel = `Pair ${toNumberWord(i + 1)}`;
        const childTitle = titleBase ? `${titleBase} – ${pairLabel}` : null;

        children.push({
          id: childId,
          type: "combo-child",
          title: childTitle,
          parentId,
          q: qVariants[i] ?? null,
          a: aVariants[i] ?? null,
          info: parent.info ?? null,
          groups: parent.groups ?? null,
          sourceNotePath: String(parent.sourceNotePath || ""),
          sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
          createdAt: resolveChildCreatedAt(prev, parent, now),
          updatedAt: now,
          lastSeenAt: now,
        });
      }
    } else {
      // Cartesian Product mode
      for (let qi = 0; qi < qVariants.length; qi++) {
        for (let ai = 0; ai < aVariants.length; ai++) {
          const childId = stableComboChildId(parentId, qi, ai);
          const prev = options.existingCards?.[childId];
          const variantLabel = `Q${qi + 1} × A${ai + 1}`;
          const childTitle = titleBase ? `${titleBase} – ${variantLabel}` : null;

          children.push({
            id: childId,
            type: "combo-child",
            title: childTitle,
            parentId,
            q: qVariants[qi] ?? null,
            a: aVariants[ai] ?? null,
            info: parent.info ?? null,
            groups: parent.groups ?? null,
            sourceNotePath: String(parent.sourceNotePath || ""),
            sourceStartLine: Number(parent.sourceStartLine ?? 0) || 0,
            createdAt: resolveChildCreatedAt(prev, parent, now),
            updatedAt: now,
            lastSeenAt: now,
          });
        }
      }
    }

    return children;
  }

  // ── Stale & Orphan Child Deletion ───────────────────────────────────────────

  /**
   * Deletes all child cards associated with a given parent ID.
   */
  static deleteChildrenForParent(
    parentId: string,
    storeCards: Record<string, CardRecord | undefined>,
  ): { remainingCards: Record<string, CardRecord>; removedChildIds: string[] } {
    const remainingCards: Record<string, CardRecord> = {};
    const removedChildIds: string[] = [];

    for (const [id, card] of Object.entries(storeCards)) {
      if (!card) continue;
      if (card.parentId === parentId) {
        removedChildIds.push(id);
      } else {
        remainingCards[id] = card;
      }
    }

    return { remainingCards, removedChildIds };
  }

  /**
   * Prunes all child cards in the store whose parent card no longer exists.
   */
  static pruneGlobalOrphanChildren(
    storeCards: Record<string, CardRecord | undefined>,
  ): { remainingCards: Record<string, CardRecord>; orphanChildIds: string[] } {
    const remainingCards: Record<string, CardRecord> = {};
    const orphanChildIds: string[] = [];

    const parentIds = new Set<string>();
    for (const [id, card] of Object.entries(storeCards)) {
      if (card && !card.parentId) parentIds.add(id);
    }

    const childCardTypes = new Set([
      "io-child",
      "hq-child",
      "cloze-child",
      "reversed-child",
      "combo-child",
    ]);

    for (const [id, card] of Object.entries(storeCards)) {
      if (!card) continue;
      const isChild = childCardTypes.has(card.type) || Boolean(card.parentId);
      if (isChild && (!card.parentId || !parentIds.has(card.parentId))) {
        orphanChildIds.push(id);
      } else {
        remainingCards[id] = card;
      }
    }

    return { remainingCards, orphanChildIds };
  }
}
