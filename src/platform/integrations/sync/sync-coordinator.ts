/**
 * @file src/platform/integrations/sync/sync-coordinator.ts
 * @summary High-level coordinator orchestrating markdown card synchronization, child card generation, reconciliation, concurrency locking, and persistence.
 *
 * Responsibilities:
 * - Per-file and vault-wide concurrency locking.
 * - Scope-based filtering (shouldSyncFile).
 * - Pre-sync routine backups and scheduling snapshot recovery.
 * - Calling MarkdownCardSync for text synchronization and anchor maintenance.
 * - Atomic TOCTOU-safe writes via vault.process().
 * - Calling DerivedCardGenerator for pure child flashcard creation.
 * - Calling SyncReconciler for signature diffing, state inheritance, and quarantine.
 * - Managing store lifecycle, IO asset deletion, TTS cache invalidation, and persistence.
 *
 * @exports
 *  - SyncCoordinator
 *  - SyncNoticeCounts
 *  - SyncNoticeOptions
 *  - SyncModeInput
 *  - SyncMode
 *  - OrphanedCardReason
 *  - OrphanedCard
 *  - PruneOrphanedCardsResult
 *  - formatSyncNotice
 *  - shouldSyncFile
 *  - syncOneFile
 *  - syncQuestionBank
 *  - findOrphanedCards
 *  - pruneOrphanedCards
 */

import { TFile, type App } from "obsidian";
import type LearnKitPlugin from "../../../main";
import type { CardRecord } from "../../../platform/types/card";
import type { ParsedCard } from "../../../engine/parser/parser";
import type { CardState } from "../../types/scheduler";
import { log } from "../../../platform/core/logger";
import { resolveImageFile, selectPreferredIoImageRef } from "../../../platform/image-occlusion/io-helpers";
import { deleteTtsCacheForCardIds, getTtsCacheDirPath } from "../../../platform/integrations/tts/tts-cache";
import { expandGroupPrefixes, normaliseGroupPath } from "../../../engine/indexing/group-index";
import { loadSchedulingFromDataJson } from "../../../platform/core/store";
import {
  countObjectKeys,
  joinPath,
  likelyLearnKitStateKey,
  extractStatesFromDataJsonObject,
  tryReadJson,
  ensureRoutineBackupIfNeeded,
  listDataJsonBackups,
  readValidatedBackupStates,
} from "./backup";
import { MarkdownCardSync } from "./markdown-card-sync";
import { DerivedCardGenerator, type StoredIODefinition, type StoredHqDefinition } from "./derived-card-generator";
import {
  SyncReconciler,
  type QuarantineEntry,
  type SyncMutationEvent,
  createDefaultCardState,
  normalizeIoImageRef,
  countsAsStudyCardDeletion,
} from "./sync-reconciler";
import type { StoredIORect } from "../../../platform/image-occlusion/image-occlusion-types";
import { normaliseGroupKey } from "../../../platform/image-occlusion/mask-tool";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncMode = "full" | "simple-safe" | "simple-compat";
export type SyncModeInput = SyncMode | "simple";

export type SyncNoticeCounts = {
  newCount: number;
  updatedCount: number;
  sameCount?: number;
  idsInserted?: number;
  removed?: number;
  deletedDisplayCount?: number;
  tagsDeleted?: number;
};

export type SyncNoticeOptions = {
  includeDeleted?: boolean;
  includeIdsInserted?: boolean;
};

export type OrphanedCardReason = "note-missing";

export type OrphanedCard = {
  id: string;
  type: string;
  sourceNotePath: string;
  reason: OrphanedCardReason;
};

export type PruneOrphanedCardsResult = {
  removed: number;
  childrenRemoved: number;
  ids: string[];
  skippedReason?: "vault-empty";
};

type StateMap = Record<string, CardState>;

const CHILD_CARD_TYPES = new Set([
  "io-child",
  "hq-child",
  "cloze-child",
  "reversed-child",
  "combo-child",
]);

// ── Concurrency Guards ────────────────────────────────────────────────────────

type LockQueue = Map<string, Promise<void>>;

const FILE_SYNC_LOCKS: LockQueue = new Map();
const VAULT_SYNC_LOCKS: LockQueue = new Map();
const VAULT_LOCK_KEY = "__learnkit-vault-sync__";

async function withLock<T>(lockMap: LockQueue, key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lockMap.get(key) ?? Promise.resolve();
  let release: (() => void) | null = null;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current);

  lockMap.set(key, chained);

  await prev;
  try {
    return await fn();
  } finally {
    if (release) (release as () => void)();
    if (lockMap.get(key) === chained) lockMap.delete(key);
  }
}

async function waitForLock(lockMap: LockQueue, key: string): Promise<void> {
  const pending = lockMap.get(key);
  if (pending) await pending;
}

export async function withFileSyncLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await waitForLock(VAULT_SYNC_LOCKS, VAULT_LOCK_KEY);
  return withLock(FILE_SYNC_LOCKS, filePath, fn);
}

export async function withVaultSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return withLock(VAULT_SYNC_LOCKS, VAULT_LOCK_KEY, async () => {
    if (FILE_SYNC_LOCKS.size > 0) await Promise.all([...FILE_SYNC_LOCKS.values()]);
    return fn();
  });
}

// ── Mode & Scope Filtering ───────────────────────────────────────────────────

