/**
 * Plugin Lifecycle Coordinator
 *
 * Deep domain module responsible for managing LearnKit plugin startup
 * initialization, view registrations, command bindings, workspace layout
 * hooks, and clean teardown.
 */

import { Notice, type App, type WorkspaceLeaf } from "obsidian";
import {
  VIEW_TYPE_REVIEWER,
  VIEW_TYPE_WIDGET,
  VIEW_TYPE_STUDY_ASSISTANT,
  VIEW_TYPE_BROWSER,
  VIEW_TYPE_NOTE_REVIEW,
  VIEW_TYPE_ANALYTICS,
  VIEW_TYPE_HOME,
  VIEW_TYPE_SETTINGS,
  VIEW_TYPE_EXAM_GENERATOR,
  VIEW_TYPE_COACH,
  LEGACY_VIEW_TYPE_REVIEWER,
  LEGACY_VIEW_TYPE_WIDGET,
  LEGACY_VIEW_TYPE_STUDY_ASSISTANT,
  LEGACY_VIEW_TYPE_BROWSER,
  LEGACY_VIEW_TYPE_ANALYTICS,
  LEGACY_VIEW_TYPE_HOME,
  LEGACY_VIEW_TYPE_SETTINGS,
  LEGACY_VIEW_TYPE_EXAM_GENERATOR,
  LEGACY_VIEW_TYPE_COACH,
  LEGACY_TO_CURRENT_VIEW_TYPES,
} from "../core/constants";
import { log } from "../core/logger";
import { findOrphanedCards, pruneOrphanedCards } from "../integrations/sync/sync-engine";
import { ConfirmCleanupOrphanedCardsModal } from "../../views/settings/confirm-modals";
import type { IStore } from "../core/store-interface";
import type { FlashcardType } from "../core/utils";
import type LearnKitPlugin from "../../main";
import { LearnKitReviewerView } from "../../views/reviewer/review-view";
import { LearnKitWidgetView } from "../../views/widget/view/widget-view";
import { LearnKitStudyAssistantView } from "../../views/study-assistant/view/study-assistant-view";
import { LearnKitCardBrowserView } from "../../views/browser/card-browser-view";
import { LearnKitAnalyticsView } from "../../views/analytics/analytics-view";
import { LearnKitHomeView } from "../../views/home/home-view";
import { LearnKitSettingsView } from "../../views/settings/view/settings-view";
import { LearnKitNoteReviewView } from "../../views/note-review/view/note-review-view";
import { LearnKitExamGeneratorView } from "../../views/exam-generator/exam-generator-view";
import { LearnKitCoachView } from "../../views/coach";

export const LEARNKIT_VIEW_TYPES_TO_DETACH = [
  VIEW_TYPE_REVIEWER,
  VIEW_TYPE_NOTE_REVIEW,
  VIEW_TYPE_WIDGET,
  VIEW_TYPE_BROWSER,
  VIEW_TYPE_ANALYTICS,
  VIEW_TYPE_HOME,
  VIEW_TYPE_SETTINGS,
  VIEW_TYPE_EXAM_GENERATOR,
  VIEW_TYPE_COACH,
  VIEW_TYPE_STUDY_ASSISTANT,
] as const;

export const GUIDE_PORTAL_MARKER_SELECTOR = ".learnkit-guide-nav-group";

export class PluginLifecycleManager {
  static detachLearnKitLeaves(app: App): void {
    const ws = app?.workspace;
    if (!ws) return;

    const types = new Set<string>(LEARNKIT_VIEW_TYPES_TO_DETACH);
    for (const legacy of Object.keys(LEGACY_TO_CURRENT_VIEW_TYPES)) types.add(legacy);

    try {
      if (ws.getLeavesOfType(VIEW_TYPE_WIDGET).length > 0) {
        (window as unknown as Record<string, unknown>).__learnkitReopenWidget = true;
      }
    } catch (e) {
      log.swallow("record widget state before unload", e);
    }

    for (const type of types) {
      try {
        ws.detachLeavesOfType(type);
      } catch (e) {
        log.swallow(`detach leaves for ${type}`, e);
      }
    }
  }

  static restoreWidgetAfterReload(app: App, openWidgetSafe: () => Promise<void>): void {
    const flagKey = "__learnkitReopenWidget";
    const holder = window as unknown as Record<string, unknown>;
    if (holder[flagKey] !== true) return;
    holder[flagKey] = false;

    app.workspace.onLayoutReady(() => {
      void openWidgetSafe();
    });
  }

