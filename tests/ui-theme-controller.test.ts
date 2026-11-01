// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { UiThemeController } from "../src/platform/plugin/ui-theme-controller";
import { DEFAULT_SETTINGS } from "../src/platform/core/constants";

describe("UiThemeController", () => {
  let mockCtx: any;
  let controller: UiThemeController;
  let settings: any;

  beforeEach(() => {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    mockCtx = {
      app: {
        workspace: {
          getMostRecentLeaf: vi.fn(),
          getLeavesOfType: vi.fn(() => []),
        },
      },
      getSettings: () => settings,
      saveSettings: vi.fn().mockResolvedValue(undefined),
      registerDomEvent: vi.fn(),
      registerEvent: vi.fn(),
      register: vi.fn(),
    };

    document.body.className = "";
    document.body.removeAttribute("data-learnkit-theme-preset");
    document.body.style.cssText = "";

    controller = new UiThemeController(mockCtx);
  });

  describe("zoom handling", () => {
    it("clamps zoom value between 0.8 and 1.8", () => {
      controller.applyLearnKitZoom(0.5);
      expect(controller.zoomValue).toBe(0.8);
      expect(document.body.style.getPropertyValue("--learnkit-leaf-zoom")).toBe("0.800");

      controller.applyLearnKitZoom(2.5);
      expect(controller.zoomValue).toBe(1.8);
      expect(document.body.style.getPropertyValue("--learnkit-leaf-zoom")).toBe("1.800");
    });

    it("removes --learnkit-leaf-zoom when zoom is 1.0 to avoid Chromium scaling artifacts", () => {
      controller.applyLearnKitZoom(1.2);
      expect(document.body.style.getPropertyValue("--learnkit-leaf-zoom")).toBe("1.200");

      controller.applyLearnKitZoom(1.0);
      expect(controller.zoomValue).toBe(1.0);
      expect(document.body.style.getPropertyValue("--learnkit-leaf-zoom")).toBe("");
    });

    it("debounces zoom saving", async () => {
      vi.useFakeTimers();
      controller.queueLearnKitZoomSave();
      expect(mockCtx.saveSettings).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(mockCtx.saveSettings).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });

  describe("theme & styling", () => {
    it("sets theme preset attribute on body", () => {
      settings.general.themePreset = "dark-glass";
      controller.applyLearnKitThemePreset();
      expect(document.body.getAttribute("data-learnkit-theme-preset")).toBe("dark-glass");
    });

    it("applies theme accent override when valid hex", () => {
      settings.general.themeAccentOverride = "#ff00aa";
      controller.applyLearnKitThemeAccentOverride();
      expect(document.body.style.getPropertyValue("--learnkit-theme-accent-override")).toBe("#ff00aa");
    });

    it("removes theme accent override when invalid hex", () => {
      settings.general.themeAccentOverride = "not-a-hex";
      controller.applyLearnKitThemeAccentOverride();
      expect(document.body.style.getPropertyValue("--learnkit-theme-accent-override")).toBe("");
    });
  });

  describe("status bar visibility", () => {
    it("toggles learnkit-hide-status-bar class", () => {
      const mockLeaf = {
        view: { getViewType: () => "learnkit-reviewer" },
      };
      controller.updateStatusBarVisibility(mockLeaf as any);
      expect(document.body.classList.contains("learnkit-hide-status-bar")).toBe(true);

      const normalLeaf = {
        view: { getViewType: () => "markdown" },
      };
      controller.updateStatusBarVisibility(normalLeaf as any);
      expect(document.body.classList.contains("learnkit-hide-status-bar")).toBe(false);
    });
  });
});
