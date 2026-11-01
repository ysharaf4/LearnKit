/**
 * @file src/platform/integrations/sync/sync-engine.ts
 * @summary Public facade for LearnKit flashcard synchronization.
 *
 * Decomposed into deep domain modules:
 * - MarkdownCardSync: Pure text synchronization, anchor assignment, shorthand normalization.
 * - DerivedCardGenerator: Pure child-card generation (cloze, reversed, IO, HQ, combo).
 * - SyncReconciler: Card signature diffing, state inheritance, type transitions, quarantine.
 * - SyncCoordinator: Concurrency locking, scope filtering, backups, asset deletion, and persistence.
 *
 * @exports
 *  - formatSyncNotice
 *  - shouldSyncFile
 *  - findOrphanedCards
 *  - pruneOrphanedCards
 *  - syncOneFile
 *  - syncQuestionBank
 *  - SyncCoordinator
 *  - MarkdownCardSync
 *  - DerivedCardGenerator
 *  - SyncReconciler
 *  - SyncNoticeCounts
 *  - SyncModeInput
 *  - SyncMode
 *  - OrphanedCardReason
 *  - OrphanedCard
 *  - PruneOrphanedCardsResult
 */

export {
  SyncCoordinator,
  formatSyncNotice,
  shouldSyncFile,
  findOrphanedCards,
  pruneOrphanedCards,
  syncOneFile,
  syncQuestionBank,
  type SyncNoticeCounts,
  type SyncModeInput,
  type SyncMode,
  type OrphanedCardReason,
  type OrphanedCard,
  type PruneOrphanedCardsResult,
} from "./sync-coordinator";

export { MarkdownCardSync } from "./markdown-card-sync";
export { DerivedCardGenerator } from "./derived-card-generator";
export { SyncReconciler } from "./sync-reconciler";
