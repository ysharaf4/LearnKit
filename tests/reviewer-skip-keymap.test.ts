import { describe, expect, it } from "vitest";
import {
  REVIEWER_IMPLEMENTED_KEYS,
  isRevealOrNextKey,
} from "../src/views/reviewer/key-actions";

describe("reviewer skip keymap contract", () => {
  it("includes Esc in implemented reviewer keys", () => {
    expect(REVIEWER_IMPLEMENTED_KEYS).toContain("Esc");
  });

  it("does not treat Escape as advance or reveal key", () => {
    expect(isRevealOrNextKey({ key: "Escape" })).toBe(false);
    expect(isRevealOrNextKey({ code: "Escape" })).toBe(false);
  });

  it("still recognises Enter and Space as advance keys", () => {
    expect(isRevealOrNextKey({ key: "Enter" })).toBe(true);
    expect(isRevealOrNextKey({ key: " " })).toBe(true);
    expect(isRevealOrNextKey({ key: "ArrowRight" })).toBe(true);
  });
});

