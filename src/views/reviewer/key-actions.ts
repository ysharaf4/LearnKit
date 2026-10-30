/**
 * @file src/views/reviewer/key-actions.ts
 * @summary Keyboard contract for study sessions.
 *
 * The reviewer used to implement only the Enter key for "Reveal or next" while the
 * Keyboard Shortcuts modal (and the sidebar widget) advertised Enter **plus** Space
 * and →. That mismatch is GitHub issues #208 and #215.
 *
 * This module is the single source of truth for those keys so the handler and the
 * documented shortcut list cannot drift apart again. Keep it dependency-free:
 * everything here is pure and unit-tested.
 *
 * @exports
 *   - REVEAL_OR_NEXT_KEYS — the documented key capsules (Enter, Space, →)
 *   - isRevealOrNextKey   — true for Enter / Space / ArrowRight
 *   - isSpaceKey          — true for Space (either `key` or `code` spelling)
 *   - NATIVE_ACTIVATION_SELECTOR — elements where Space must keep its native meaning
 *   - shouldDeferSpaceToNativeControl — true when Space must not be hijacked
 */

/**
 * Keys advertised in the Keyboard Shortcuts modal as "Reveal or next".
 * Rendered as `<kbd>` capsules, so these are display labels.
 */
export const REVEAL_OR_NEXT_KEYS: readonly string[] = ["Enter", "Space", "→"];

/**
 * Display labels for the keys the *reviewer* keyboard handler actually implements.
 * Used by the shortcuts modal + a parity test so the documented list and the code
 * cannot drift apart again (GitHub #208/#215).
 */
export const REVIEWER_IMPLEMENTED_KEYS: readonly string[] = [
  "Enter",
  "Space",
  "→",
  "←",
  "Q",
  "T",
  "1–4",
  "E",
  "B",
  "S",
  "U",
  "M",
  "O",
  "R",
  "Esc",
];

/** Minimal shape of a keyboard event we care about (keeps this module pure). */
export type KeyLike = {
  key?: string;
  code?: string;
};

/** True when the event is the space bar, in either `key` or `code` form. */
export function isSpaceKey(ev: KeyLike): boolean {
  return ev.key === " " || ev.key === "Spacebar" || ev.code === "Space";
}

/**
 * True for every key documented as "Reveal or next": Enter (incl. numpad), Space
 * and ArrowRight. This mirrors `resolveWidgetKeyAction` in the sidebar widget,
 * which has always accepted all three.
 */
export function isRevealOrNextKey(ev: KeyLike): boolean {
  const key = ev.key ?? "";
  return (
    key === "Enter" ||
    ev.code === "Enter" ||
    ev.code === "NumpadEnter" ||
    isSpaceKey(ev) ||
    key === "ArrowRight"
  );
}

/**
 * Elements where Space has a meaningful native behaviour that must win over
 * "reveal or next": activating buttons/links, toggling checkboxes and radios,
 * and expanding details. Keyboard users reach these with Tab, and Space is how
 * they activate them — hijacking it would break the MCQ option buttons, the
 * grade buttons and the Skip button.
 */
export const NATIVE_ACTIVATION_SELECTOR = [
  "button",
  "[role='button']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='option']",
  "[role='tab']",
  "a[href]",
  "summary",
  "label",
].join(", ");

/** Structural subset of Element used by {@link shouldDeferSpaceToNativeControl}. */
export type ClosestLike = {
  closest?: (selector: string) => unknown;
};

/**
 * Decides whether a Space press should be left to the browser instead of being
 * treated as "reveal or next".
 *
 * Returns true only when the event is Space AND the focus sits inside an
 * interactive control. Enter is intentionally *not* covered here — it already
 * behaves this way today and changing it is out of scope.
 */
export function shouldDeferSpaceToNativeControl(
  ev: KeyLike,
  target: ClosestLike | null | undefined,
): boolean {
  if (!isSpaceKey(ev)) return false;
  if (!target || typeof target.closest !== "function") return false;
  try {
    return !!target.closest(NATIVE_ACTIVATION_SELECTOR);
  } catch {
    return false;
  }
}
