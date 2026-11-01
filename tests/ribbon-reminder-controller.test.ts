// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RibbonReminderController } from "../src/platform/plugin/ribbon-reminder-controller";

describe("RibbonReminderController", () => {
  let mockCtx: any;
  let controller: RibbonReminderController;
  let mockRibbonEl: HTMLElement;

  beforeEach(() => {
    mockRibbonEl = document.createElement("div");
    mockCtx = {
      addRibbonIcon: vi.fn((icon: string, title: string, cb: any) => {
        mockRibbonEl.onclick = cb;
        return mockRibbonEl;
      }),
      openHomeTab: vi.fn().mockResolvedValue(undefined),
      getPlugin: vi.fn(() => ({})),
    };

    controller = new RibbonReminderController(mockCtx);
  });

  afterEach(() => {
    controller.unregisterReminderDevConsoleCommands();
    controller.unregisterStudyAssistantDevConsoleCommands();
  });

  describe("ribbon icons", () => {
    it("registers brand ribbon icon and attaches click handler", () => {
      controller.registerRibbonIcons();
      expect(mockCtx.addRibbonIcon).toHaveBeenCalledTimes(1);

      mockRibbonEl.dispatchEvent(new MouseEvent("click", { ctrlKey: false }));
      expect(mockCtx.openHomeTab).toHaveBeenCalledWith(false);

      mockRibbonEl.dispatchEvent(new MouseEvent("click", { ctrlKey: true }));
      expect(mockCtx.openHomeTab).toHaveBeenCalledWith(true);
    });

    it("destroys previous ribbon elements when re-registering or destroying", () => {
      const removeSpy = vi.spyOn(mockRibbonEl, "remove");
      controller.registerRibbonIcons();
      controller.destroyRibbonIcons();
      expect(removeSpy).toHaveBeenCalled();
    });
  });

  describe("reminder engine", () => {
    it("delegates refresh to registered reminder engine", () => {
      const mockEngine = { refresh: vi.fn() };
      controller.setReminderEngine(mockEngine as any);
      controller.refreshReminderEngine();
      expect(mockEngine.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("dev console commands", () => {
    it("registers and cleans up window dev console hooks", () => {
      controller.registerReminderDevConsoleCommands();
      const win = window as any;
      expect(typeof win.learnKitReminderLaunch).toBe("function");
      expect(typeof win.learnKitReminderRoutine).toBe("function");
      expect(typeof win.learnKitReminderGatekeeper).toBe("function");

      controller.unregisterReminderDevConsoleCommands();
      expect(win.learnKitReminderLaunch).toBeUndefined();
      expect(win.learnKitReminderRoutine).toBeUndefined();
      expect(win.learnKitReminderGatekeeper).toBeUndefined();
    });
  });
});
