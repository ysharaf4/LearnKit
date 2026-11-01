/**
 * Plugin Base & Composition Host
 *
 * Provides the base Obsidian Plugin extension and composition host for LearnKit.
 * Owns and coordinates deep collaborator modules: WorkspaceNavigator, VaultSyncManager,
 * UiThemeController, and RibbonReminderController.
 */

import {
  Plugin,
  Notice,
  TFile,
  MarkdownView,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";

import { DEFAULT_SETTINGS, type LearnKitSettings } from "../core/constants";
import type { IStore } from "../core/store-interface";
import type { FlashcardType } from "../core/utils";
import type { BasecoatApi } from "../core/basecoat";
import type { Scope } from "../../views/reviewer/types";
import type { ReminderEngine } from "../../views/reminders/reminder-engine";
import type { LearnKitAssistantPopup } from "../../views/study-assistant/popup/assistant-popup";
import type { CoachPlanSqlite } from "../core/coach-plan-sqlite";
import type { CardState } from "../../engine/scheduler/scheduler";
import type LearnKitPlugin from "../../main";
import { t } from "../translations/translator";
import { migrateSettingsInPlace } from "../../views/settings/config/settings-migration";
import { normaliseSettingsInPlace } from "../../views/settings/config/settings-normalisation";
import {
  applyClozeShortcutToEditor,
  registerEditorContextMenu,
  registerMarkdownSourceClozeShortcuts,
} from "../editor/flashcard-editor";
import { CardCreatorModal } from "../modals/card-creator-modal";
import { ImageOcclusionCreatorModal } from "../modals/image-occlusion-creator-modal";
import { WorkspaceNavigator } from "./workspace-navigator";
import { VaultSyncManager } from "./vault-sync-manager";
import { UiThemeController } from "./ui-theme-controller";
import { RibbonReminderController } from "./ribbon-reminder-controller";

export type Constructor<T = NonNullable<unknown>> = new (...args: any[]) => T;

export class LearnKitPluginBase extends Plugin {
  settings: LearnKitSettings = DEFAULT_SETTINGS;
  store!: IStore;
  _bc: unknown = null;
  isWideMode = false;
  readonly DEFAULT_SETTINGS: LearnKitSettings = DEFAULT_SETTINGS;

  navigator!: WorkspaceNavigator;
  syncManager!: VaultSyncManager;
  themeController!: UiThemeController;
  ribbonReminder!: RibbonReminderController;

  _assistantPopup: LearnKitAssistantPopup | null = null;
  _coachDb: CoachPlanSqlite | null = null;

  get asPlugin(): LearnKitPlugin {
    return this as unknown as LearnKitPlugin;
  }

  // ── Backward compatibility accessors ────────────────────────────────

  get _reminderEngine(): ReminderEngine | null {
    return this.ribbonReminder?.reminderEngine ?? null;
  }
  set _reminderEngine(engine: ReminderEngine | null) {
    if (this.ribbonReminder) this.ribbonReminder.setReminderEngine(engine);
  }

  get _learnkitZoomValue(): number {
    return this.themeController?.zoomValue ?? 1;
  }

  get _basecoatApi(): BasecoatApi | null {
    return this.themeController?.basecoatApi ?? null;
  }

  get _saving(): Promise<void> | null {
    return this.syncManager?.isSaving ? Promise.resolve() : null;
  }

  /**
   * Initializes all domain collaborator instances via composition.
   */
  protected initCollaborators(): void {
    this.navigator = new WorkspaceNavigator({
      app: this.app,
      manifest: this.manifest,
      _tx: (t, f, v) => this._tx(t, f, v),
      asPlugin: this.asPlugin,
    });

    this.themeController = new UiThemeController({
      app: this.app,
      getSettings: () => this.settings,
      saveSettings: () => this.saveAll(),
      registerDomEvent: (el: any, type: string, cb: any, opts?: any) =>
        this.registerDomEvent(el, type as any, cb, opts),
      registerEvent: this.registerEvent.bind(this),
      register: this.register.bind(this),
    });

    this.ribbonReminder = new RibbonReminderController({
      addRibbonIcon: this.addRibbonIcon.bind(this),
      openHomeTab: (forceNew) => this.openHomeTab(forceNew),
      getPlugin: () => this.asPlugin,
    });

    this.syncManager = new VaultSyncManager({
      app: this.app,
      manifest: this.manifest,
      getSettings: () => this.settings,
      setSettings: (s) => {
        this.settings = s;
      },
      getStore: () => this.store,
      loadData: () => this.loadData(),
      saveData: (data) => this.saveData(data),
      _tx: (t, f, v) => this._tx(t, f, v),
      applyThemePreset: () => this._applyLearnKitThemePreset(),
      applyThemeAccent: () => this._applyLearnKitThemeAccentOverride(),
      normaliseSettingsInPlace: () => this._normaliseSettingsInPlace(),
      refreshOpenViews: () => this._refreshOpenViews(),
      notifyWidgetCardsSynced: () => this.notifyWidgetCardsSynced(),
      getActiveMarkdownFile: () => this._getActiveMarkdownFile(),
      asPlugin: this.asPlugin,
    });
  }

  // ── Core facade methods ─────────────────────────────────────────────

  _addCommand(id: string, name: string, callback: () => void | Promise<void>): void {
    this.addCommand({ id, name, callback });
  }

  _tx(token: string, fallback: string, vars?: Record<string, string | number>): string {
    return t(this.settings?.general?.interfaceLanguage, token, fallback, vars);
  }

  refreshAssistantPopupFromSettings(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (this.settings?.studyAssistant?.enabled) {
      this._assistantPopup?.mount();
    }
    this._assistantPopup?.onActiveLeafChange();
    this._assistantPopup?.onFileOpen(activeFile);
    if (!this.settings?.studyAssistant?.enabled) {
      this._closeAllAssistantWidgetInstances();
    }
  }

  _migrateSettingsInPlace(): void {
    migrateSettingsInPlace(this.settings);
  }

  _normaliseSettingsInPlace(): void {
    normaliseSettingsInPlace(this.settings);
  }

  _getActiveMarkdownFile(): TFile | null {
    const f = this.app.workspace.getActiveFile();
    return f instanceof TFile ? f : null;
  }

  _ensureEditingNoteEditor(): { view: MarkdownView; editor: Editor } | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return null;
    return { view, editor: view.editor };
  }

  _applyClozeShortcutToEditor(editor: Editor, clozeIndex?: number): void {
    applyClozeShortcutToEditor(editor, clozeIndex);
  }

  _registerMarkdownSourceClozeShortcuts(): void {
    registerMarkdownSourceClozeShortcuts({
      app: this.app,
      registerDomEvent: (type, callback, options) => {
        this.registerDomEvent(activeDocument, type, callback, options);
      },
      applyClozeShortcut: (editor: Editor, clozeIndex: number) => {
        this._applyClozeShortcutToEditor(editor, clozeIndex);
      },
    });
  }

  openAddFlashcardModal(forcedType?: FlashcardType, selectedText?: string): void {
    const ok = this._ensureEditingNoteEditor();
    if (!ok) {
      new Notice(this._tx("ui.main.notice.mustEditNote", "Must be editing a note to add a flashcard"));
      return;
    }

    const normalizedSelectedText = String(selectedText ?? ok.editor.getSelection?.() ?? "").trim();

    if (forcedType === "io" || forcedType === "hq") {
      new ImageOcclusionCreatorModal(this.app, this.asPlugin, forcedType).open();
    } else {
      new CardCreatorModal(this.app, this.asPlugin, forcedType, normalizedSelectedText).open();
    }
  }

  _registerEditorContextMenu(): void {
    registerEditorContextMenu({
      app: this.app,
      registerEvent: this.registerEvent.bind(this),
      tx: this._tx.bind(this),
      openAddFlashcardModal: (forcedType?: FlashcardType, selectedText?: string) => {
        this.openAddFlashcardModal(forcedType, selectedText);
      },
    });
  }

  // ── Navigation Delegations ──────────────────────────────────────────

  openReviewerTab(forceNew = false): Promise<void> {
    return this.navigator.openReviewerTab(forceNew);
  }
  openNoteReviewTab(forceNew = false): Promise<void> {
    return this.navigator.openNoteReviewTab(forceNew);
  }
  openHomeTab(forceNew = false): Promise<void> {
    return this.navigator.openHomeTab(forceNew);
  }
  openBrowserTab(forceNew = false): Promise<void> {
    return this.navigator.openBrowserTab(forceNew);
  }
  openAnalyticsTab(forceNew = false): Promise<void> {
    return this.navigator.openAnalyticsTab(forceNew);
  }
  openSettingsTab(forceNew = false, targetTab?: string): Promise<void> {
    return this.navigator.openSettingsTab(forceNew, targetTab);
  }
  openExamGeneratorTab(forceNew = false): Promise<void> {
    return this.navigator.openExamGeneratorTab(forceNew);
  }
  openExamGeneratorTest(testId: string): Promise<void> {
    return this.navigator.openExamGeneratorTest(testId);
  }
  openExamGeneratorScope(scope: Scope): Promise<void> {
    return this.navigator.openExamGeneratorScope(scope);
  }
  openExamGeneratorScopes(scopes: Scope[], targetLeaf?: WorkspaceLeaf): Promise<void> {
    return this.navigator.openExamGeneratorScopes(scopes, targetLeaf);
  }
  openCoachTab(
    forceNew = false,
    options?: { suppressEntranceAos?: boolean; refresh?: boolean },
    targetLeaf?: WorkspaceLeaf,
  ): Promise<void> {
    return this.navigator.openCoachTab(forceNew, options, targetLeaf);
  }
  openReviewerScope(scope: Scope): Promise<void> {
    return this.navigator.openReviewerScope(scope);
  }
  openReviewerScopeWithOptions(
    scope: Scope,
    options: {
      ignoreDailyReviewLimit?: boolean;
      ignoreDailyNewLimit?: boolean;
      dueOnly?: boolean;
      includeNotDue?: boolean;
      targetCount?: number;
      practiceMode?: boolean;
      trackCoachProgress?: boolean;
    },
    targetLeaf?: WorkspaceLeaf,
  ): Promise<void> {
    return this.navigator.openReviewerScopeWithOptions(scope, options, targetLeaf);
  }
  openNoteReviewScope(scope: Scope): Promise<void> {
    return this.navigator.openNoteReviewScope(scope);
  }
  openNoteReviewScopeWithOptions(
    scope: Scope,
    options: {
      targetCount?: number;
      includeNotDue?: boolean;
      noScheduling?: boolean;
      trackCoachProgress?: boolean;
    },
    targetLeaf?: WorkspaceLeaf,
  ): Promise<void> {
    return this.navigator.openNoteReviewScopeWithOptions(scope, options, targetLeaf);
  }
  recordCoachProgressForScope(scope: Scope, kind: "flashcard" | "note", by = 1): Promise<void> {
    return this.navigator.recordCoachProgressForScope(scope, kind, by);
  }
  openPluginSettingsInObsidian(): void {
    this.navigator.openPluginSettingsInObsidian();
  }
  openWidgetSafe(): Promise<void> {
    return this.navigator.openWidgetSafe();
  }
  openWidget(): Promise<void> {
    return this.navigator.openWidget();
  }
  openAssistantWidgetSafe(): Promise<void> {
    return this.navigator.openAssistantWidgetSafe();
  }
  openAssistantWidget(): Promise<void> {
    return this.navigator.openAssistantWidget();
  }
  _openSingleTabView(viewType: string, forceNew = false): Promise<WorkspaceLeaf> {
    return this.navigator.openSingleTabView(viewType, forceNew);
  }
  _ensureSingleLeafOfType(viewType: string): WorkspaceLeaf | null {
    return this.navigator.ensureSingleLeafOfType(viewType);
  }
  _closeAllAssistantWidgetInstances(): void {
    this.navigator.closeAllAssistantWidgetInstances();
  }

  // ── Sync & Data Delegations ─────────────────────────────────────────

  _runSync = async (): Promise<void> => this.syncManager.runSync();
  syncBank = async (): Promise<void> => this.syncManager.runSync();
  _runSyncCurrentNote = async (): Promise<void> => this.syncManager.runSyncCurrentNote();
  saveAll = async (): Promise<void> => this.syncManager.saveAll();
  _doSave = async (): Promise<void> => this.syncManager.doSave();
  _getDataJsonPath = (): string | null => this.syncManager.getDataJsonPath();
  _getConfigDirPath = (): string | null => this.syncManager.getConfigDirPath();
  _getConfigFilePath = (filename: string): string | null => this.syncManager.getConfigFilePath(filename);
  _getApiKeysFilePath = (): string | null => this.syncManager.getApiKeysFilePath();
  _getTtsApiKeysFilePath = (): string | null => this.syncManager.getTtsApiKeysFilePath();
  refreshGithubStars = async (force?: boolean): Promise<void> => this.syncManager.refreshGithubStars(force);
  resetSettingsToDefaults = async (): Promise<void> => this.syncManager.resetSettingsToDefaults();
  resetAllCardScheduling = async (): Promise<void> => this.syncManager.resetAllCardScheduling();
  resetAllNoteScheduling = async (): Promise<void> => this.syncManager.resetAllNoteScheduling();
  _clearAllNoteSchedulingState = async (): Promise<number> => this.syncManager.clearAllNoteSchedulingState();
  resetAllAnalyticsData = async (): Promise<void> => this.syncManager.resetAllAnalyticsData();
  _isCardStateLike = (v: unknown): v is CardState => this.syncManager.isCardStateLike(v);
  _formatCurrentNoteSyncNotice = (
    pageTitle: string,
    res: { newCount?: number; updatedCount?: number; removed?: number },
  ): string => this.syncManager.formatCurrentNoteSyncNotice(pageTitle, res);

  // ── Theme & Viewport Delegations ────────────────────────────────────

  _initBasecoatRuntime(): void {
    this.themeController.initBasecoatRuntime();
  }
  _stopBasecoatRuntime(): void {
    this.themeController.stopBasecoatRuntime();
  }
  _applyLearnKitThemeAccentOverride(): void {
    this.themeController.applyLearnKitThemeAccentOverride();
  }
  _applyLearnKitThemePreset(): void {
    this.themeController.applyLearnKitThemePreset();
  }
  _applyLearnKitZoom(value: number): void {
    this.themeController.applyLearnKitZoom(value);
  }
  _queueLearnKitZoomSave(): void {
    this.themeController.queueLearnKitZoomSave();
  }
  _registerLearnKitPinchZoom(): void {
    this.themeController.registerLearnKitPinchZoom();
  }
  _updateStatusBarVisibility(leaf: WorkspaceLeaf | null): void {
    this.themeController.updateStatusBarVisibility(leaf);
  }
  _isActiveHiddenViewType(): boolean {
    return this.themeController.isActiveHiddenViewType();
  }
  refreshReadingViewMarkdownLeaves(activeOnly = false): Promise<void> {
    return this.themeController.refreshReadingViewMarkdownLeaves(activeOnly);
  }
  _scheduleReadingViewRefresh(delayMs = 90, options?: { activeOnly?: boolean }): void {
    this.themeController.scheduleReadingViewRefresh(delayMs, options);
  }
  _startMarkdownModeWatcher(): void {
    this.themeController.startMarkdownModeWatcher();
  }
  _refreshOpenViews(): void {
    this.themeController.refreshOpenViews();
  }
  refreshAllViews(): void {
    this.themeController.refreshOpenViews();
  }
  _initButtonTooltipDefaults(): void {
    this.themeController.initButtonTooltipDefaults();
  }

  notifyWidgetCardsSynced(): void {
    this.app.workspace.getLeavesOfType("learnkit-widget").forEach((leaf: WorkspaceLeaf) => {
      const view = leaf.view as { onCardsSynced?(): void; onRefresh?(): void };
      if (typeof view.onCardsSynced === "function") {
        view.onCardsSynced();
        return;
      }
      view.onRefresh?.();
    });
  }

  // ── Ribbon & Reminder Delegations ───────────────────────────────────

  refreshReminderEngine = (): void => {
    this.ribbonReminder.refreshReminderEngine();
  };
  _registerReminderDevConsoleCommands = (): void => {
    this.ribbonReminder.registerReminderDevConsoleCommands();
  };
  _unregisterReminderDevConsoleCommands = (): void => {
    this.ribbonReminder.unregisterReminderDevConsoleCommands();
  };
  _registerStudyAssistantDevConsoleCommands = (): void => {
    this.ribbonReminder.registerStudyAssistantDevConsoleCommands();
  };
  _unregisterStudyAssistantDevConsoleCommands = (): void => {
    this.ribbonReminder.unregisterStudyAssistantDevConsoleCommands();
  };
  _registerRibbonIcons = (): void => {
    this.ribbonReminder.registerRibbonIcons();
  };
  _destroyRibbonIcons(): void {
    this.ribbonReminder.destroyRibbonIcons();
  }
  _registerBrandIcons = (): void => {
    this.ribbonReminder.registerBrandIcons();
  };
}