export function resolveSyncMode(mode: SyncModeInput | undefined, syncPrivileges: unknown): SyncMode {
  if (mode === "full" || mode === "simple-safe" || mode === "simple-compat") return mode;
  if (mode === "simple") return "simple-compat";

  if (syncPrivileges === "simple-safe") return "simple-safe";
  if (syncPrivileges === "simple-compat" || syncPrivileges === "simple") return "simple-compat";
  return "full";
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

export function parseSyncFilterQuery(
  query: string,
  _file: TFile,
): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  const parts = String(query)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === "scope:vault" || lowered === "vault") {
      include.push("vault::");
      continue;
    }
    if (lowered === "-scope:vault" || lowered === "-vault") {
      exclude.push("vault::");
      continue;
    }
    if (lowered.startsWith("path:")) {
      const path = safeDecode(String(part.slice(5)).trim());
      if (!path) continue;
      include.push(`folder::${path}`);
      continue;
    }
    if (lowered.startsWith("-path:")) {
      const path = safeDecode(String(part.slice(6)).trim());
      if (!path) continue;
      exclude.push(`folder::${path}`);
      continue;
    }
    if (lowered.startsWith("note:")) {
      const path = safeDecode(String(part.slice(5)).trim());
      if (!path) continue;
      include.push(`note::${path}`);
      continue;
    }
    if (lowered.startsWith("-note:")) {
      const path = safeDecode(String(part.slice(6)).trim());
      if (!path) continue;
      exclude.push(`note::${path}`);
      continue;
    }
    if (lowered.startsWith("tag:")) {
      const token = safeDecode(String(part.slice(4)).trim()).toLowerCase().replace(/^#+/, "");
      if (!token) continue;
      include.push(`tag::${token}`);
      continue;
    }
    if (lowered.startsWith("-tag:")) {
      const token = safeDecode(String(part.slice(5)).trim()).toLowerCase().replace(/^#+/, "");
      if (!token) continue;
      exclude.push(`tag::${token}`);
      continue;
    }
    if (lowered.startsWith("prop:")) {
      const token = safeDecode(String(part.slice(5)).trim()).toLowerCase();
      if (!token) continue;
      include.push(`prop::${token}`);
      continue;
    }
    if (lowered.startsWith("-prop:")) {
      const token = safeDecode(String(part.slice(6)).trim()).toLowerCase();
      if (!token) continue;
      exclude.push(`prop::${token}`);
      continue;
    }
    include.push(part);
  }

  return { include, exclude };
}

function decodePropPair(raw: string): { key: string; value: string } | null {
  const source = String(raw);
  const eq = source.indexOf("=");
  if (eq <= 0 || eq >= source.length - 1) return null;
  const key = safeDecode(source.slice(0, eq)).trim().toLowerCase();
  const value = safeDecode(source.slice(eq + 1)).trim().toLowerCase();
  if (!key || !value) return null;
  return { key, value };
}

export function isFilterIdMatch(id: string, file: TFile, app: App): boolean {
  if (id === "vault::") return true;
  if (id.startsWith("folder::")) {
    const folder = id.slice("folder::".length);
    return file.path === folder || file.path.startsWith(`${folder}/`);
  }
  if (id.startsWith("note::")) return file.path === id.slice("note::".length);
  if (id.startsWith("tag::")) {
    const token = id.slice("tag::".length).toLowerCase();
    if (!token) return false;
    const cache = app.metadataCache.getFileCache(file);
    for (const tagRef of cache?.tags ?? []) {
      const tag = String(tagRef?.tag ?? "").replace(/^#+/, "").trim().toLowerCase();
      if (tag === token) return true;
    }
    const frontmatter = cache?.frontmatter;
    if (frontmatter && typeof frontmatter === "object") {
      const entries = Object.entries(frontmatter);
      for (const [key, value] of entries) {
        const normalizedKey = String(key ?? "").trim().toLowerCase();
        if (normalizedKey !== "tag" && normalizedKey !== "tags") continue;
        if (typeof value === "string") {
          for (const t of String(value).split(/[\s,]+/g).filter(Boolean)) {
            const tag = t.replace(/^#+/, "").trim().toLowerCase();
            if (tag === token) return true;
          }
        } else if (Array.isArray(value)) {
          for (const item of value) {
            const tag = String(item ?? "").replace(/^#+/, "").trim().toLowerCase();
            if (tag === token) return true;
          }
        }
      }
    }
    return false;
  }
  if (id.startsWith("prop::")) {
    const pair = decodePropPair(id.slice("prop::".length));
    if (!pair) return false;
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || typeof frontmatter !== "object") return false;
    const entries = Object.entries(frontmatter);
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey ?? "").trim().toLowerCase();
      if (key !== pair.key) continue;
      if (key === "position" || key === "tags") continue;

      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          if (item == null || typeof item === "object") continue;
          if (String(item).trim().toLowerCase() === pair.value) return true;
        }
      } else if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
        if (String(rawValue).trim().toLowerCase() === pair.value) return true;
      }
    }
    return false;
  }
  return false;
}

export function shouldSyncFile(plugin: LearnKitPlugin, file: TFile): boolean {
  const query = plugin.settings?.indexing?.syncFilterQuery;
  if (!query) return true;

  const { include, exclude } = parseSyncFilterQuery(query, file);
  if (!include.length) return !exclude.some((id) => isFilterIdMatch(id, file, plugin.app));

  return (
    include.some((id) => isFilterIdMatch(id, file, plugin.app)) &&
    !exclude.some((id) => isFilterIdMatch(id, file, plugin.app))
  );
}

// ── Notice Formatting ─────────────────────────────────────────────────────────

export function formatSyncNotice(prefix: string, res: SyncNoticeCounts, options: SyncNoticeOptions = {}): string {
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const parts: string[] = [];
  const deletedCount = Number(res.deletedDisplayCount ?? res.removed ?? 0);
  const idsInserted = Number(res.idsInserted ?? 0);

  if (res.newCount > 0) parts.push(`${res.newCount} ${plural(res.newCount, "new card", "new cards")}`);
  if (res.updatedCount > 0) parts.push(`${res.updatedCount} ${plural(res.updatedCount, "updated card", "updated cards")}`);
  if (options.includeDeleted && deletedCount > 0) parts.push(`${deletedCount} ${plural(deletedCount, "card deleted", "cards deleted")}`);
  if ((options.includeIdsInserted ?? true) && idsInserted > 0) parts.push(`${idsInserted} ${plural(idsInserted, "ID inserted", "IDs inserted")}`);

  if (!parts.length) return `${prefix} - no changes`;
  return `${prefix} - ${parts.join("; ")}`;
}

// ── Scheduling Recovery & Logging ─────────────────────────────────────────────

