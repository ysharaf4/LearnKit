// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceNavigator } from "../src/platform/plugin/workspace-navigator";
import {
  VIEW_TYPE_REVIEWER,
  VIEW_TYPE_NOTE_REVIEW,
  VIEW_TYPE_HOME,
  VIEW_TYPE_SETTINGS,
  VIEW_TYPE_WIDGET,
  VIEW_TYPE_STUDY_ASSISTANT,
} from "../src/platform/core/constants";

describe("WorkspaceNavigator", () => {
  let mockApp: any;
  let mockPlugin: any;
  let navigator: WorkspaceNavigator;

  beforeEach(() => {
    const leavesByType = new Map<string, any[]>();

    mockApp = {
      workspace: {
        getLeavesOfType: vi.fn((type: string) => leavesByType.get(type) || []),
        revealLeaf: vi.fn().mockResolvedValue(undefined),
        getLeaf: vi.fn((typeOrBool: any) => {
          const newLeaf = {
            view: {
              setReturnToCoach: vi.fn(),
              setCoachScope: vi.fn(),
              setIgnoreDailyReviewLimit: vi.fn(),
              navigateToTab: vi.fn(),
            },
            setViewState: vi.fn().mockResolvedValue(undefined),
            detach: vi.fn(),
          };
          return newLeaf;
        }),
        getRightLeaf: vi.fn((split: boolean) => {
          return {
            setViewState: vi.fn().mockResolvedValue(undefined),
            detach: vi.fn(),
          };
        }),
        setActiveLeaf: vi.fn(),
        getGroup: vi.fn(() => ({ index: 0 })),
        moveLeaf: vi.fn(),
      },
      setting: {
        open: vi.fn(),
        openTabById: vi.fn(),
      },
    };

    mockPlugin = {
      app: mockApp,
      manifest: { id: "learnkit" },
      _tx: vi.fn((token: string, fallback: string) => fallback),
      asPlugin: {} as any,
    };

    navigator = new WorkspaceNavigator(mockPlugin);
  });

  describe("ensureSingleLeafOfType", () => {
    it("returns null when no leaves of the type exist", () => {
      mockApp.workspace.getLeavesOfType.mockReturnValue([]);
      expect(navigator.ensureSingleLeafOfType("test-view")).toBeNull();
    });

    it("keeps the first leaf and detaches extra leaves when multiple exist", () => {
      const leaf1 = { detach: vi.fn() };
      const leaf2 = { detach: vi.fn() };
      const leaf3 = { detach: vi.fn() };
      mockApp.workspace.getLeavesOfType.mockReturnValue([leaf1, leaf2, leaf3]);

      const result = navigator.ensureSingleLeafOfType("test-view");
      expect(result).toBe(leaf1);
      expect(leaf1.detach).not.toHaveBeenCalled();
      expect(leaf2.detach).toHaveBeenCalled();
      expect(leaf3.detach).toHaveBeenCalled();
    });
  });

  describe("closeAllAssistantWidgetInstances", () => {
    it("detaches all leaves of VIEW_TYPE_STUDY_ASSISTANT", () => {
      const leaf1 = { detach: vi.fn() };
      const leaf2 = { detach: vi.fn() };
      mockApp.workspace.getLeavesOfType.mockImplementation((type: string) => {
        if (type === VIEW_TYPE_STUDY_ASSISTANT) return [leaf1, leaf2];
        return [];
      });

      navigator.closeAllAssistantWidgetInstances();
      expect(leaf1.detach).toHaveBeenCalled();
      expect(leaf2.detach).toHaveBeenCalled();
    });
  });

  describe("openSingleTabView", () => {
    it("reveals existing leaf when forceNew is false", async () => {
      const existing = {
        detach: vi.fn(),
        view: {},
      };
      mockApp.workspace.getLeavesOfType.mockReturnValue([existing]);

      const leaf = await navigator.openSingleTabView(VIEW_TYPE_REVIEWER, false);
      expect(leaf).toBe(existing);
      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(existing);
      expect(mockApp.workspace.getLeaf).not.toHaveBeenCalled();
    });

    it("creates and activates a new tab when forceNew is true", async () => {
      const existing = { detach: vi.fn() };
      mockApp.workspace.getLeavesOfType.mockReturnValue([existing]);

      const leaf = await navigator.openSingleTabView(VIEW_TYPE_REVIEWER, true);
      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
      expect(leaf.setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE_REVIEWER, active: true });
      expect(mockApp.workspace.revealLeaf).toHaveBeenCalledWith(leaf);
    });
  });

  describe("view opening methods", () => {
    it("opens reviewer tab and resets returnToCoach", async () => {
      await navigator.openReviewerTab(false);
      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
    });

    it("opens note review tab and clears coach scope", async () => {
      await navigator.openNoteReviewTab(false);
      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
    });

    it("opens settings tab and applies target tab", async () => {
      await navigator.openSettingsTab(false, "scheduler");
      expect(mockApp.workspace.getLeaf).toHaveBeenCalledWith("tab");
    });

    it("opens widget in right sidebar", async () => {
      await navigator.openWidget();
      expect(mockApp.workspace.getRightLeaf).toHaveBeenCalled();
      expect(mockApp.workspace.revealLeaf).toHaveBeenCalled();
    });
  });
});
