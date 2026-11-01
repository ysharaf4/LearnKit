// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginLifecycleManager } from "../src/platform/plugin/plugin-lifecycle";

describe("PluginLifecycleManager", () => {
  let mockApp: any;
  let mockPlugin: any;

  beforeEach(() => {
    mockApp = {
      workspace: {
        detachLeavesOfType: vi.fn(),
        getLeavesOfType: vi.fn(() => []),
        onLayoutReady: vi.fn((cb: any) => cb()),
      },
    };

    mockPlugin = {
      app: mockApp,
      manifest: { id: "learnkit" },
      store: {
        retargetSourceNotePath: vi.fn(() => 2),
        persist: vi.fn().mockResolvedValue(undefined),
      },
      _tx: vi.fn((token: string, fallback: string) => fallback),
      asPlugin: {} as any,
    };

    document.body.innerHTML = "";
  });

  describe("detachLearnKitLeaves", () => {
    it("detaches all active and legacy LearnKit views", () => {
      PluginLifecycleManager.detachLearnKitLeaves(mockApp);
      expect(mockApp.workspace.detachLeavesOfType).toHaveBeenCalled();
    });
  });

  describe("sweepOrphanedBodyPortals", () => {
    it("removes stranded guide navigation dropdown portals from body", () => {
      const portal = document.createElement("div");
      portal.className = "learnkit";
      const child = document.createElement("div");
      child.className = "learnkit-guide-nav-group";
      portal.appendChild(child);
      document.body.appendChild(portal);

      const regularEl = document.createElement("div");
      regularEl.className = "learnkit other-content";
      document.body.appendChild(regularEl);

      PluginLifecycleManager.sweepOrphanedBodyPortals();

      expect(document.body.contains(portal)).toBe(false);
      expect(document.body.contains(regularEl)).toBe(true);
    });
  });

  describe("retargetCardsAfterMove", () => {
    it("retargets source note paths and persists store", async () => {
      await PluginLifecycleManager.retargetCardsAfterMove(
        mockPlugin.store,
        "old/note.md",
        "new/note.md",
      );

      expect(mockPlugin.store.retargetSourceNotePath).toHaveBeenCalledWith(
        "old/note.md",
        "new/note.md",
      );
      expect(mockPlugin.store.persist).toHaveBeenCalled();
    });
  });
});