async function loadBestSchedulingSnapshot(plugin: LearnKitPlugin): Promise<StateMap | null> {
  const inMem = plugin.store.data.states;
  if (countObjectKeys(inMem) > 0) return inMem;

  try {
    const prev = await loadSchedulingFromDataJson(plugin);
    if (prev && typeof prev === "object" && Object.keys(prev).length > 0) return prev as StateMap;
  } catch {
    // ignore
  }

  const adapter = plugin.app?.vault?.adapter;
  const pluginId: string | null = String(plugin.manifest?.id ?? "").trim() || null;
  const candidateFiles = ["data.json", "data.json.bak", "data.json.prev", "data.json.old", "data.json.backup"];
  const configDir = plugin.app.vault.configDir;

  if (pluginId && adapter) {
    for (const name of candidateFiles) {
      const p = joinPath(configDir, "plugins", pluginId, name);
      const obj = await tryReadJson(adapter, p);
      const states = extractStatesFromDataJsonObject(obj);
      if (!states || Object.keys(states).length === 0) continue;
      const keys = Object.keys(states);
      const validKeyCount = keys.reduce((acc, k) => acc + (likelyLearnKitStateKey(k) ? 1 : 0), 0);
      if (keys.length > 0 && validKeyCount / keys.length < 0.7) continue;
      return states as StateMap;
    }

    const entries = await listDataJsonBackups(plugin);
    for (const entry of entries) {
      const p = entry.path;
      const validated = await readValidatedBackupStates(plugin, p);
      if (!validated?.states) continue;

      const keys = Object.keys(validated.states);
      const validKeyCount = keys.reduce((acc, k) => acc + (likelyLearnKitStateKey(k) ? 1 : 0), 0);
      if (keys.length > 0 && validKeyCount / keys.length < 0.7) continue;

      return validated.states as StateMap;
    }
  }

  return null;
}

function isLikelyRecoveryScenario(plugin: LearnKitPlugin, parsedCardCount: number): boolean {
  const stateCount = countObjectKeys(plugin.store.data.states);
  const cardCount = countObjectKeys(plugin.store.data.cards);
  if (stateCount > 0) return false;
  return cardCount === 0 && parsedCardCount > 0;
}

function logSyncMutation(
  scope: "syncOneFile" | "syncQuestionBank" | "pruneOrphanedCards",
  action: "added" | "updated" | "deleted",
  event: SyncMutationEvent,
): void {
  log.debug(`${scope}: card ${action}`, {
    id: event.id,
    type: event.type,
    notePath: event.notePath,
    reason: event.reason,
  });
}

function logSyncMutationSummary(
  scope: "syncOneFile" | "syncQuestionBank" | "pruneOrphanedCards",
  events: { added: SyncMutationEvent[]; updated: SyncMutationEvent[]; deleted: SyncMutationEvent[] },
): void {
  if (!events.added.length && !events.updated.length && !events.deleted.length) return;

  const format = (items: SyncMutationEvent[]) => items.map((item) => `${item.id} (${item.type})`).join(", ");
  log.info(`${scope}: card mutations`, {
    addedCount: events.added.length,
    updatedCount: events.updated.length,
    deletedCount: events.deleted.length,
    added: format(events.added),
    updated: format(events.updated),
    deleted: format(events.deleted),
  });
}

// ── Cleanups & Deprecated Types ───────────────────────────────────────────────

function purgeDeprecatedTypes(plugin: LearnKitPlugin) {
  const cards = plugin.store.data.cards || {};
  const states = plugin.store.data.states || {};
  for (const [id, rec] of Object.entries(cards)) {
    const t = String(rec?.type ?? "").toLowerCase();
    if (t === "lq" || t === "fq") {
      delete cards[id];
      delete states[id];
    }
  }
  const quarantine = plugin.store.data.quarantine || {};
  for (const [id, rec] of Object.entries(quarantine)) {
    const rawType = (rec as Record<string, unknown>)?.type;
    const t = (typeof rawType === "string" ? rawType : "").toLowerCase();
    if (t === "lq" || t === "fq") delete quarantine[id];
  }
}

function quarantineIoCardsWithMissingImages(plugin: LearnKitPlugin): number {
  const cards = plugin.store.data.cards || {};
  const now = Date.now();
  let count = 0;

  for (const [id, rec] of Object.entries(cards)) {
    if (!rec || String(rec.type) !== "io") continue;

    const sourceNotePath = String(rec.sourceNotePath || "");
    const legacyIoSrc = (rec as unknown as Record<string, unknown>).ioSrc;
    const rawImageRef = typeof rec.imageRef === "string"
      ? rec.imageRef
      : typeof legacyIoSrc === "string"
        ? legacyIoSrc
        : "";
    const imageRef = selectPreferredIoImageRef(plugin.app, sourceNotePath, rawImageRef);
    if (!imageRef) continue;

    const imageFile = resolveImageFile(plugin.app, sourceNotePath, rawImageRef || imageRef);
    if (!imageFile || !(imageFile instanceof TFile)) {
      plugin.store.data.quarantine[id] = {
        id,
        notePath: rec.sourceNotePath || "",
        sourceStartLine: rec.sourceStartLine || 0,
        reason: `Image file not found: ${imageRef}`,
        lastSeenAt: now,
      };
      delete plugin.store.data.cards[id];
      count += 1;
    }
  }

  return count;
}

export async function deleteIoImage(plugin: LearnKitPlugin, imageRef: string, sourceNotePath: string): Promise<void> {
  const preferredRef = selectPreferredIoImageRef(plugin.app, sourceNotePath, imageRef);
  if (!preferredRef) return;

  try {
    const file = resolveImageFile(plugin.app, sourceNotePath, imageRef);
    if (file && file instanceof TFile) await plugin.app.fileManager.trashFile(file);
  } catch (e) {
    log.warn(`Failed to delete IO image ${preferredRef}:`, e);
  }
}

