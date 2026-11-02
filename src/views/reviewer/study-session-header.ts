/**
 * @file src/reviewer/study-session-header.ts
 * @summary Creates and manages the persistent "Study Session" header with an auto-starting timer displayed at the top of the session view. The header is created once per session and survives across card re-renders, providing play/pause controls and elapsed-time display.
 *
 * @exports
 *   - TimerState — Interface describing the timer's running state, elapsed seconds, and interval handle
 *   - renderStudySessionHeader — Creates or retrieves the persistent study session header with timer controls
 */

import { setIcon } from "obsidian";
import { refreshAOS } from "../../platform/core/aos-loader";
import { queryFirst } from "../../platform/core/ui";
import { t } from "../../platform/translations/translator";
import { makeEl } from "../../platform/core/dom-factory";

export interface TimerState {
  timerRunning: boolean;
  elapsedSeconds: number;
  timerInterval: number | null;
}

export interface StudySessionHeaderOptions {
  titleToken?: string;
  titleFallback?: string;
}

const tx = (interfaceLanguage: string | undefined, token: string, fallback: string, vars?: Record<string, string | number>) =>
  t(interfaceLanguage, token, fallback, vars);

/**
 * Creates or retrieves the persistent study session header with timer.
 * This header is created once per session and persists across all card renders.
 */
