/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as uiModule from "../src/platform/core/ui";
import { makeDropdownMenu, makeColumnsDropdown } from "../src/views/browser/shared/browser-dropdowns";

async function flushFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe("browser dropdowns on tablet / iPad vs phone", () => {
  let placeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML = "";
    placeSpy = vi.spyOn(uiModule, "placePopover").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.className = "";
    document.body.innerHTML = "";
  });

  it("sets full specified width (not trigger width) on iPad / tablet", async () => {
    // iPad Obsidian environment
    document.body.classList.add("is-mobile", "is-tablet");

    const dd = makeDropdownMenu({
      label: "Filter by type",
      value: "all",
      options: [
        { v: "all", label: "All types" },
        { v: "basic", label: "Basic" },
        { v: "mcq", label: "Multiple choice" },
      ],
      onChange: () => {},
      widthPx: 260,
    });
    document.body.appendChild(dd.root);

    const trigger = dd.root.querySelector("button")!;
    // Simulate inline trigger button with small width (~95px)
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 195,
      top: 50,
      bottom: 84,
      width: 95,
      height: 34,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    // Open dropdown
    trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await flushFrame();

    expect(placeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 260,
        align: "left",
      }),
    );

    dd.dispose();
  });

  it("sets full 260px width for columns dropdown on iPad / tablet", async () => {
    document.body.classList.add("is-mobile", "is-tablet");

    const colsDd = makeColumnsDropdown(
      {
        label: "Columns",
        options: [
          { v: "id", label: "Card ID" },
          { v: "type", label: "Type" },
          { v: "info", label: "Extra information" },
        ],
        widthPx: 260,
      },
      {
        getVisibleCols: () => new Set(["id", "type"]),
        setVisibleCols: () => {},
        applyColumnVisibility: () => {},
      },
    );
    document.body.appendChild(colsDd.root);

    const trigger = colsDd.root.querySelector("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 200,
      right: 285,
      top: 50,
      bottom: 84,
      width: 85,
      height: 34,
      x: 200,
      y: 50,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await flushFrame();

    expect(placeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 260,
        align: "left",
      }),
    );

    colsDd.dispose();
  });

  it("matches trigger width on phone", async () => {
    // Phone environment
    document.body.classList.add("is-mobile", "is-phone");

    const dd = makeDropdownMenu({
      label: "Filter by type",
      value: "all",
      options: [
        { v: "all", label: "All types" },
      ],
      onChange: () => {},
      widthPx: 260,
    });
    document.body.appendChild(dd.root);

    const trigger = dd.root.querySelector("button")!;
    // On phone, trigger is 100% full width (e.g. 360px)
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 16,
      right: 376,
      top: 50,
      bottom: 84,
      width: 360,
      height: 34,
      x: 16,
      y: 50,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await flushFrame();

    expect(placeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 360,
      }),
    );

    dd.dispose();
  });

  it("aligns to right when popover would overflow right edge of viewport", async () => {
    document.body.classList.add("is-mobile", "is-tablet");

    const dd = makeDropdownMenu({
      label: "Columns",
      value: "all",
      options: [
        { v: "all", label: "All" },
      ],
      onChange: () => {},
      widthPx: 260,
    });
    document.body.appendChild(dd.root);

    // Mock viewport width as 768px (iPad portrait)
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 768 });

    const trigger = dd.root.querySelector("button")!;
    // Trigger is near right edge: left 600, width 85 (600 + 260 = 860 > 768)
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      left: 600,
      right: 685,
      top: 50,
      bottom: 84,
      width: 85,
      height: 34,
      x: 600,
      y: 50,
      toJSON: () => ({}),
    });

    trigger.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true }));
    await flushFrame();

    expect(placeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 260,
        align: "right",
      }),
    );

    dd.dispose();
  });
});