export async function deleteOrphanedIoImages(plugin: LearnKitPlugin): Promise<number> {
  if (!plugin.settings?.storage?.deleteOrphanedImages) return 0;

  const vault = plugin.app.vault;
  const allFiles = vault.getFiles();

  const referencedImagePaths = new Set<string>();
  for (const card of Object.values(plugin.store.data.cards || {})) {
    if (!card) continue;
    if (card.imageRef) referencedImagePaths.add(card.imageRef);
  }
  for (const def of Object.values(plugin.store.data.io || {})) {
    if (def?.imageRef) referencedImagePaths.add(def.imageRef);
  }
  for (const def of Object.values(plugin.store.data.hq || {})) {
    if (def?.imageRef) referencedImagePaths.add(def.imageRef);
  }

  let deletedCount = 0;
  for (const file of allFiles) {
    const name = file.name;
    const isIoOrHqImage =
      /^(?:sprout|learnkit)-io-/i.test(name) ||
      /.* - LK-(?:IO|HQ)-\d+.*\.(?:png|jpe?g|webp|gif|svg)$/i.test(name);
    if (!isIoOrHqImage) continue;

    if (!referencedImagePaths.has(file.name) && !referencedImagePaths.has(file.path)) {
      try {
        await plugin.app.fileManager.trashFile(file);
        deletedCount++;
      } catch (err) {
        log.warn(`deleteOrphanedIoImages: failed to trash ${file.path}`, err);
      }
    }
  }

  return deletedCount;
}

async function pruneTtsCacheForCards(plugin: LearnKitPlugin, cardIds: readonly string[], reason: string): Promise<void> {
  if (!cardIds.length) return;

  const adapter = plugin.app?.vault?.adapter;
  const configDir = plugin.app?.vault?.configDir;
  const pluginId = plugin.manifest?.id;
  if (!adapter || !configDir || !pluginId) return;

  const cacheDirPath = getTtsCacheDirPath(configDir, pluginId);
  const removedCount = await deleteTtsCacheForCardIds(adapter, cacheDirPath, cardIds);

  if (removedCount > 0) {
    log.info(`sync: removed ${removedCount} cached TTS file(s) for ${reason} card(s)`);
  }
}

function collectGroupKeys(cards: Record<string, CardRecord> | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const card of Object.values(cards || {})) {
    if (!card) continue;
    const groups = Array.isArray(card.groups) ? card.groups : [];
    for (const raw of groups) {
      const norm = normaliseGroupPath(raw);
      if (!norm) continue;
      for (const k of expandGroupPrefixes(norm)) out.add(k);
    }
  }
  return out;
}

function countRemovedGroups(before: Set<string>, after: Set<string>): number {
  let removed = 0;
  for (const k of before) if (!after.has(k)) removed += 1;
  return removed;
}

// ── Ghost Card Queries & Pruning ──────────────────────────────────────────────

export function findOrphanedCards(plugin: LearnKitPlugin): OrphanedCard[] {
  const vault = plugin.app?.vault;
  if (!vault) return [];

  const out: OrphanedCard[] = [];

  for (const [id, rec] of Object.entries(plugin.store.data.cards || {})) {
    if (!rec) continue;
    const type = String(rec.type || "");
    if (CHILD_CARD_TYPES.has(type)) continue;

    const path = String(rec.sourceNotePath || "").trim();
    if (!path) continue;

    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) continue;

    out.push({ id: String(id), type, sourceNotePath: path, reason: "note-missing" });
  }

  return out;
}

export async function pruneOrphanedCards(
  plugin: LearnKitPlugin,
  options?: { dryRun?: boolean },
): Promise<PruneOrphanedCardsResult> {
  const vault = plugin.app?.vault;
  const dryRun = options?.dryRun === true;

  if (!vault) return { removed: 0, childrenRemoved: 0, ids: [], skippedReason: "vault-empty" };

  const markdownFiles = vault.getMarkdownFiles();
  if (!markdownFiles.length) {
    log.warn("pruneOrphanedCards: vault reported no markdown files — skipping (index not ready?)");
    return { removed: 0, childrenRemoved: 0, ids: [], skippedReason: "vault-empty" };
  }

  const orphans = findOrphanedCards(plugin);
  if (!orphans.length) return { removed: 0, childrenRemoved: 0, ids: [], skippedReason: undefined };

  if (dryRun) {
    return { removed: orphans.length, childrenRemoved: 0, ids: orphans.map((o) => o.id) };
  }

  let childrenRemoved = 0;
  const removedIds: string[] = [];

  for (const orphan of orphans) {
    const rec = plugin.store.data.cards[orphan.id];
    if (!rec) continue;

    switch (orphan.type) {
      case "io": {
        const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(orphan.id, plugin.store.data.cards);
        for (const cid of removedChildIds) {
          delete plugin.store.data.cards[cid];
          if (plugin.store.data.states) delete plugin.store.data.states[cid];
        }
        childrenRemoved += removedChildIds.length;
        if (rec.imageRef) await deleteIoImage(plugin, rec.imageRef, orphan.sourceNotePath);
        if (plugin.store.data.io?.[orphan.id]) delete plugin.store.data.io[orphan.id];
        break;
      }
      case "hq": {
        const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(orphan.id, plugin.store.data.cards);
        for (const cid of removedChildIds) {
          delete plugin.store.data.cards[cid];
          if (plugin.store.data.states) delete plugin.store.data.states[cid];
        }
        childrenRemoved += removedChildIds.length;
        if (plugin.store.data.hq?.[orphan.id]) delete plugin.store.data.hq[orphan.id];
        break;
      }
      case "cloze":
      case "reversed":
      case "combo": {
        const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(orphan.id, plugin.store.data.cards);
        for (const cid of removedChildIds) {
          delete plugin.store.data.cards[cid];
          if (plugin.store.data.states) delete plugin.store.data.states[cid];
        }
        childrenRemoved += removedChildIds.length;
        break;
      }
      default:
        break;
    }

    delete plugin.store.data.cards[orphan.id];
    if (plugin.store.data.states) delete plugin.store.data.states[orphan.id];
    removedIds.push(orphan.id);

    logSyncMutation("pruneOrphanedCards", "deleted", {
      id: orphan.id,
      type: orphan.type,
      notePath: orphan.sourceNotePath,
      reason: "note-missing",
    });
  }

  const { orphanChildIds } = DerivedCardGenerator.pruneGlobalOrphanChildren(plugin.store.data.cards);
  for (const cid of orphanChildIds) {
    delete plugin.store.data.cards[cid];
    if (plugin.store.data.states) delete plugin.store.data.states[cid];
  }
  childrenRemoved += orphanChildIds.length;

  SyncReconciler.sanitizeOrphanStates(plugin.store.data.cards, plugin.store.data.states, plugin.store.data.quarantine);
  await pruneTtsCacheForCards(plugin, removedIds, "orphaned");

  return { removed: removedIds.length, childrenRemoved, ids: removedIds, skippedReason: undefined };
}

