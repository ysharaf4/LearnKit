/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { makeHeaderMenu } from "../src/views/reviewer/render-session";

describe("reviewer makeHeaderMenu Replay audio item", () => {
  it("renders Replay audio item with R hotkey when onReplayAudio is provided", () => {
    const onReplayAudio = vi.fn();
    const root = makeHeaderMenu({
      canUndo: false,
      onUndo: () => {},
      canSkip: false,
      onSkip: () => {},
      canBurySuspend: true,
      onBury: () => {},
      onSuspend: () => {},
      onExit: () => {},
      canReplayAudio: true,
      onReplayAudio,
    });
    document.body.appendChild(root);

    const trigger = root.querySelector("button");
    expect(trigger).not.toBeNull();

    // Open the menu
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));

    const popover = document.querySelector(".learnkit-session-more-popover");
    expect(popover).not.toBeNull();

    const items = Array.from(popover?.querySelectorAll("[role='menuitem']") ?? []);
    const replayItem = items.find((el) => el.textContent?.includes("Replay audio"));

    expect(replayItem).toBeDefined();
    expect(replayItem?.textContent).toContain("R");
    expect(replayItem?.getAttribute("aria-disabled")).toBeNull();

    // Trigger click
    replayItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onReplayAudio).toHaveBeenCalledOnce();
  });

  it("disables Replay audio when canReplayAudio is false", () => {
    const onReplayAudio = vi.fn();
    const root = makeHeaderMenu({
      canUndo: false,
      onUndo: () => {},
      canSkip: false,
      onSkip: () => {},
      canBurySuspend: false,
      onBury: () => {},
      onSuspend: () => {},
      onExit: () => {},
      canReplayAudio: false,
      onReplayAudio,
    });
    document.body.appendChild(root);

    const trigger = root.querySelector("button");
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));

    const popovers = Array.from(document.querySelectorAll(".learnkit-session-more-popover"));
    const latestPopover = popovers[popovers.length - 1];
    const items = Array.from(latestPopover?.querySelectorAll("[role='menuitem']") ?? []);
    const replayItem = items.find((el) => el.textContent?.includes("Replay audio"));

    expect(replayItem).toBeDefined();
    expect(replayItem?.getAttribute("aria-disabled")).toBe("true");
    expect(replayItem?.classList.contains("learnkit-menu-item--disabled")).toBe(true);
  });
});
