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

  it("renders with vertical column layout and popover overlay structure", () => {
    const root = makeHeaderMenu({
      canUndo: true,
      onUndo: () => {},
      canSkip: true,
      onSkip: () => {},
      canBurySuspend: true,
      onBury: () => {},
      onSuspend: () => {},
      onExit: () => {},
    });
    document.body.appendChild(root);

    const trigger = root.querySelector("button");
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));

    const overlay = document.querySelector(".learnkit-popover-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.classList.contains("learnkit")).toBe(true);
    expect(overlay?.classList.contains("is-open")).toBe(true);

    const panel = overlay?.querySelector(".learnkit-session-more-popover");
    expect(panel).not.toBeNull();
    expect(panel?.classList.contains("flex")).toBe(true);
    expect(panel?.classList.contains("flex-col")).toBe(true);

    const menu = panel?.querySelector("[role='menu']");
    expect(menu).not.toBeNull();
    expect(menu?.classList.contains("flex-col")).toBe(true);

    const items = Array.from(panel?.querySelectorAll("[role='menuitem']") ?? []);
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const item of items) {
      expect(item.classList.contains("learnkit-session-more-item")).toBe(true);
    }

    // Closing via Escape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".learnkit-popover-overlay")).toBeNull();
  });

  it("toggles open and closed when trigger is pressed", () => {
    const root = makeHeaderMenu({
      canUndo: false,
      onUndo: () => {},
      canSkip: false,
      onSkip: () => {},
      canBurySuspend: true,
      onBury: () => {},
      onSuspend: () => {},
      onExit: () => {},
    });
    document.body.appendChild(root);

    const trigger = root.querySelector("button");

    // Open
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    expect(document.querySelector(".learnkit-popover-overlay")).not.toBeNull();

    // Toggle close
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    expect(document.querySelector(".learnkit-popover-overlay")).toBeNull();
  });

  it("renders menu item icons and separator before exit action", () => {
    const root = makeHeaderMenu({
      canUndo: true,
      onUndo: () => {},
      canSkip: true,
      onSkip: () => {},
      canBurySuspend: true,
      onBury: () => {},
      onSuspend: () => {},
      onExit: () => {},
      canReplayAudio: true,
      onReplayAudio: () => {},
    });
    document.body.appendChild(root);

    const trigger = root.querySelector("button");
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));

    const popover = document.querySelector(".learnkit-session-more-popover");
    expect(popover).not.toBeNull();

    const separator = popover?.querySelector(".learnkit-menu-separator");
    expect(separator).not.toBeNull();

    const icons = Array.from(popover?.querySelectorAll(".learnkit-menu-item-icon") ?? []);
    expect(icons.length).toBeGreaterThanOrEqual(5);

    // Close
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
  });
});