// ── Child Card Sync Helper ───────────────────────────────────────────────────

function syncParentChildrenAndStore(
  plugin: LearnKitPlugin,
  parentRecord: CardRecord,
  parsedCard: ParsedCard,
  now: number,
  schedulingSnapshot?: StateMap | null,
): void {
  const parentId = String(parentRecord.id);

  // IO / HQ store definition synchronization
  if (parentRecord.type === "io") {
    if (!plugin.store.data.io) plugin.store.data.io = {};
    if (!plugin.store.data.io[parentId]) {
      const occlusions = (parentRecord as any).occlusions;
      const imageRef = parentRecord.imageRef;
      if (Array.isArray(occlusions) && occlusions.length > 0 && imageRef) {
        const rects: StoredIORect[] = occlusions.map((r: any) => ({
          rectId: String(r.rectId ?? r.id ?? `r-${Math.random().toString(16).slice(2)}`),
          x: Number(r.x ?? 0),
          y: Number(r.y ?? 0),
          w: Number(r.w ?? r.width ?? 0),
          h: Number(r.h ?? r.height ?? 0),
          groupKey: normaliseGroupKey(r.groupKey),
          shape: r.shape === "circle" ? "circle" : r.shape === "polygon" ? "polygon" : "rect",
          points: Array.isArray(r.points) && r.points.length >= 3 ? r.points : undefined,
        }));
        plugin.store.data.io[parentId] = {
          imageRef,
          maskMode: parentRecord.maskMode as "solo" | "all" | null,
          rects,
        };
      }
    }
  } else if (parentRecord.type === "hq") {
    if (!plugin.store.data.hq) plugin.store.data.hq = {};
    if (!plugin.store.data.hq[parentId]) {
      const regions = (parentRecord as any).hqRegions ?? (parentRecord as any).regions ?? (parentRecord as any).occlusions;
      const imageRef = parentRecord.imageRef;
      if (Array.isArray(regions) && regions.length > 0 && imageRef) {
        const rects: StoredIORect[] = regions.map((r: any) => ({
          rectId: String(r.rectId ?? r.id ?? `r-${Math.random().toString(16).slice(2)}`),
          x: Number(r.x ?? 0),
          y: Number(r.y ?? 0),
          w: Number(r.w ?? r.width ?? 0),
          h: Number(r.h ?? r.height ?? 0),
          groupKey: normaliseGroupKey(r.groupKey),
          label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : normaliseGroupKey(r.groupKey),
          shape: r.shape === "circle" ? "circle" : r.shape === "polygon" ? "polygon" : "rect",
          points: Array.isArray(r.points) && r.points.length >= 3 ? r.points : undefined,
        }));
        plugin.store.data.hq[parentId] = {
          imageRef,
          interactionMode: parentRecord.interactionMode as "click" | "drag-drop" | null,
          prompt: (parentRecord as any).prompt ?? null,
          rects,
        };
      }
    }
  }

  // Generate children using DerivedCardGenerator
  const generatedChildren = DerivedCardGenerator.generateChildren(parentRecord, now, {
    ioDefinitions: plugin.store.data.io as Record<string, StoredIODefinition | undefined>,
    hqDefinitions: plugin.store.data.hq as Record<string, StoredHqDefinition | undefined>,
    existingCards: plugin.store.data.cards,
  });

  const keepChildIds = new Set<string>();

  for (const child of generatedChildren) {
    keepChildIds.add(child.id);

    // Merge or upsert child
    const prev = plugin.store.data.cards[child.id];
    const merged = prev ? { ...prev, ...child } : child;
    plugin.store.upsertCard(merged);

    // Child state management
    if (!plugin.store.data.states?.[child.id]) {
      // Basic → Reversed migration for forward child
      if (child.type === "reversed-child" && (child as any).reversedDirection === "forward" && plugin.store.data.states?.[parentId]) {
        const parentState = plugin.store.data.states[parentId];
        plugin.store.upsertState({ ...parentState, id: child.id });
        delete plugin.store.data.states[parentId];
      } else if (schedulingSnapshot?.[child.id]) {
        plugin.store.upsertState({ ...schedulingSnapshot[child.id], id: child.id });
      } else {
        plugin.store.ensureState(child.id, now, 2.5);
      }
    }
  }

  // Prune any existing children for this parent that are not in generated set
  const childTypeMap: Record<string, string> = {
    cloze: "cloze-child",
    reversed: "reversed-child",
    io: "io-child",
    hq: "hq-child",
    combo: "combo-child",
  };
  const expectedChildType = childTypeMap[parentRecord.type];
  if (expectedChildType) {
    for (const [id, rec] of Object.entries(plugin.store.data.cards || {})) {
      if (rec && rec.type === expectedChildType && rec.parentId === parentId && !keepChildIds.has(id)) {
        delete plugin.store.data.cards[id];
        if (plugin.store.data.states) delete plugin.store.data.states[id];
      }
    }
  }
}

// ── syncOneFile ───────────────────────────────────────────────────────────────

