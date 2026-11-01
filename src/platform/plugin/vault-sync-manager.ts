/**
 * Vault Sync Manager
 *
 * Deep domain module responsible for orchestrating bidirectional note synchronization,
 * card parsing scan passes, settings and store disk persistence with serialization locking,
 * dedicated API key storage, and scheduling data resets.
 */

import { Notice, TFile, requestUrl, type App } from "obsidian";
import type LearnKitPlugin from "../../main";
import { DEFAULT_SETTINGS, type LearnKitSettings } from "../core/constants";
import { log } from "../core/logger";
import { clonePlain, isPlainObject } from "../core/utils";
import {
  normaliseApiKeys,
  normaliseTtsApiKeys,
  hasAnyApiKey,
  hasAnyTtsApiKey,
  persistApiKeysToDedicatedFile,
  persistTtsApiKeysToDedicatedFile,
} from "../core/settings-storage";
import { SqliteStore } from "../core/sqlite-store";
import { NoteReviewSqlite } from "../core/note-review-sqlite";
import { resetCardScheduling, type CardState } from "../../engine/scheduler/scheduler";
import { joinPath, safeStatMtime, createDataJsonBackupNow } from "../integrations/sync/backup";
import {
  formatSyncNotice,
  syncOneFile,
  syncQuestionBank,
  shouldSyncFile,
  type SyncNoticeCounts,
} from "../integrations/sync/sync-engine";
import {
  CURRENT_SYNC_PRIVILEGES_CHOICE_VERSION,
  requiresSyncPrivilegesChoice,
} from "../integrations/sync/sync-privileges";
import { ParseErrorModal } from "../modals/parse-error-modal";
import { formatCurrentNoteSyncNotice } from "../integrations/sync/sync-notices";
import { isAnchorLine } from "../../views/settings/settings-utils";
import { getFlagCacheForDataJson, flagCacheWasPersisted } from "../flags/flag-tokens";
import { parseCardsFromText } from "../../engine/parser/parser";
import { ConfirmSyncPrivilegesModal } from "../../views/settings/confirm-modals";
import type { IStore } from "../core/store-interface";

export interface AffectedCounts {
  totalWithCards: number;
  totalNeedingAnchors: number;
  totalNeedingUpdate: number;
}

export type SyncPrivilegeChoice = "full" | "simple-safe" | "simple-compat" | "off";

function resolveConfiguredSyncMode(priv: unknown): "full" | "simple-safe" | "simple-compat" {
  if (priv === "simple-safe") return "simple-safe";
  if (priv === "simple-compat" || priv === "simple") return "simple-compat";
  return "full";
}