  static async retargetCardsAfterMove(store: IStore, oldPath: string, newPath: string): Promise<void> {
    try {
      const moved = store?.retargetSourceNotePath?.(oldPath, newPath) ?? 0;
      if (moved <= 0) return;
      await store.persist();
      log.info(`rename: retargeted ${moved} card record(s) ${oldPath} -> ${newPath}`);
    } catch (e) {
      log.swallow(`retarget cards after move ${oldPath} -> ${newPath}`, e);
    }
  }

  static sweepOrphanedBodyPortals(): void {
    let ports: NodeListOf<Element>;
    try {
      ports = activeDocument.querySelectorAll("body > div.learnkit");
    } catch (e) {
      log.swallow("scan for orphaned portals", e);
      return;
    }

    for (const el of Array.from(ports)) {
      if (!el.querySelector(GUIDE_PORTAL_MARKER_SELECTOR)) continue;
      el.remove();
    }
  }

  static async runCleanupOrphanedCards(plugin: LearnKitPlugin): Promise<void> {
    const orphans = findOrphanedCards(plugin);

    if (!orphans.length) {
      new Notice(plugin._tx("ui.notice.orphanCleanup.none", "No orphaned flashcards found."));
      return;
    }

    const byNote = new Map<string, number>();
    for (const orphan of orphans) {
      byNote.set(orphan.sourceNotePath, (byNote.get(orphan.sourceNotePath) ?? 0) + 1);
    }

    new ConfirmCleanupOrphanedCardsModal(
      plugin.app,
      plugin,
      orphans.length,
      Array.from(byNote.entries()).map(([path, count]) => ({ path, count })),
      async () => {
        const result = await pruneOrphanedCards(plugin);
        await plugin.store.persist();

        if (result.skippedReason === "vault-empty") {
          new Notice(
            plugin._tx("ui.notice.orphanCleanup.skipped", "Skipped: the vault index is not ready yet (no notes found)."),
          );
          return;
        }

        new Notice(
          plugin._tx("ui.notice.orphanCleanup.done", "Removed {count} orphaned flashcard{suffix}.", {
            count: result.removed,
            suffix: result.removed === 1 ? "" : "s",
          }),
        );
      },
    ).open();
  }

  static registerCommands(plugin: LearnKitPlugin): void {
    const tx = (token: string, fallback: string) => plugin._tx(token, fallback);

    plugin.addCommand({
      id: "sync-flashcards-current-note",
      name: tx("ui.command.open.syncCurrentNote", "Sync flashcards from current note"),
      callback: async () => plugin._runSyncCurrentNote(),
    });
    plugin.addCommand({
      id: "sync-flashcards",
      name: tx("ui.command.open.syncAll", "Sync all flashcards from the vault"),
      callback: async () => plugin._runSync(),
    });
    plugin.addCommand({
      id: "cleanup-orphaned-flashcards",
      name: tx("ui.command.open.cleanupOrphaned", "Clean up orphaned flashcards"),
      callback: async () => PluginLifecycleManager.runCleanupOrphanedCards(plugin),
    });
    plugin.addCommand({
      id: "open",
      name: tx("ui.command.open.home", "Open home"),
      callback: async () => plugin.openHomeTab(),
    });
    plugin.addCommand({
      id: "open-widget",
      name: tx("ui.command.open.studyWidget", "Open flashcard study widget"),
      callback: async () => plugin.openWidgetSafe(),
    });
    plugin.addCommand({
      id: "open-assistant-widget",
      name: tx("ui.command.open.assistantWidget", "Open study companion widget"),
      checkCallback: (checking: boolean) => {
        if (!plugin.settings?.studyAssistant?.enabled) return false;
        if (!checking) void plugin.openAssistantWidgetSafe();
        return true;
      },
    });
    plugin.addCommand({
      id: "open-analytics",
      name: tx("ui.command.open.analytics", "Open analytics"),
      callback: async () => plugin.openAnalyticsTab(),
    });
    plugin.addCommand({
      id: "open-settings",
      name: tx("ui.command.open.pluginSettings", "Open plugin settings"),
      callback: () => plugin.openPluginSettingsInObsidian(),
    });
    plugin.addCommand({
      id: "open-guide",
      name: tx("ui.command.open.guide", "Open guide"),
      callback: async () => plugin.openSettingsTab(false, "guide"),
    });
    plugin.addCommand({
      id: "edit-flashcards",
      name: tx("ui.command.open.editFlashcards", "Edit flashcards"),
      callback: async () => plugin.openBrowserTab(),
    });
    plugin.addCommand({
      id: "new-study-session",
      name: tx("ui.command.open.newStudySession", "New study session"),
      callback: async () => plugin.openReviewerTab(),
    });
    plugin.addCommand({
      id: "open-note-review",
      name: tx("ui.command.open.noteReview", "Open note review"),
      callback: async () => plugin.openNoteReviewTab(),
    });
    plugin.addCommand({
      id: "open-exam-generator",
      name: tx("ui.command.open.tests", "Open Tests"),
      callback: async () => plugin.openExamGeneratorTab(),
    });
    plugin.addCommand({
      id: "open-coach",
      name: tx("ui.command.open.coach", "Open Coach"),
      callback: async () => plugin.openCoachTab(),
    });

    const flashcardCommands: Array<{ id: string; name: string; type: FlashcardType }> = [
      { id: "add-basic-flashcard", name: tx("ui.command.open.addBasicToNote", "Add basic flashcard to note"), type: "basic" },
      { id: "add-basic-reversed-flashcard", name: tx("ui.command.open.addBasicReversedToNote", "Add basic (reversed) flashcard to note"), type: "reversed" },
      { id: "add-cloze-flashcard", name: tx("ui.command.open.addClozeToNote", "Add cloze flashcard to note"), type: "cloze" },
      { id: "add-multiple-choice-flashcard", name: tx("ui.command.open.addMultipleChoiceToNote", "Add multiple choice flashcard to note"), type: "mcq" },
      { id: "add-ordered-question-flashcard", name: tx("ui.command.open.addOrderedQuestionToNote", "Add ordered question flashcard to note"), type: "oq" },
      { id: "add-hotspot-flashcard", name: tx("ui.command.open.addHotspotToNote", "Add hotspot flashcard to note"), type: "hq" },
      { id: "add-image-occlusion-flashcard", name: tx("ui.command.open.addImageOcclusionToNote", "Add image occlusion flashcard to note"), type: "io" },
    ];

    for (const command of flashcardCommands) {
      plugin.addCommand({
        id: command.id,
        name: command.name,
        callback: () => plugin.openAddFlashcardModal(command.type),
      });
    }

    plugin.addCommand({
      id: "import-anki",
      name: tx("ui.command.open.importAnki", "Import from Anki"),
      callback: async () => {
        const { AnkiImportModal } = await import("../modals/anki-import-modal");
        new AnkiImportModal(plugin).open();
      },
    });

    plugin.addCommand({
      id: "export-anki",
      name: tx("ui.command.open.exportAnki", "Export to Anki (.apkg)"),
      callback: async () => {
        const { AnkiExportModal } = await import("../modals/anki-export-modal");
        new AnkiExportModal(plugin).open();
      },
    });
  }

