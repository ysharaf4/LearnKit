// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultSyncManager } from "../src/platform/plugin/vault-sync-manager";
import { DEFAULT_SETTINGS } from "../src/platform/core/constants";

describe("VaultSyncManager", () => {
  let mockCtx: any;
  let syncManager: VaultSyncManager;
  let settings: any;
  let storeData: any;

  beforeEach(() => {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    storeData = {
      cards: [],
      states: {},
      analytics: { events: [{ id: 1 }], seq: 5 },
      reviewLog: [{ cardId: "1" }],
    };

    mockCtx = {
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: {
            exists: vi.fn().mockResolvedValue(true),
            write: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
      manifest: { id: "learnkit" },
      getSettings: () => settings,
      setSettings: (s: any) => { settings = s; },
      getStore: () => ({
        data: storeData,
        assessPersistSafety: vi.fn(() => ({ allow: true, reason: "" })),
        persist: vi.fn().mockResolvedValue(undefined),
      }),
      loadData: vi.fn().mockResolvedValue({ settings: {}, store: storeData }),
      saveData: vi.fn().mockResolvedValue(undefined),
      _tx: vi.fn((token: string, fallback: string) => fallback),
      applyThemePreset: vi.fn(),
      applyThemeAccent: vi.fn(),
      normaliseSettingsInPlace: vi.fn(),
      refreshOpenViews: vi.fn(),
      notifyWidgetCardsSynced: vi.fn(),
      getActiveMarkdownFile: vi.fn(() => null),
      asPlugin: {} as any,
    };

    syncManager = new VaultSyncManager(mockCtx);
  });

  describe("path helpers", () => {
    it("computes data and configuration file paths", () => {
      expect(syncManager.getDataJsonPath()).toBe(".obsidian/plugins/learnkit/data.json");
      expect(syncManager.getConfigDirPath()).toBe(".obsidian/plugins/learnkit/configuration");
      expect(syncManager.getApiKeysFilePath()).toBe(".obsidian/plugins/learnkit/configuration/api-keys.json");
      expect(syncManager.getTtsApiKeysFilePath()).toBe(".obsidian/plugins/learnkit/configuration/tts-api-keys.json");
    });
  });

  describe("saveAll serialization", () => {
    it("serializes concurrent save operations using the saving promise lock", async () => {
      let resolveFirst: any;
      const firstSavePromise = new Promise<void>((r) => { resolveFirst = r; });
      mockCtx.saveData.mockImplementationOnce(() => firstSavePromise);

      const p1 = syncManager.saveAll();
      const p2 = syncManager.saveAll();

      expect(mockCtx.applyThemePreset).toHaveBeenCalled();
      expect(mockCtx.applyThemeAccent).toHaveBeenCalled();

      resolveFirst();
      await Promise.all([p1, p2]);

      expect(mockCtx.saveData).toHaveBeenCalled();
    });
  });

  describe("data reset routines", () => {
    it("resets analytics and review log data", async () => {
      await syncManager.resetAllAnalyticsData();

      expect(storeData.analytics.events).toEqual([]);
      expect(storeData.analytics.seq).toBe(0);
      expect(storeData.reviewLog).toEqual([]);
      expect(mockCtx.refreshOpenViews).toHaveBeenCalled();
    });

    it("resets settings to default values", async () => {
      settings.general.defaultDeck = "custom-deck";
      await syncManager.resetSettingsToDefaults();

      expect(settings.general.defaultDeck).toBe(DEFAULT_SETTINGS.general.defaultDeck);
      expect(mockCtx.normaliseSettingsInPlace).toHaveBeenCalled();
      expect(mockCtx.refreshOpenViews).toHaveBeenCalled();
    });
  });
});