export async function syncOneFile(
  plugin: LearnKitPlugin,
  file: TFile,
  options?: {
    sourceTextOverride?: string;
    pruneGlobalOrphans?: boolean;
    syncMode?: SyncModeInput;
  },
): Promise<SyncNoticeCounts & { quarantinedIds: string[]; quarantinedCount: number }> {
  return withFileSyncLock(file.path, async () => {
    const syncMode = resolveSyncMode(options?.syncMode, plugin.settings?.general?.syncPrivileges);
    const vault = plugin.app.vault;
    const now = Date.now();

    if (!shouldSyncFile(plugin, file)) {
      return {
        idsInserted: 0,
        anchorsRemoved: 0,
        newCount: 0,
        updatedCount: 0,
        sameCount: 0,
        quarantinedCount: 0,
        quarantinedIds: [],
        removed: 0,
        deletedDisplayCount: 0,
        tagsDeleted: 0,
      };
    }

    const groupsBefore = collectGroupKeys(plugin.store.data.cards || {});
    await ensureRoutineBackupIfNeeded(plugin);

    purgeDeprecatedTypes(plugin);
    quarantineIoCardsWithMissingImages(plugin);

    const originalText =
      typeof options?.sourceTextOverride === "string"
        ? options.sourceTextOverride
        : await vault.cachedRead(file);

    // 1. Text & Anchor synchronization via MarkdownCardSync
    let syncResult = MarkdownCardSync.syncText(originalText, file.path, {
      syncMode,
      ignoreInCodeFences: plugin.settings.indexing.ignoreInCodeFences,
      usedIds: new Set([
        ...Object.keys(plugin.store.data.cards || {}),
        ...Object.keys(plugin.store.data.quarantine || {}),
      ]),
      storeCards: plugin.store.data.cards,
      storeQuarantine: plugin.store.data.quarantine,
    });

    // 2. TOCTOU safe write via vault.process()
    if (syncResult.editsCount > 0 && syncResult.updatedText !== originalText) {
      await vault.process(file, (data) => {
        if (data !== originalText) {
          log.warn(`syncOneFile: file "${file.path}" changed during sync; re-parsing from live content`);
          syncResult = MarkdownCardSync.syncText(data, file.path, {
            syncMode,
            ignoreInCodeFences: plugin.settings.indexing.ignoreInCodeFences,
            usedIds: new Set([
              ...Object.keys(plugin.store.data.cards || {}),
              ...Object.keys(plugin.store.data.quarantine || {}),
            ]),
            storeCards: plugin.store.data.cards,
            storeQuarantine: plugin.store.data.quarantine,
          });
          return syncResult.updatedText;
        }
        return syncResult.updatedText;
      });
    }

    // 3. Scheduling snapshot recovery if needed
    const schedulingSnapshot = isLikelyRecoveryScenario(plugin, syncResult.parsedCards.length)
      ? await loadBestSchedulingSnapshot(plugin)
      : null;

    if (schedulingSnapshot && Object.keys(schedulingSnapshot).length) {
      for (const id of syncResult.keepIds) {
        if (!plugin.store.data.states?.[id] && schedulingSnapshot[id]) {
          plugin.store.upsertState({ ...schedulingSnapshot[id], id });
        }
      }
    }

    // 4. Reconcile parsed cards against store
    const isImageFilePresent = (imageRef: string, notePath: string): boolean => {
      const imgFile = resolveImageFile(plugin.app, notePath, imageRef);
      return Boolean(imgFile && imgFile instanceof TFile);
    };

    const reconciliation = SyncReconciler.reconcileNoteCards({
      notePath: file.path,
      parsedCards: syncResult.parsedCards,
      storeCards: plugin.store.data.cards,
      storeStates: plugin.store.data.states || {},
      storeQuarantine: plugin.store.data.quarantine,
      ioDefs: plugin.store.data.io,
      hqDefs: plugin.store.data.hq,
      now,
      schedulingSnapshot: schedulingSnapshot || undefined,
      isImageFilePresent,
      selectPreferredImageRef: (raw, notePath) => selectPreferredIoImageRef(plugin.app, notePath, raw),
    });

    // Upsert reconciled cards and states
    for (const card of reconciliation.upsertedCards) {
      plugin.store.upsertCard(card);
    }
    for (const [id, state] of Object.entries(reconciliation.updatedStates)) {
      plugin.store.upsertState(state);
    }
    for (const [id, q] of Object.entries(reconciliation.quarantineEntries)) {
      plugin.store.data.quarantine[id] = q;
      delete plugin.store.data.cards[id];
    }
    for (const id of reconciliation.clearedQuarantineIds) {
      delete plugin.store.data.quarantine[id];
    }

    // Generate derived children for parent cards
    for (const c of syncResult.parsedCards) {
      const id = String(c.id || c.assignedId || "");
      const record = plugin.store.data.cards[id];
      if (!record) continue;

      if (
        record.type === "cloze" ||
        record.type === "reversed" ||
        record.type === "io" ||
        record.type === "hq" ||
        record.type === "combo" ||
        (record.type === "basic" && record.extensionData)
      ) {
        syncParentChildrenAndStore(plugin, record, c, now, schedulingSnapshot);
      }
    }

    // 5. Stale card removal for this note
    const stale = SyncReconciler.filterStaleNoteCards(file.path, plugin.store.data.cards, syncResult.keepIds);
    let removed = stale.removedCards.length;
    let deletedDisplayCount = stale.deletedDisplayCount;

    for (const card of stale.removedCards) {
      delete plugin.store.data.cards[card.id];
      if (plugin.store.data.states) delete plugin.store.data.states[card.id];
      logSyncMutation("syncOneFile", "deleted", {
        id: card.id,
        type: card.type,
        notePath: file.path,
        reason: "missing-in-source-note",
      });
    }

    for (const ioData of stale.removedIoParentData) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(ioData.id, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
      if (ioData.imageRef) await deleteIoImage(plugin, ioData.imageRef, ioData.sourceNotePath);
      if (plugin.store.data.io?.[ioData.id]) delete plugin.store.data.io[ioData.id];
    }

    for (const parentId of stale.removedHqParentIds) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(parentId, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
      if (plugin.store.data.hq?.[parentId]) delete plugin.store.data.hq[parentId];
    }

    for (const parentId of [...stale.removedClozeParents, ...stale.removedReversedParents, ...stale.removedComboParents]) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(parentId, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
    }

    // Stale quarantine entries for this note
    for (const [id, q] of Object.entries(plugin.store.data.quarantine || {})) {
      if (q && q.notePath === file.path && !syncResult.keepIds.has(id)) {
        delete plugin.store.data.quarantine[id];
        if (plugin.store.data.states) delete plugin.store.data.states[id];
        removed += 1;
      }
    }

    // Prune TTS cache for updated / removed cards
    await pruneTtsCacheForCards(plugin, stale.removedStates, "deleted");
    await pruneTtsCacheForCards(plugin, reconciliation.updatedCardIds, "edited");

    // Persist store
    await plugin.store.persist();

    logSyncMutationSummary("syncOneFile", {
      added: reconciliation.mutationEvents.added,
      updated: reconciliation.mutationEvents.updated,
      deleted: stale.mutationEvents,
    });

    const groupsAfter = collectGroupKeys(plugin.store.data.cards || {});
    const tagsDeleted = countRemovedGroups(groupsBefore, groupsAfter);

    return {
      idsInserted: syncResult.idsInserted,
      anchorsRemoved: syncResult.anchorsRemoved,
      newCount: reconciliation.newCount,
      updatedCount: reconciliation.updatedCount,
      sameCount: reconciliation.sameCount,
      quarantinedCount: reconciliation.quarantinedCount,
      quarantinedIds: reconciliation.quarantinedIds,
      removed,
      deletedDisplayCount,
      tagsDeleted,
    };
  });
}