export async function countAffectedFiles(
  app: App,
  settings: LearnKitSettings,
  plugin: LearnKitPlugin,
): Promise<AffectedCounts> {
  const vault = app.vault;
  const mdFiles = vault.getMarkdownFiles();
  const ignoreFences = settings.indexing.ignoreInCodeFences;

  let totalWithCards = 0;
  let totalNeedingAnchors = 0;
  let totalNeedingUpdate = 0;

  for (const file of mdFiles) {
    if (!shouldSyncFile(plugin, file)) continue;

    let text: string;
    try {
      text = await vault.cachedRead(file);
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    const { cards } = parseCardsFromText(file.path, text, ignoreFences);
    const anchorIds = new Set<string>();
    for (const ln of lines) {
      if (isAnchorLine(ln)) {
        const m = /^[\t >]*\^[a-z]+-(\d+)/.exec(ln.trim());
        if (m) anchorIds.add(m[1]);
      }
    }

    const hasCards = cards.length > 0 || anchorIds.size > 0;
    if (!hasCards) continue;

    totalWithCards += 1;

    const missingAnchor = cards.some((c) => !c.id || !anchorIds.has(String(c.id)));
    if (missingAnchor) totalNeedingAnchors += 1;

    totalNeedingUpdate += 1;
  }

  return { totalWithCards, totalNeedingAnchors, totalNeedingUpdate };
}

export interface VaultSyncPluginContext {
  app: App;
  manifest?: { id?: string };
  getSettings: () => LearnKitSettings;
  setSettings: (s: LearnKitSettings) => void;
  getStore: () => IStore;
  loadData: () => Promise<unknown>;
  saveData: (data: unknown) => Promise<void>;
  _tx: (token: string, fallback: string, vars?: Record<string, string | number>) => string;
  applyThemePreset: () => void;
  applyThemeAccent: () => void;
  normaliseSettingsInPlace: () => void;
  refreshOpenViews: () => void;
  notifyWidgetCardsSynced: () => void;
  getActiveMarkdownFile: () => TFile | null;
  asPlugin: LearnKitPlugin;
}

export class VaultSyncManager {
  private _saving: Promise<void> | null = null;

  constructor(private readonly ctx: VaultSyncPluginContext) {}

  get isSaving(): boolean {
    return this._saving !== null;
  }

  runSync = async (): Promise<void> => {
    const settings = this.ctx.getSettings();
    const priv = settings.general.syncPrivileges;
    const shouldPrompt =
      priv === undefined ||
      requiresSyncPrivilegesChoice(settings.general.syncPrivilegesChoiceVersion);

    if (shouldPrompt) {
      const counts = await countAffectedFiles(this.ctx.app, settings, this.ctx.asPlugin);
      const choice = await new Promise<"cancel" | SyncPrivilegeChoice>((resolve) => {
        new ConfirmSyncPrivilegesModal(this.ctx.app, this.ctx.asPlugin, counts, resolve).open();
      });
      if (choice === "cancel") return;
      settings.general.syncPrivileges = choice;
      settings.general.syncPrivilegesChoiceVersion = CURRENT_SYNC_PRIVILEGES_CHOICE_VERSION;
      await this.saveAll();
      if (choice === "off") {
        new Notice(
          this.ctx._tx(
            "ui.sync.notice.syncOff",
            "Sync is currently turned off. Update your preferences in Settings → User Details → Sync privileges to sync flashcards.",
          ),
        );
        return;
      }
      if (choice !== "full") {
        const res = await syncQuestionBank(this.ctx.asPlugin, { syncMode: choice });
        this.showSyncResult(res);
        return;
      }
    }

    const activePriv = settings.general.syncPrivileges;
    if (activePriv === "off") {
      new Notice(
        this.ctx._tx(
          "ui.sync.notice.syncOff",
          "Sync is currently turned off. Update your preferences in Settings → User Details → Sync privileges to sync flashcards.",
        ),
      );
      return;
    }

    if (resolveConfiguredSyncMode(activePriv) !== "full") {
      const res = await syncQuestionBank(this.ctx.asPlugin, {
        syncMode: resolveConfiguredSyncMode(activePriv),
      });
      this.showSyncResult(res);
      return;
    }

    const res = await syncQuestionBank(this.ctx.asPlugin);
    this.showSyncResult(res);
  };

  showSyncResult(res: SyncNoticeCounts & { quarantinedCount: number; quarantinedIds: string[] }): void {
    const notice = formatSyncNotice("Sync complete", res, { includeDeleted: true });
    new Notice(notice);

    const tagsDeleted = Number(res.tagsDeleted ?? 0);
    if (tagsDeleted > 0) {
      new Notice(
        this.ctx._tx("ui.main.notice.deletedUnusedTags", "Deleted {count}, unused tag{suffix}", {
          count: tagsDeleted,
          suffix: tagsDeleted === 1 ? "" : "s",
        }),
      );
    }

    if (res.quarantinedCount > 0) {
      new ParseErrorModal(this.ctx.app, this.ctx.asPlugin, res.quarantinedIds).open();
    }
    this.ctx.notifyWidgetCardsSynced();
  }

  formatCurrentNoteSyncNotice = (
    pageTitle: string,
    res: { newCount?: number; updatedCount?: number; removed?: number },
  ): string => {
    return formatCurrentNoteSyncNotice(pageTitle, res);
  };

  runSyncCurrentNote = async (): Promise<void> => {
    const file = this.ctx.getActiveMarkdownFile();
    if (!(file instanceof TFile)) {
      new Notice(this.ctx._tx("ui.sync.notice.noNoteOpen", "No note is open"));
      return;
    }

    const settings = this.ctx.getSettings();
    const priv = settings.general.syncPrivileges;
    const shouldPrompt =
      priv === undefined ||
      requiresSyncPrivilegesChoice(settings.general.syncPrivilegesChoiceVersion);

    if (shouldPrompt) {
      const counts = await countAffectedFiles(this.ctx.app, settings, this.ctx.asPlugin);
      const choice = await new Promise<"cancel" | SyncPrivilegeChoice>((resolve) => {
        new ConfirmSyncPrivilegesModal(this.ctx.app, this.ctx.asPlugin, counts, resolve).open();
      });
      if (choice === "cancel") return;
      settings.general.syncPrivileges = choice;
      settings.general.syncPrivilegesChoiceVersion = CURRENT_SYNC_PRIVILEGES_CHOICE_VERSION;
      await this.saveAll();
      if (choice === "off") {
        new Notice(
          this.ctx._tx(
            "ui.sync.notice.syncOff",
            "Sync is currently turned off. Update your preferences in Settings → User Details → Sync privileges to sync flashcards.",
          ),
        );
        return;
      }
      if (choice !== "full") {
        const res = await syncOneFile(this.ctx.asPlugin, file, {
          pruneGlobalOrphans: false,
          syncMode: choice,
        });
        new Notice(this.formatCurrentNoteSyncNotice(file.basename, res));
        if (res.quarantinedCount > 0) {
          new ParseErrorModal(this.ctx.app, this.ctx.asPlugin, res.quarantinedIds).open();
        }
        this.ctx.notifyWidgetCardsSynced();
        return;
      }
    }

    const activePriv = settings.general.syncPrivileges;
    if (activePriv === "off") {
      new Notice(
        this.ctx._tx(
          "ui.sync.notice.syncOff",
          "Sync is currently turned off. Update your preferences in Settings → User Details → Sync privileges to sync flashcards.",
        ),
      );
      return;
    }

    if (resolveConfiguredSyncMode(activePriv) !== "full") {
      const res = await syncOneFile(this.ctx.asPlugin, file, {
        pruneGlobalOrphans: false,
        syncMode: resolveConfiguredSyncMode(activePriv),
      });
      new Notice(this.formatCurrentNoteSyncNotice(file.basename, res));
      if (res.quarantinedCount > 0) {
        new ParseErrorModal(this.ctx.app, this.ctx.asPlugin, res.quarantinedIds).open();
      }
      this.ctx.notifyWidgetCardsSynced();
      return;
    }

    const res = await syncOneFile(this.ctx.asPlugin, file, { pruneGlobalOrphans: false });
    new Notice(this.formatCurrentNoteSyncNotice(file.basename, res));

    if (res.quarantinedCount > 0) {
      new ParseErrorModal(this.ctx.app, this.ctx.asPlugin, res.quarantinedIds).open();
    }

    this.ctx.notifyWidgetCardsSynced();
  };

  saveAll = async (): Promise<void> => {
    this.ctx.applyThemePreset();
    this.ctx.applyThemeAccent();
    while (this._saving) await this._saving;
    this._saving = this.doSave();
    try {
      await this._saving;
    } finally {
      this._saving = null;
    }
  };

  getDataJsonPath = (): string | null => {
    const configDir = this.ctx.app?.vault?.configDir;
    const pluginId = this.ctx.manifest?.id;
    if (!configDir || !pluginId) return null;
    return joinPath(configDir, "plugins", pluginId, "data.json");
  };

  getConfigDirPath = (): string | null => {
    const configDir = this.ctx.app?.vault?.configDir;
    const pluginId = this.ctx.manifest?.id;
    if (!configDir || !pluginId) return null;
    return joinPath(configDir, "plugins", pluginId, "configuration");
  };

  getConfigFilePath = (filename: string): string | null => {
    const dir = this.getConfigDirPath();
    return dir ? joinPath(dir, filename) : null;
  };

  getApiKeysFilePath = (): string | null => {
    return this.getConfigFilePath("api-keys.json");
  };

  getTtsApiKeysFilePath = (): string | null => {
    return this.getConfigFilePath("tts-api-keys.json");
  };

  doSave = async (): Promise<void> => {
    const settings = this.ctx.getSettings();
    const store = this.ctx.getStore();

    if (store instanceof SqliteStore) {
      const root: Record<string, unknown> = ((await this.ctx.loadData()) || {}) as Record<string, unknown>;

      settings.studyAssistant.apiKeys = normaliseApiKeys(settings.studyAssistant.apiKeys);
      const apiKeyWriteOk = await persistApiKeysToDedicatedFile({
        adapter: this.ctx.app?.vault?.adapter,
        dirPath: this.getConfigDirPath(),
        filePath: this.getApiKeysFilePath(),
        apiKeys: settings.studyAssistant.apiKeys,
      });

      settings.audio.ttsApiKeys = normaliseTtsApiKeys(settings.audio.ttsApiKeys);
      const ttsKeyWriteOk = await persistTtsApiKeysToDedicatedFile({
        adapter: this.ctx.app?.vault?.adapter,
        dirPath: this.getConfigDirPath(),
        filePath: this.getTtsApiKeysFilePath(),
        apiKeys: settings.audio.ttsApiKeys,
      });

      const syncSettings = clonePlain(settings) as Record<string, unknown>;
      if (isPlainObject(syncSettings.studyAssistant)) {
        syncSettings.studyAssistant.apiKeys = { ...DEFAULT_SETTINGS.studyAssistant.apiKeys };
      }
      if (isPlainObject(syncSettings.audio)) {
        syncSettings.audio.ttsApiKeys = { ...DEFAULT_SETTINGS.audio.ttsApiKeys };
      }

      if (!apiKeyWriteOk && hasAnyApiKey(settings.studyAssistant.apiKeys)) {
        log.error("Api key dedicated file write failed; keys were not persisted this save.");
        new Notice(
          this.ctx._tx("ui.sync.notice.keysSaveFailed", "Could not save keys securely. Check file permissions"),
          8000,
        );
      }

      if (!ttsKeyWriteOk && hasAnyTtsApiKey(settings.audio.ttsApiKeys)) {
        log.error("TTS api key dedicated file write failed; keys were not persisted this save.");
      }

      root.settings = syncSettings;
      delete root.store;
      delete root.versionTracking;

      const flagCache = getFlagCacheForDataJson();
      if (flagCache) root.flagCache = flagCache;

      await this.ctx.saveData(root);
      flagCacheWasPersisted();
      await store.persist();
      return;
    }

    const adapter = this.ctx.app?.vault?.adapter ?? null;
    const dataPath = this.getDataJsonPath();
    const canStat = !!(adapter && dataPath);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const mtimeBefore = canStat ? await safeStatMtime(adapter, dataPath) : 0;
      const root: Record<string, unknown> = ((await this.ctx.loadData()) || {}) as Record<string, unknown>;

      const diskStore = root?.store as Record<string, unknown> | undefined;
      const safety = store.assessPersistSafety(diskStore ?? null);

      if (!safety.allow) {
        log.warn(`_doSave: aborting - ${safety.reason}`);
        try {
          await createDataJsonBackupNow(this.ctx.asPlugin, "safety-before-empty-write");
        } catch {
          // best effort
        }
        return;
      }

      if (safety.backupFirst) {
        log.warn(`_doSave: ${safety.reason} Creating safety backup before writing.`);
        try {
          await createDataJsonBackupNow(this.ctx.asPlugin, "safety-regression");
        } catch {
          // best effort
        }
      }

      settings.studyAssistant.apiKeys = normaliseApiKeys(settings.studyAssistant.apiKeys);
      const apiKeyWriteOk = await persistApiKeysToDedicatedFile({
        adapter: this.ctx.app?.vault?.adapter,
        dirPath: this.getConfigDirPath(),
        filePath: this.getApiKeysFilePath(),
        apiKeys: settings.studyAssistant.apiKeys,
      });

      const syncSettings = clonePlain(settings) as Record<string, unknown>;
      if (isPlainObject(syncSettings.studyAssistant)) {
        syncSettings.studyAssistant.apiKeys = { ...DEFAULT_SETTINGS.studyAssistant.apiKeys };
      }
      if (!apiKeyWriteOk && hasAnyApiKey(settings.studyAssistant.apiKeys)) {
        log.error("Api key dedicated file write failed; keys were not persisted this save.");
        new Notice(
          this.ctx._tx("ui.sync.notice.keysSaveFailed", "Could not save keys securely. Check file permissions"),
          8000,
        );
      }

      root.settings = syncSettings;
      root.store = store.data;
      delete root.versionTracking;

      const flagCache2 = getFlagCacheForDataJson();
      if (flagCache2) root.flagCache = flagCache2;

      if (canStat) {
        const mtimeBeforeWrite = await safeStatMtime(adapter, dataPath);
        if (mtimeBefore && mtimeBeforeWrite && mtimeBeforeWrite !== mtimeBefore) {
          continue;
        }
      }

      await this.ctx.saveData(root);
      flagCacheWasPersisted();
      return;
    }

    const root: Record<string, unknown> = ((await this.ctx.loadData()) || {}) as Record<string, unknown>;
    settings.studyAssistant.apiKeys = normaliseApiKeys(settings.studyAssistant.apiKeys);
    const apiKeyWriteOk = await persistApiKeysToDedicatedFile({
      adapter: this.ctx.app?.vault?.adapter,
      dirPath: this.getConfigDirPath(),
      filePath: this.getApiKeysFilePath(),
      apiKeys: settings.studyAssistant.apiKeys,
    });
    const syncSettings = clonePlain(settings) as Record<string, unknown>;
    if (isPlainObject(syncSettings.studyAssistant)) {
      syncSettings.studyAssistant.apiKeys = { ...DEFAULT_SETTINGS.studyAssistant.apiKeys };
    }
    if (!apiKeyWriteOk && hasAnyApiKey(settings.studyAssistant.apiKeys)) {
      log.error("Api key dedicated file write failed; keys were not persisted this save.");
      new Notice(
        this.ctx._tx("ui.sync.notice.keysSaveFailed", "Could not save keys securely. Check file permissions"),
        8000,
      );
    }
    root.settings = syncSettings;
    root.store = store.data;
    delete root.versionTracking;

    const flagCache3 = getFlagCacheForDataJson();
    if (flagCache3) root.flagCache = flagCache3;

    await this.ctx.saveData(root);
    flagCacheWasPersisted();
  };

  refreshGithubStars = async (force = false): Promise<void> => {
    const s = this.ctx.getSettings();
    s.general ??= { ...DEFAULT_SETTINGS.general };
    s.general.githubStars ??= { count: null, fetchedAt: null };

    const lastAt = Number(s.general.githubStars.fetchedAt || 0);
    const staleMs = 6 * 60 * 60 * 1000;
    if (!force && lastAt && Date.now() - lastAt < staleMs) return;

    try {
      const res = await requestUrl({
        url: "https://api.github.com/repos/ctrlaltwill/learnkit",
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
      });
      const json: unknown = res?.json;
      const jsonObj = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
      const countRaw = jsonObj?.stargazers_count;
      const count = Number(countRaw);
      if (Number.isFinite(count)) {
        s.general.githubStars.count = count;
        s.general.githubStars.fetchedAt = Date.now();
        await this.saveAll();
        this.ctx.refreshOpenViews();
      }
    } catch {
      // offline or rate-limited; keep last known value
    }
  };

  resetSettingsToDefaults = async (): Promise<void> => {
    this.ctx.setSettings(clonePlain(DEFAULT_SETTINGS));
    this.ctx.normaliseSettingsInPlace();
    await this.saveAll();
    this.ctx.refreshOpenViews();
  };

  isCardStateLike = (v: unknown): v is CardState => {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;

    const stageOk =
      o.stage === "new" ||
      o.stage === "learning" ||
      o.stage === "review" ||
      o.stage === "relearning" ||
      o.stage === "suspended";

    if (!stageOk) return false;

    const numsOk =
      typeof o.due === "number" &&
      typeof o.scheduledDays === "number" &&
      typeof o.reps === "number" &&
      typeof o.lapses === "number" &&
      typeof o.learningStepIndex === "number";

    return numsOk;
  };

  resetAllCardScheduling = async (): Promise<void> => {
    const now = Date.now();
    let cardTotal = 0;

    const store = this.ctx.getStore();
    const states = store?.data?.states;
    if (states && typeof states === "object" && !Array.isArray(states)) {
      for (const [id, raw] of Object.entries(states as Record<string, unknown>)) {
        if (!this.isCardStateLike(raw)) continue;
        const prev: CardState = { id, ...(raw as Record<string, unknown>) } as CardState;
        (states as Record<string, unknown>)[id] = resetCardScheduling(prev, now);
        cardTotal++;
      }
    }

    await this.saveAll();
    const noteTotal = await this.clearAllNoteSchedulingState();
    this.ctx.refreshOpenViews();

    new Notice(
      this.ctx._tx(
        "ui.main.notice.resetScheduling",
        "Reset scheduling for {cardCount} cards and {noteCount} notes.",
        {
          cardCount: cardTotal,
          noteCount: noteTotal,
        },
      ),
    );
  };

  clearAllNoteSchedulingState = async (): Promise<number> => {
    const db = new NoteReviewSqlite(this.ctx.asPlugin);
    let total = 0;

    try {
      await db.open();
      total = db.clearAllNoteState();
      await db.persist();
    } finally {
      await db.close().catch((e: unknown) => log.swallow("close note review sqlite after reset", e));
    }

    return total;
  };

  resetAllNoteScheduling = async (): Promise<void> => {
    const total = await this.clearAllNoteSchedulingState();
    this.ctx.refreshOpenViews();
    new Notice(this.ctx._tx("ui.main.notice.resetNoteScheduling", "Reset scheduling for {count} notes.", { count: total }));
  };

  resetAllAnalyticsData = async (): Promise<void> => {
    const store = this.ctx.getStore();
    if (store.data.analytics) {
      store.data.analytics.events = [];
      store.data.analytics.seq = 0;
    }

    if (Array.isArray(store.data.reviewLog)) {
      store.data.reviewLog = [];
    }

    await this.saveAll();
    this.ctx.refreshOpenViews();

    new Notice(this.ctx._tx("ui.main.notice.analyticsCleared", "Analytics data cleared."));
  };
}
