/**
 * @file src/main.ts
 * @summary Plugin entry point and composition root that wires lifecycle,
 * collaborators, startup registration, and teardown.
 *
 * @exports
 *  - LearnKitPlugin
 *  - default LearnKitPlugin
 */

// Basecoat JS components (CSS is imported via styles.tailwind.css — Tailwind/PostCSS pipeline)
import "basecoat-css/basecoat";
import "basecoat-css/command";
import "basecoat-css/dropdown-menu";
import "basecoat-css/popover";
import "basecoat-css/select";
import "basecoat-css/sidebar";
import "basecoat-css/tabs";

import { Notice, Platform, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { LearnKitPluginBase } from "./platform/plugin/plugin-base";
import { PluginLifecycleManager } from "./platform/plugin/plugin-lifecycle";
import {
  VIEW_TYPE_REVIEWER,
  VIEW_TYPE_WIDGET,
  VIEW_TYPE_STUDY_ASSISTANT,
  VIEW_TYPE_BROWSER,
  VIEW_TYPE_ANALYTICS,
  VIEW_TYPE_HOME,
  VIEW_TYPE_SETTINGS,
  LEGACY_TO_CURRENT_VIEW_TYPES,
  BRAND,
  DEFAULT_SETTINGS,
  deepMerge,
  type LearnKitSettings,
} from "./platform/core/constants";
import { log } from "./platform/core/logger";
import { isPlainObject } from "./platform/core/utils";
import { registerReadingViewPrettyCards, teardownReadingView } from "./views/reading/reading-view";
import { editDecorationExtension } from "./views/study-assistant/editor/edit-decorations";
import { removeAosErrorHandler } from "./platform/core/aos-loader";
import { initMobileKeyboardHandler, cleanupMobileKeyboardHandler } from "./platform/core/mobile-keyboard-handler";
import { loadFlagCacheFromDataJson } from "./platform/flags/flag-tokens";
import { JsonStore } from "./platform/core/store";
import { SqliteStore, isSqliteDatabasePresent, reconcileAllDbsFromVaultSync } from "./platform/core/sqlite-store";
import { migrateJsonToSqlite } from "./platform/core/migration";
import { LearnKitReviewerView } from "./views/reviewer/review-view";
import { LearnKitWidgetView } from "./views/widget/view/widget-view";
import { LearnKitAssistantPopup } from "./views/study-assistant/popup/assistant-popup";
import { LearnKitCardBrowserView } from "./views/browser/card-browser-view";
import { LearnKitAnalyticsView } from "./views/analytics/analytics-view";
import { LearnKitHomeView } from "./views/home/home-view";
import { LearnKitSettingsTab } from "./views/settings/settings-tab";
import { LearnKitSettingsView } from "./views/settings/view/settings-view";
import { CoachPlanSqlite } from "./platform/core/coach-plan-sqlite";
import { syncQuestionBank } from "./platform/integrations/sync/sync-engine";
import { CardCreatorModal } from "./platform/modals/card-creator-modal";
import { ParseErrorModal } from "./platform/modals/parse-error-modal";
import { setDelimiter } from "./platform/core/delimiter";
import {
  initialiseDedicatedApiKeyStorage,
  initialiseDedicatedTtsApiKeyStorage,
  migrateLegacyConfigFiles,
} from "./platform/core/settings-storage";
import { ReminderEngine } from "./views/reminders/reminder-engine";
import { getTtsService } from "./platform/integrations/tts/tts-service";
import { getTtsCacheDirPath } from "./platform/integrations/tts/tts-cache";
import { setLocaleFileReader, loadLocaleBundlesAsync } from "./platform/translations/translator";

export class LearnKitPlugin extends LearnKitPluginBase {
  async onload(): Promise<void> {
    this.initCollaborators();

    try {
      this._initBasecoatRuntime();
      this._initButtonTooltipDefaults();
      initMobileKeyboardHandler();

      if (Platform.isPhone) activeDocument.body.classList.add("is-phone");
      if (Platform.isTablet) activeDocument.body.classList.add("is-tablet");

      // Drop any Guide dropdown portal stranded on <body> by a previous instance
      PluginLifecycleManager.sweepOrphanedBodyPortals();

      // Re-open the sidebar widget that the previous instance detached on unload
      PluginLifecycleManager.restoreWidgetAfterReload(this.app, () => this.openWidgetSafe());

      this._bc = {
        VIEW_TYPE_REVIEWER,
        VIEW_TYPE_WIDGET,
        VIEW_TYPE_BROWSER,
        VIEW_TYPE_ANALYTICS,
        VIEW_TYPE_HOME,
        VIEW_TYPE_SETTINGS,
        BRAND,
        DEFAULT_SETTINGS,
        deepMerge,
        LearnKitReviewerView,
        LearnKitWidgetView,
        LearnKitCardBrowserView,
        LearnKitAnalyticsView,
        LearnKitHomeView,
        LearnKitSettingsView,
        LearnKitSettingsTab,
        syncQuestionBank,
        CardCreatorModal,
        ParseErrorModal,
      };

      const root = (await this.loadData()) as unknown;
      const rootObj = isPlainObject(root) ? root : {};

      // Hydrate the flag cache from data.json
      loadFlagCacheFromDataJson(rootObj.flagCache);

      const rootSettings = isPlainObject(rootObj.settings)
        ? (rootObj.settings as Partial<LearnKitSettings>)
        : {};
      this.settings = deepMerge(DEFAULT_SETTINGS, rootSettings);

      await migrateLegacyConfigFiles({
        adapter: this.app?.vault?.adapter,
        getConfigFilePath: (filename: string) => this._getConfigFilePath(filename),
        settings: this.settings,
      });

      this._migrateSettingsInPlace();
      this._normaliseSettingsInPlace();
      this._applyLearnKitThemePreset();
      this._applyLearnKitThemeAccentOverride();

      await initialiseDedicatedApiKeyStorage({
        adapter: this.app?.vault?.adapter,
        dirPath: this._getConfigDirPath(),
        filePath: this._getApiKeysFilePath(),
        settings: this.settings,
      });

      await initialiseDedicatedTtsApiKeyStorage({
        adapter: this.app?.vault?.adapter,
        dirPath: this._getConfigDirPath(),
        filePath: this._getTtsApiKeysFilePath(),
        settings: this.settings,
      });

      // Wire vault adapter into TTS service for external provider caching
      {
        const tts = getTtsService();
        tts.vaultAdapter = this.app?.vault?.adapter ?? null;
        const configDir = this.app?.vault?.configDir;
        const pluginId = this.manifest?.id;
        if (configDir && pluginId) {
          tts.ttsCacheDirPath = getTtsCacheDirPath(configDir, pluginId);
        }
      }

      this._registerLearnKitPinchZoom();

      setDelimiter(this.settings.indexing.delimiter ?? "|");

      await reconcileAllDbsFromVaultSync(this);

      const hasSqlite = await isSqliteDatabasePresent(this);
      const hasLegacyStore = isPlainObject(rootObj.store);

      if (hasSqlite) {
        const sqliteStore = new SqliteStore(this);
        await sqliteStore.open();
        this.store = sqliteStore;
      } else if (hasLegacyStore) {
        const migratedToSqlite = await migrateJsonToSqlite(this, rootObj);
        if (migratedToSqlite) {
          const sqliteStore = new SqliteStore(this);
          await sqliteStore.open();
          this.store = sqliteStore;
        } else {
          this.store = new JsonStore(this);
          this.store.load(rootObj);
        }
      } else {
        const sqliteStore = new SqliteStore(this);
        await sqliteStore.open();
        this.store = sqliteStore;
      }

      this.ribbonReminder.setReminderEngine(new ReminderEngine(this));
      this._registerReminderDevConsoleCommands();
      this._registerStudyAssistantDevConsoleCommands();

      if (!(this.store instanceof SqliteStore) && !this.store.loadedFromDisk && isPlainObject(root)) {
        log.warn(
          "data.json existed but contained no .store - initial save will be guarded by assessPersistSafety.",
        );
      }

      registerReadingViewPrettyCards(this);

      // CM6 extension: inline diff decorations for AI-proposed note edits
      this.registerEditorExtension(editDecorationExtension);

      PluginLifecycleManager.registerViews(this);

      this._coachDb = new CoachPlanSqlite(this);
      await this._coachDb.open();

      this.addSettingTab(new LearnKitSettingsTab(this.app, this));

      PluginLifecycleManager.registerCommands(this);

      this._registerBrandIcons();
      this._registerRibbonIcons();
      this._registerEditorContextMenu();
      this._registerMarkdownSourceClozeShortcuts();

      this.registerEvent(
        this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {
          this._updateStatusBarVisibility(leaf ?? null);
          this._assistantPopup?.onActiveLeafChange();
        }),
      );

      this.registerEvent(
        this.app.workspace.on("file-open", (file: TFile | null) => {
          const f = file instanceof TFile ? file : null;
          this._assistantPopup?.onFileOpen(f);
          this.app.workspace
            .getLeavesOfType(VIEW_TYPE_WIDGET)
            .forEach((leaf: WorkspaceLeaf) => (leaf.view as { onFileOpen?(f: TFile | null): void })?.onFileOpen?.(f));
          this.app.workspace
            .getLeavesOfType(VIEW_TYPE_STUDY_ASSISTANT)
            .forEach((leaf: WorkspaceLeaf) => (leaf.view as { onFileOpen?(f: TFile | null): void })?.onFileOpen?.(f));
        }),
      );

      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          if (file instanceof TFile && file.path.toLowerCase().endsWith(".md")) {
            void this._assistantPopup?.onFileRename(oldPath, file);
          }
          if (file instanceof TFile || file instanceof TFolder) {
            void PluginLifecycleManager.retargetCardsAfterMove(this.store, oldPath, file.path);
          }
        }),
      );

      this.app.workspace.onLayoutReady(() => {
        void (async () => {
          for (const [legacyType, currentType] of Object.entries(LEGACY_TO_CURRENT_VIEW_TYPES)) {
            const leaves = this.app.workspace.getLeavesOfType(legacyType);
            for (const leaf of leaves) {
              try {
                const state = leaf.getViewState();
                await leaf.setViewState({ ...state, type: currentType, active: state.active });
              } catch (e) {
                log.swallow(`migrate legacy view type ${legacyType} -> ${currentType}`, e);
              }
            }
          }
        })();

        this._updateStatusBarVisibility(null);

        this._assistantPopup = new LearnKitAssistantPopup(this);
        this._assistantPopup.mount();
        this._assistantPopup.onActiveLeafChange();
        this.refreshAssistantPopupFromSettings();
        this._startMarkdownModeWatcher();

        this.ribbonReminder.reminderEngine?.start();
      });

      // Locale bundles preload
      {
        const adapter = this.app?.vault?.adapter;
        const configDir = this.app?.vault?.configDir;
        const pluginId = this.manifest?.id;
        if (adapter && configDir && pluginId) {
          setLocaleFileReader((path: string) => adapter.read(path));
          const pluginDir = `${configDir}/plugins/${pluginId}`;
          void loadLocaleBundlesAsync(pluginDir).catch((e: unknown) =>
            log.warn("Failed to preload community locales", e),
          );
        }
      }

      await this.saveAll();
      void this.refreshGithubStars();
      log.info("loaded");
    } catch (e) {
      log.error("failed to load", e);
      new Notice(this._tx("ui.main.notice.loadFailed", "LearnKit - failed to load"));
    }
  }

  onunload(): void {
    PluginLifecycleManager.detachLearnKitLeaves(this.app);

    const pending = this._saving ?? Promise.resolve();
    void pending
      .then(() => this._doSave())
      .catch((e: unknown) => log.swallow("save all on unload", e));

    if (this.store instanceof SqliteStore) {
      void this.store.close().catch((e: unknown) => log.swallow("close sqlite store", e));
    }
    if (this._coachDb) {
      void this._coachDb.close().catch((e: unknown) => log.swallow("close coach sqlite", e));
      this._coachDb = null;
    }

    this._bc = null;
    this._destroyRibbonIcons();
    activeDocument.body.classList.remove("learnkit-hide-status-bar");
    activeDocument.body.classList.remove("is-phone");
    activeDocument.body.style.removeProperty("--learnkit-theme-accent-override");
    activeDocument.body.style.removeProperty("--learnkit-leaf-zoom");

    this._unregisterReminderDevConsoleCommands();
    this._unregisterStudyAssistantDevConsoleCommands();
    this.ribbonReminder.reminderEngine?.stop();
    this.ribbonReminder.setReminderEngine(null);

    teardownReadingView();
    removeAosErrorHandler();
    cleanupMobileKeyboardHandler();

    this._assistantPopup?.destroy();
    this._assistantPopup = null;

    this._stopBasecoatRuntime();
  }
}

export default LearnKitPlugin;
