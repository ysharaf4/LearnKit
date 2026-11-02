import { describe, expect, it } from "vitest";

import {
  NATIVE_ACTIVATION_SELECTOR,
  REVEAL_OR_NEXT_KEYS,
  REVIEWER_IMPLEMENTED_KEYS,
  isRevealOrNextKey,
  isSpaceKey,
  shouldDeferSpaceToNativeControl,
} from "../src/views/reviewer/key-actions";
import { getShortcutGroups } from "../src/platform/modals/keyboard-shortcuts-modal";

// ── isRevealOrNextKey (GitHub #215 / #208) ──────────────────────────────────

describe("isRevealOrNextKey", () => {
  it("accepts Enter in all its spellings", () => {
    expect(isRevealOrNextKey({ key: "Enter" })).toBe(true);
    expect(isRevealOrNextKey({ key: "Enter", code: "Enter" })).toBe(true);
    expect(isRevealOrNextKey({ code: "NumpadEnter" })).toBe(true);
  });

  it("accepts the space bar", () => {
    // Issue #215: "The spacebar doesn't reveal the answer, only the return/enter key does."
    expect(isRevealOrNextKey({ key: " " })).toBe(true);
    expect(isRevealOrNextKey({ key: " ", code: "Space" })).toBe(true);
    // Some layouts/IMEs report the code only.
    expect(isRevealOrNextKey({ code: "Space" })).toBe(true);
  });

  it("accepts ArrowRight", () => {
    // Issue #208: the shortcuts modal lists "→" alongside Enter and Space.
    expect(isRevealOrNextKey({ key: "ArrowRight" })).toBe(true);
  });

  it("rejects the keys that must not advance", () => {
    for (const key of ["ArrowLeft", "ArrowUp", "ArrowDown", "Escape", "a", "1", "Tab", "Backspace"]) {
      expect(isRevealOrNextKey({ key })).toBe(false);
    }
  });

  it("matches every key capsule the shortcuts modal advertises", () => {
    // "Enter" -> key "Enter"; "Space" -> key " "; "→" -> key "ArrowRight"
    const sampleFor: Record<string, { key: string }> = {
      Enter: { key: "Enter" },
      Space: { key: " " },
      "→": { key: "ArrowRight" },
    };
    for (const label of REVEAL_OR_NEXT_KEYS) {
      const sample = sampleFor[label];
      expect(sample, `no key sample for advertised shortcut "${label}"`).toBeDefined();
      expect(isRevealOrNextKey(sample), `advertised shortcut "${label}" is not implemented`).toBe(true);
    }
  });
});

// ── Space must not steal native button activation ───────────────────────────

describe("shouldDeferSpaceToNativeControl", () => {
  const insideButton = { closest: (sel: string) => (sel.includes("button") ? {} : null) };
  const insideDiv = { closest: () => null };

  it("defers when focus is inside a button (grade buttons, MCQ options, Skip)", () => {
    expect(shouldDeferSpaceToNativeControl({ key: " " }, insideButton)).toBe(true);
    expect(shouldDeferSpaceToNativeControl({ code: "Space" }, insideButton)).toBe(true);
  });

  it("does not defer for plain content", () => {
    expect(shouldDeferSpaceToNativeControl({ key: " " }, insideDiv)).toBe(false);
  });

  it("never defers Enter or ArrowRight", () => {
    expect(shouldDeferSpaceToNativeControl({ key: "Enter" }, insideButton)).toBe(false);
    expect(shouldDeferSpaceToNativeControl({ key: "ArrowRight" }, insideButton)).toBe(false);
  });

  it("tolerates missing targets and broken closest()", () => {
    expect(shouldDeferSpaceToNativeControl({ key: " " }, null)).toBe(false);
    expect(shouldDeferSpaceToNativeControl({ key: " " }, undefined)).toBe(false);
    expect(
      shouldDeferSpaceToNativeControl({ key: " " }, {
        closest: () => {
          throw new Error("boom");
        },
      }),
    ).toBe(false);
  });

  it("never defers Space when focus sits inside the timer controls", () => {
    const insideTimer = {
      closest: (sel: string) =>
        sel.includes("learnkit-timer-capsule") || sel.includes("learnkit-timer-toggle-btn") ? {} : null,
    };
    expect(shouldDeferSpaceToNativeControl({ key: " " }, insideTimer)).toBe(false);
  });

  it("covers the interactive roles the reviewer renders", () => {
    for (const sel of ["button", "[role='checkbox']", "[role='radio']", "a[href]", "summary"]) {
      expect(NATIVE_ACTIVATION_SELECTOR).toContain(sel);
    }
  });
});

describe("isSpaceKey", () => {
  it("recognises the space bar in either spelling", () => {
    expect(isSpaceKey({ key: " " })).toBe(true);
    expect(isSpaceKey({ code: "Space" })).toBe(true);
    expect(isSpaceKey({ key: "Enter" })).toBe(false);
  });
});

// ── Documentation parity (the regression guard for #208/#215) ───────────────

describe("shortcuts modal documents only implemented keys", () => {
  const documentedLabels = (locale: string) =>
    getShortcutGroups(locale)
      .flatMap((g) => g.shortcuts)
      .flatMap((s) => s.keys);

  it("lists every key the reviewer implements and nothing else", () => {
    const documented = new Set(documentedLabels("en"));
    for (const label of documented) {
      expect(
        REVIEWER_IMPLEMENTED_KEYS.includes(label),
        `shortcuts modal advertises "${label}" but the reviewer does not implement it`,
      ).toBe(true);
    }
  });

  it("documents reveal-or-next as Enter, Space and ArrowRight", () => {
    const reveal = getShortcutGroups("en")
      .flatMap((g) => g.shortcuts)
      .find((s) => s.keys.includes("Enter"));
    expect(reveal?.keys).toEqual(["Enter", "Space", "→"]);
  });
});