// ── syncQuestionBank ──────────────────────────────────────────────────────────

export async function syncQuestionBank(
  plugin: LearnKitPlugin,
  options?: { syncMode?: SyncModeInput },
): Promise<SyncNoticeCounts & { quarantinedIds: string[]; quarantinedCount: number }> {
  return withVaultSyncLock(async () => {
    const syncMode = resolveSyncMode(options?.syncMode, plugin.settings?.general?.syncPrivileges);
    const now = Date.now();
    const vault = plugin.app.vault;

    const groupsBefore = collectGroupKeys(plugin.store.data.cards || {});
    const allCardIdsBefore = new Set(Object.keys(plugin.store.data.cards || {}));

    purgeDeprecatedTypes(plugin);
    quarantineIoCardsWithMissingImages(plugin);

    const mdFiles = vault.getMarkdownFiles();
    const schedulingSnapshot = await loadBestSchedulingSnapshot(plugin);

    let idsInserted = 0;
    let anchorsRemoved = 0;
    let newCount = 0;
    let updatedCount = 0;
    let sameCount = 0;
    let quarantinedCount = 0;
    const quarantinedIds: string[] = [];
    const updatedCardIds: string[] = [];
    const mutationEvents: { added: SyncMutationEvent[]; updated: SyncMutationEvent[]; deleted: SyncMutationEvent[] } = {
      added: [],
      updated: [],
      deleted: [],
    };

    const activeCardIdsAcrossVault = new Set<string>();

    const usedIds = new Set<string>([
      ...Object.keys(plugin.store.data.cards || {}),
      ...Object.keys(plugin.store.data.quarantine || {}),
    ]);

    for (const file of mdFiles) {
      if (!shouldSyncFile(plugin, file)) continue;

      try {
        let text = await vault.cachedRead(file);
        let syncResult = MarkdownCardSync.syncText(text, file.path, {
          syncMode,
          ignoreInCodeFences: plugin.settings.indexing.ignoreInCodeFences,
          usedIds,
          storeCards: plugin.store.data.cards,
          storeQuarantine: plugin.store.data.quarantine,
        });

        if (syncResult.editsCount > 0 && syncResult.updatedText !== text) {
          await vault.process(file, (data) => {
            if (data !== text) {
              text = data;
              syncResult = MarkdownCardSync.syncText(text, file.path, {
                syncMode,
                ignoreInCodeFences: plugin.settings.indexing.ignoreInCodeFences,
                usedIds,
                storeCards: plugin.store.data.cards,
                storeQuarantine: plugin.store.data.quarantine,
              });
              return syncResult.updatedText;
            }
            return syncResult.updatedText;
          });
        }

        idsInserted += syncResult.idsInserted;
        anchorsRemoved += syncResult.anchorsRemoved;

        for (const id of syncResult.keepIds) {
          activeCardIdsAcrossVault.add(id);
        }

        const isImageFilePresent = (imageRef: string, notePath: string): boolean => {
          const imgFile = resolveImageFile(plugin.app, notePath, imageRef);
          return Boolean(imgFile && imgFile instanceof TFile);
        };

        const reconciliation = SyncReconciler.reconcileNoteCards({
          notePath: file.path,
          parsedCards: syncResult.parsedCards,
          storeCards: plugin.store.data.cards,
          storeStates: plugin.store.data.states || {},
          storeQuarantine: plugin.store.data.quarantine,
          ioDefs: plugin.store.data.io,
          hqDefs: plugin.store.data.hq,
          now,
          schedulingSnapshot: schedulingSnapshot || undefined,
          isImageFilePresent,
          selectPreferredImageRef: (raw, notePath) => selectPreferredIoImageRef(plugin.app, notePath, raw),
        });

        for (const card of reconciliation.upsertedCards) {
          plugin.store.upsertCard(card);
        }
        for (const [id, state] of Object.entries(reconciliation.updatedStates)) {
          plugin.store.upsertState(state);
        }
        for (const [id, q] of Object.entries(reconciliation.quarantineEntries)) {
          plugin.store.data.quarantine[id] = q;
          delete plugin.store.data.cards[id];
        }
        for (const id of reconciliation.clearedQuarantineIds) {
          delete plugin.store.data.quarantine[id];
        }

        newCount += reconciliation.newCount;
        updatedCount += reconciliation.updatedCount;
        sameCount += reconciliation.sameCount;
        quarantinedCount += reconciliation.quarantinedCount;
        quarantinedIds.push(...reconciliation.quarantinedIds);
        updatedCardIds.push(...reconciliation.updatedCardIds);
        mutationEvents.added.push(...reconciliation.mutationEvents.added);
        mutationEvents.updated.push(...reconciliation.mutationEvents.updated);

        // Generate children
        for (const c of syncResult.parsedCards) {
          const id = String(c.id || c.assignedId || "");
          const record = plugin.store.data.cards[id];
          if (!record) continue;

          if (
            record.type === "cloze" ||
            record.type === "reversed" ||
            record.type === "io" ||
            record.type === "hq" ||
            record.type === "combo" ||
            (record.type === "basic" && record.extensionData)
          ) {
            syncParentChildrenAndStore(plugin, record, c, now, schedulingSnapshot);
          }
        }
      } catch (err) {
        log.warn(`syncQuestionBank: skipping file "${file.path}" due to read/write error`, err);
      }
    }

    // Vault-wide stale card sweep
    let removed = 0;
    let deletedDisplayCount = 0;
    const removedIoParentData: Array<{ id: string; imageRef: string | null; sourceNotePath: string }> = [];
    const removedHqParentIds: string[] = [];
    const removedClozeParents: string[] = [];
    const removedReversedParents: string[] = [];
    const removedComboParents: string[] = [];

    for (const [id, card] of Object.entries(plugin.store.data.cards || {})) {
      if (!card) continue;
      if (CHILD_CARD_TYPES.has(card.type)) continue;

      if (!activeCardIdsAcrossVault.has(id)) {
        const cardType = String(card.type);
        if (cardType === "io") removedIoParentData.push({ id, imageRef: card.imageRef || null, sourceNotePath: card.sourceNotePath || "" });
        if (cardType === "hq") removedHqParentIds.push(id);
        if (cardType === "cloze") removedClozeParents.push(id);
        if (cardType === "reversed") removedReversedParents.push(id);
        if (cardType === "combo") removedComboParents.push(id);

        delete plugin.store.data.cards[id];
        if (plugin.store.data.states) delete plugin.store.data.states[id];
        removed += 1;
        if (countsAsStudyCardDeletion(cardType)) {
          deletedDisplayCount += 1;
        }

        const event: SyncMutationEvent = {
          id,
          type: cardType,
          notePath: String(card.sourceNotePath || ""),
          reason: "missing-in-vault-scan",
        };
        mutationEvents.deleted.push(event);
        logSyncMutation("syncQuestionBank", "deleted", event);
      }
    }

    for (const ioData of removedIoParentData) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(ioData.id, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
      if (ioData.imageRef) await deleteIoImage(plugin, ioData.imageRef, ioData.sourceNotePath);
      if (plugin.store.data.io?.[ioData.id]) delete plugin.store.data.io[ioData.id];
    }

    for (const parentId of removedHqParentIds) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(parentId, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
      if (plugin.store.data.hq?.[parentId]) delete plugin.store.data.hq[parentId];
    }

    for (const parentId of [...removedClozeParents, ...removedReversedParents, ...removedComboParents]) {
      const { removedChildIds } = DerivedCardGenerator.deleteChildrenForParent(parentId, plugin.store.data.cards);
      for (const cid of removedChildIds) {
        delete plugin.store.data.cards[cid];
        if (plugin.store.data.states) delete plugin.store.data.states[cid];
      }
      removed += removedChildIds.length;
      deletedDisplayCount += removedChildIds.length;
    }

    for (const [id, q] of Object.entries(plugin.store.data.quarantine || {})) {
      if (q && !activeCardIdsAcrossVault.has(id)) {
        delete plugin.store.data.quarantine[id];
        if (plugin.store.data.states) delete plugin.store.data.states[id];
        removed += 1;
        const event: SyncMutationEvent = {
          id,
          type: "quarantine",
          notePath: String(q.notePath || ""),
          reason: "quarantine-entry-stale",
        };
        mutationEvents.deleted.push(event);
      }
    }

    const { orphanChildIds } = DerivedCardGenerator.pruneGlobalOrphanChildren(plugin.store.data.cards);
    for (const cid of orphanChildIds) {
      delete plugin.store.data.cards[cid];
      if (plugin.store.data.states) delete plugin.store.data.states[cid];
    }
    removed += orphanChildIds.length;
    deletedDisplayCount += orphanChildIds.length;

    const sanitizedStates = SyncReconciler.sanitizeOrphanStates(
      plugin.store.data.cards,
      plugin.store.data.states,
      plugin.store.data.quarantine,
    );
    if (sanitizedStates > 0) {
      log.info(`syncQuestionBank: pruned ${sanitizedStates} orphaned scheduling state(s)`);
    }

    const groupsAfter = collectGroupKeys(plugin.store.data.cards || {});
    const tagsDeleted = countRemovedGroups(groupsBefore, groupsAfter);

    const deletedImages = await deleteOrphanedIoImages(plugin);
    if (deletedImages > 0) log.info(`Deleted ${deletedImages} orphaned IO image(s)`);

    logSyncMutationSummary("syncQuestionBank", mutationEvents);

    const allCardIdsAfter = new Set(Object.keys(plugin.store.data.cards || {}));
    const removedCardIdsForCache: string[] = [];
    for (const id of allCardIdsBefore) {
      if (!allCardIdsAfter.has(id)) removedCardIdsForCache.push(id);
    }
    await pruneTtsCacheForCards(plugin, removedCardIdsForCache, "deleted");
    await pruneTtsCacheForCards(plugin, updatedCardIds, "edited");

    await plugin.store.persist();

    return {
      idsInserted,
      anchorsRemoved,
      newCount,
      updatedCount,
      sameCount,
      quarantinedCount,
      quarantinedIds,
      removed,
      deletedDisplayCount,
      tagsDeleted,
    };
  });
}

// ── Facade Class ──────────────────────────────────────────────────────────────

export class SyncCoordinator {
  static withFileSyncLock = withFileSyncLock;
  static withVaultSyncLock = withVaultSyncLock;
  static shouldSyncFile = shouldSyncFile;
  static formatSyncNotice = formatSyncNotice;
  static deleteIoImage = deleteIoImage;
  static deleteOrphanedIoImages = deleteOrphanedIoImages;
  static findOrphanedCards = findOrphanedCards;
  static pruneOrphanedCards = pruneOrphanedCards;
  static syncOneFile = syncOneFile;
  static syncQuestionBank = syncQuestionBank;
}