  static registerViews(plugin: LearnKitPlugin): void {
    plugin.registerView(VIEW_TYPE_REVIEWER, (leaf: WorkspaceLeaf) => new LearnKitReviewerView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_NOTE_REVIEW, (leaf: WorkspaceLeaf) => new LearnKitNoteReviewView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_WIDGET, (leaf: WorkspaceLeaf) => new LearnKitWidgetView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_STUDY_ASSISTANT, (leaf: WorkspaceLeaf) => new LearnKitStudyAssistantView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_BROWSER, (leaf: WorkspaceLeaf) => new LearnKitCardBrowserView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_ANALYTICS, (leaf: WorkspaceLeaf) => new LearnKitAnalyticsView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_HOME, (leaf: WorkspaceLeaf) => new LearnKitHomeView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_SETTINGS, (leaf: WorkspaceLeaf) => new LearnKitSettingsView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_EXAM_GENERATOR, (leaf: WorkspaceLeaf) => new LearnKitExamGeneratorView(leaf, plugin));
    plugin.registerView(VIEW_TYPE_COACH, (leaf: WorkspaceLeaf) => new LearnKitCoachView(leaf, plugin));

    // Legacy view-type aliases
    plugin.registerView(LEGACY_VIEW_TYPE_REVIEWER, (leaf: WorkspaceLeaf) => new LearnKitReviewerView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_WIDGET, (leaf: WorkspaceLeaf) => new LearnKitWidgetView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_STUDY_ASSISTANT, (leaf: WorkspaceLeaf) => new LearnKitStudyAssistantView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_BROWSER, (leaf: WorkspaceLeaf) => new LearnKitCardBrowserView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_ANALYTICS, (leaf: WorkspaceLeaf) => new LearnKitAnalyticsView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_HOME, (leaf: WorkspaceLeaf) => new LearnKitHomeView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_SETTINGS, (leaf: WorkspaceLeaf) => new LearnKitSettingsView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_EXAM_GENERATOR, (leaf: WorkspaceLeaf) => new LearnKitExamGeneratorView(leaf, plugin));
    plugin.registerView(LEGACY_VIEW_TYPE_COACH, (leaf: WorkspaceLeaf) => new LearnKitCoachView(leaf, plugin));
  }
}