export function renderStudySessionHeader(
  container: HTMLElement,
  interfaceLanguage?: string,
  applyAOS?: boolean,
  options?: StudySessionHeaderOptions,
): void {
  // Check if header already exists
  let studySessionHeader = queryFirst<HTMLElement>(container, "[data-study-session-header]");
  if (studySessionHeader) {
    if (!applyAOS) {
      studySessionHeader.removeAttribute("data-aos");
      studySessionHeader.removeAttribute("data-aos-delay");
      studySessionHeader.classList.remove("aos-init", "aos-animate");
      studySessionHeader.classList.add("learnkit-aos-reset", "learnkit-aos-reset");
    }
    return; // Already created, nothing to do
  }

  // ===== Create Study Session header =====
  studySessionHeader = makeEl("div");
  studySessionHeader.className = "flex items-baseline justify-between";
  studySessionHeader.setAttribute("data-study-session-header", "true");
  if (applyAOS) {
    studySessionHeader.setAttribute("data-aos", "fade-up");
    studySessionHeader.setAttribute("data-aos-delay", "0");
  }

  // Left column: title and timer stacked
  const leftColumn = makeEl("div");
  leftColumn.className = "flex flex-col lk-session-header-left";

  const studySessionLabel = makeEl("div");
  studySessionLabel.className = "text-xl font-semibold tracking-tight";
  studySessionLabel.textContent = tx(
    interfaceLanguage,
    options?.titleToken ?? "ui.reviewer.session.header.title",
    options?.titleFallback ?? "Study session",
  );
  leftColumn.appendChild(studySessionLabel);

  // Timer and controls
  const timerContainer = makeEl("div");
  timerContainer.className = "flex items-center gap-3";
  timerContainer.setAttribute("data-study-session-timer-row", "true");

  // Unified timer capsule widget
  const timerCapsule = makeEl("div");
  timerCapsule.className = "learnkit-timer-capsule lk-session-timer-group";
  timerCapsule.setAttribute("role", "group");
  timerCapsule.setAttribute("aria-label", tx(interfaceLanguage, "ui.reviewer.session.header.timerControls", "Timer controls"));

  const timerIconWrap = makeEl("span");
  timerIconWrap.className = "learnkit-timer-icon inline-flex items-center justify-center shrink-0";
  setIcon(timerIconWrap, "clock");
  queryFirst(timerIconWrap, "svg")?.classList.add("shrink-0");
  timerCapsule.appendChild(timerIconWrap);

  const timerText = makeEl("span");
  timerText.className = "truncate lk-session-timer-text learnkit-timer-digits";
  timerText.textContent = "00:00";
  timerCapsule.appendChild(timerText);

  const toggleBtn = makeEl("button");
  toggleBtn.type = "button";
  toggleBtn.tabIndex = -1;
  toggleBtn.className = "learnkit-timer-toggle-btn shrink-0";
  toggleBtn.setAttribute("aria-label", tx(interfaceLanguage, "ui.reviewer.session.header.pauseTooltip", "Pause timer"));

  const toggleIconWrap = makeEl("span");
  toggleIconWrap.className = "inline-flex items-center justify-center learnkit-timer-toggle-icon shrink-0";
  setIcon(toggleIconWrap, "pause");
  queryFirst(toggleIconWrap, "svg")?.classList.add("shrink-0");
  toggleBtn.appendChild(toggleIconWrap);
  timerCapsule.appendChild(toggleBtn);

  // Timer state - stored on the header element for persistence
  const timerState: TimerState = {
    timerRunning: true,
    elapsedSeconds: 0,
    timerInterval: null,
  };

  const updateTimerDisplay = () => {
    if (timerState.elapsedSeconds >= 3600) {
      const h = Math.floor(timerState.elapsedSeconds / 3600);
      const m = Math.floor((timerState.elapsedSeconds % 3600) / 60);
      const s = timerState.elapsedSeconds % 60;
      timerText.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    } else {
      const m = Math.floor(timerState.elapsedSeconds / 60);
      const s = timerState.elapsedSeconds % 60;
      timerText.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  };

  const syncToggleState = () => {
    while (toggleIconWrap.firstChild) {
      toggleIconWrap.removeChild(toggleIconWrap.firstChild);
    }
    if (timerState.timerRunning) {
      timerCapsule.classList.remove("is-paused");
      setIcon(toggleIconWrap, "pause");
      queryFirst(toggleIconWrap, "svg")?.classList.add("shrink-0");
      toggleBtn.setAttribute("aria-label", tx(interfaceLanguage, "ui.reviewer.session.header.pauseTooltip", "Pause timer"));
    } else {
      timerCapsule.classList.add("is-paused");
      setIcon(toggleIconWrap, "play");
      queryFirst(toggleIconWrap, "svg")?.classList.add("shrink-0");
      toggleBtn.setAttribute("aria-label", tx(interfaceLanguage, "ui.reviewer.session.header.playTooltip", "Start timer"));
    }
  };

  const startTimer = () => {
    if (timerState.timerInterval !== null) return;
    timerState.timerRunning = true;
    syncToggleState();
    const scheduleTimerTick = () => {
      timerState.timerInterval = window.setTimeout(() => {
        timerState.timerInterval = null;
        if (!timerState.timerRunning) return;
        timerState.elapsedSeconds++;
        updateTimerDisplay();
        scheduleTimerTick();
      }, 1000);
    };
    scheduleTimerTick();
  };

  const pauseTimer = () => {
    if (timerState.timerInterval !== null) {
      if (typeof window !== "undefined") {
        window.clearTimeout(timerState.timerInterval);
      } else {
        clearTimeout(timerState.timerInterval as unknown as number);
      }
      timerState.timerInterval = null;
    }
    timerState.timerRunning = false;
    syncToggleState();
  };

  const disposeTimer = () => {
    if (timerState.timerInterval !== null) {
      if (typeof window !== "undefined") {
        window.clearTimeout(timerState.timerInterval);
      } else {
        clearTimeout(timerState.timerInterval as unknown as number);
      }
      timerState.timerInterval = null;
    }
    timerState.timerRunning = false;
  };

  toggleBtn.addEventListener("click", () => {
    if (timerState.timerRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
    toggleBtn.blur();
  });

  toggleBtn.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  timerContainer.appendChild(timerCapsule);
  leftColumn.appendChild(timerContainer);
  studySessionHeader.appendChild(leftColumn);

  // Start timer automatically
  startTimer();

  // Dispose interval when header is removed from the DOM
  const removalObserver = new MutationObserver(() => {
    if (!studySessionHeader.isConnected) {
      disposeTimer();
      removalObserver.disconnect();
    }
  });
  const docBody = (typeof activeDocument !== "undefined" ? activeDocument : document)?.body;
  if (docBody) {
    removalObserver.observe(docBody, { childList: true, subtree: true });
  }

  // Append to container at the very beginning
  container.insertAdjacentElement("afterbegin", studySessionHeader);

  // Refresh AOS to detect the new animated elements
  if (applyAOS) {
    refreshAOS();
  }
}
