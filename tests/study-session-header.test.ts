// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderStudySessionHeader } from "../src/views/reviewer/study-session-header";

describe("study-session-header unified timer capsule", () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders unified timer capsule with data-study-session-timer-row", () => {
    renderStudySessionHeader(container, "en");

    const timerRow = container.querySelector("[data-study-session-timer-row='true']");
    expect(timerRow).not.toBeNull();

    const capsule = timerRow?.querySelector(".learnkit-timer-capsule");
    expect(capsule).not.toBeNull();

    const digits = capsule?.querySelector(".learnkit-timer-digits");
    expect(digits).not.toBeNull();
    expect(digits?.textContent).toBe("00:00");

    const toggleBtn = capsule?.querySelector(".learnkit-timer-toggle-btn");
    expect(toggleBtn).not.toBeNull();
  });

  it("increments time while running and pauses/resumes on toggle click", () => {
    renderStudySessionHeader(container, "en");

    const capsule = container.querySelector(".learnkit-timer-capsule");
    const digits = capsule?.querySelector(".learnkit-timer-digits");
    const toggleBtn = capsule?.querySelector<HTMLButtonElement>(".learnkit-timer-toggle-btn");

    expect(digits?.textContent).toBe("00:00");
    expect(capsule?.classList.contains("is-paused")).toBe(false);

    // Advance 5 seconds
    vi.advanceTimersByTime(5000);
    expect(digits?.textContent).toBe("00:05");

    // Click toggle button to pause
    toggleBtn?.click();
    expect(capsule?.classList.contains("is-paused")).toBe(true);

    // Advance 5 more seconds - should not increment
    vi.advanceTimersByTime(5000);
    expect(digits?.textContent).toBe("00:05");

    // Click toggle button to resume
    toggleBtn?.click();
    expect(capsule?.classList.contains("is-paused")).toBe(false);

    // Advance 3 more seconds
    vi.advanceTimersByTime(3000);
    expect(digits?.textContent).toBe("00:08");
  });

  it("sets tabIndex -1 on toggle button and suppresses Space key event", () => {
    renderStudySessionHeader(container, "en");

    const toggleBtn = container.querySelector<HTMLButtonElement>(".learnkit-timer-toggle-btn");
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn?.tabIndex).toBe(-1);

    const blurSpy = vi.spyOn(toggleBtn!, "blur");
    toggleBtn?.click();
    expect(blurSpy).toHaveBeenCalled();

    // Space keydown event on toggleBtn should be defaultPrevented
    const spaceEv = new KeyboardEvent("keydown", { key: " ", code: "Space", cancelable: true });
    toggleBtn?.dispatchEvent(spaceEv);
    expect(spaceEv.defaultPrevented).toBe(true);
  });
});
