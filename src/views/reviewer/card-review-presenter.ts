/**
 * @file src/views/reviewer/card-review-presenter.ts
 * @summary Deep presenter module encapsulating active study session DOM construction,
 *   interaction state (answer reveals, MCQ/OQ selections, audio playback bindings),
 *   rating transitions, keyboard action execution, and header/footer study controls.
 *
 * @exports
 *   - CardReviewPresenter        — Deep presenter class driving active flashcard study
 *   - CardReviewPresenterOptions — Configuration and lifecycle hooks for the presenter
 *   - makeHeaderMenu             — Dropdown menu component for reviewer header actions
 *   - renderSessionMode          — Compatibility adapter for existing callers
 */

import { setIcon, type App } from "obsidian";
import { refreshAOS } from "../../platform/core/aos-loader";
import { log } from "../../platform/core/logger";
import { createOqReorderPreviewController } from "../../platform/core/oq-reorder-preview";
import { setCssProps, queryFirst } from "../../platform/core/ui";
import { applyInlineMarkdown } from "../../platform/integrations/anki/anki-mapper";
import {
  bindAudioPlayingState as bindTtsPlayingState,
  markAudioButtonActive as markTtsButtonActive,
  clearActiveAudioButton as clearActiveTtsButton,
  isVaultAudioPlaying,
  stopActiveVaultAudio,
} from "../../platform/integrations/audio/audio-player";
import { renderStudySessionHeader } from "./study-session-header";
import type { Scope, Session, Rating } from "./types";
import type { CardRecord } from "../../platform/core/store";
import { normalizeCardOptions } from "../../platform/core/store";
import { getCorrectIndices, isMultiAnswerMcq } from "../../platform/types/card";
import { renderClozeFront, type ClozeRenderOptions } from "./question-cloze";
import { openCardAnchorInNote } from "../../platform/core/open-card-anchor";
import {
  convertInlineDisplayMath,
  forceSingleLineDisplayMathInline,
  escapeAngleBracketsOutsideMathAndCode,
} from "../../platform/core/shared-utils";
import { hydrateCircleFlagsInElement, processCircleFlagsInMarkdown } from "../../platform/flags/flag-tokens";
import { t } from "../../platform/translations/translator";
import { getRatingIntervalPreview } from "../../platform/core/grade-intervals";
import type { CardState, SchedulerSettings } from "../../platform/types/scheduler";
import { makeEl } from "../../platform/core/dom-factory";
import { StudySession } from "../../engine/study-session/study-session";
import type LearnKitPlugin from "../../main";

export interface CardReviewPresenterOptions {
  container: HTMLElement;
  session: StudySession | Session;
  plugin?: LearnKitPlugin;
  app?: App;
  interfaceLanguage?: string;
  fourButtonMode?: boolean;
  showGradeIntervals?: boolean;
  schedulingSettings?: SchedulerSettings;
  enableSkipButton?: boolean;
  practiceMode?: boolean;
  applyAOS?: boolean;
  aosDelayMs?: number;
  randomizeMcqOptions?: boolean;
  randomizeOqOrder?: boolean;
  showInfoByDefault?: boolean;
  clozeMode?: "standard" | "blank" | "typed";
  clozeBgColor?: string;
  clozeTextColor?: string;

  // IO and Markdown rendering delegates
  renderMarkdownInto?: (containerEl: HTMLElement, md: string, sourcePath: string) => Promise<void>;
  renderImageOcclusionInto?: (
    containerEl: HTMLElement,
    card: CardRecord,
    sourcePath: string,
    reveal: boolean,
  ) => Promise<void>;
  getCardStateForPreview?: (cardId: string, now: number) => CardState | null;

  // Audio / TTS
  ttsEnabled?: boolean;
  ttsReplayFront?: () => void;
  ttsReplayBack?: () => void;

  // Legacy compatibility hooks
  initialShowAnswer?: boolean;
  setShowAnswer?: (v: boolean) => void;
  rerender?: () => void;
  currentCard?: () => CardRecord | null;
  gradeCurrentRating?: (rating: Rating, meta?: Record<string, unknown> | null) => Promise<void>;
  nextCard?: (userInitiated: boolean) => Promise<void> | void;

  // Coarse view navigation hooks
  onComplete?: () => void;
  onBackToDecks?: () => void;
  onEditCard?: (card: CardRecord) => void;
  onOpenNote?: (sourcePath: string) => void;
  onStartPractice?: () => void;
  onCardRendered?: (card: CardRecord | null, isRevealed: boolean) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyInlineMarkdownWithFlags(target: HTMLElement, raw: string): void {
  applyInlineMarkdown(target, processCircleFlagsInMarkdown(raw));
  hydrateCircleFlagsInElement(target);
}

const QUESTION_NUMBER_WORDS: string[] = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
];

function toQuestionOrdinalWord(n: number): string {
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  return QUESTION_NUMBER_WORDS[safe] ?? String(safe);
}

function pageNameFromSourcePath(sourcePath: string): string {
  const clean = String(sourcePath || "").trim().replace(/\\/g, "/");
  if (!clean) return "Page";
  const leaf = clean
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .pop() || "";
  const noExt = leaf.replace(/\.md$/i, "").trim();
  return noExt || "Page";
}

function getSessionQueue(session: StudySession | Session): CardRecord[] {
  if (session instanceof StudySession) {
    return session.queue;
  }
  return session?.queue || [];
}

function questionNumberWithinNote(session: StudySession | Session, card: CardRecord): number {
  const currentId = String(card.id || "");
  const sourcePath = String(card.sourceNotePath || "").trim().toLowerCase();
  if (!sourcePath) return 1;

  const queue = getSessionQueue(session);
  const noteCards = queue
    .filter((entry) => String(entry?.sourceNotePath || "").trim().toLowerCase() === sourcePath)
    .slice()
    .sort((a, b) => {
      const lineDelta = (Number(a?.sourceStartLine) || 0) - (Number(b?.sourceStartLine) || 0);
      if (lineDelta !== 0) return lineDelta;
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });

  const idx = noteCards.findIndex((entry) => String(entry?.id || "") === currentId);
  return idx >= 0 ? idx + 1 : 1;
}

function fallbackQuestionTitle(session: StudySession | Session, card: CardRecord): string {
  const page = pageNameFromSourcePath(String(card.sourceNotePath || ""));
  const questionWord = toQuestionOrdinalWord(questionNumberWithinNote(session, card));
  return `${page} \u2013 Question ${questionWord}`;
}

function extractInfoField(card: CardRecord): string | null {
  if (!card) return null;
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const s = v.filter((x) => typeof x === "string").join("\n").trim();
      return s ? s : null;
    }
    return null;
  };
  return pick(card.info);
}

function makeKbd(label: string): HTMLElement {
  const kbd = makeEl("kbd");
  kbd.className = "kbd";
  kbd.textContent = label;
  return kbd;
}

function appendKbdRight(btn: HTMLElement, label: string): void {
  const kbd = makeKbd(label);
  kbd.classList.add("ml-auto");
  btn.appendChild(kbd);
}

function makeTextButton(opts: {
  label: string;
  subtitle?: string;
  className?: string;
  onClick: (e: MouseEvent) => void;
  kbd?: string;
  title?: string;
}): HTMLButtonElement {
  const btn = makeEl("button");
  btn.type = "button";
  btn.className = `bc ${opts.className || "learnkit-btn-toolbar"}`;

  const hasSubtitle = typeof opts.subtitle === "string" && opts.subtitle.trim().length > 0;
  if (hasSubtitle) {
    btn.classList.add("learnkit-btn-with-subtitle");
    const stack = makeEl("span");
    stack.className = "learnkit-btn-content-stack";

    const main = makeEl("span");
    main.className = "learnkit-btn-main-label";
    main.textContent = opts.label;
    stack.appendChild(main);

    const sub = makeEl("span");
    sub.className = "learnkit-btn-subtitle";
    sub.textContent = opts.subtitle!;
    stack.appendChild(sub);

    btn.appendChild(stack);
  } else {
    btn.textContent = opts.label;
  }

  if (opts.kbd) appendKbdRight(btn, opts.kbd);
  if (opts.title) btn.title = opts.title;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    opts.onClick(e);
  });
  return btn;
}

function isIoCard(card: CardRecord): boolean {
  const t = String(card?.type || "").toLowerCase();
  return t === "io" || t === "image-occlusion" || t === "image_occlusion";
}

function isHotspotCard(card: CardRecord): boolean {
  const t = String(card?.type || "").toLowerCase();
  return t === "hotspot" || t === "hq";
}

function getHotspotInteractionModeFromCard(card: CardRecord): "click" | "drag-drop" {
  const overrideValue = (card as unknown as { hotspotInteractionModeOverride?: unknown })?.hotspotInteractionModeOverride;
  const override = (typeof overrideValue === "string" ? overrideValue : "").trim().toLowerCase();
  if (override === "drag-drop") return "drag-drop";
  if (override === "click") return "click";
  const mode = String(card?.interactionMode || "").trim().toLowerCase();
  return mode === "drag-drop" ? "drag-drop" : "click";
}

function getHotspotTargetCount(card: CardRecord): number {
  const rawCount = Number((card as unknown as { hotspotTargetCount?: unknown })?.hotspotTargetCount ?? 0);
  return Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : 1;
}

function buildHotspotQuestionPrompt(card: CardRecord): string {
  const interactionMode = getHotspotInteractionModeFromCard(card);
  const targetCount = getHotspotTargetCount(card);
  if (interactionMode === "drag-drop") {
    return targetCount > 1
      ? `Drag and drop all ${targetCount} markers onto their locations, then reveal the answer.`
      : "Drag and drop the marker onto its location, then reveal the answer.";
  }
  return targetCount > 1
    ? `Click all ${targetCount} target regions on the image, then reveal the answer.`
    : "Click the target region on the image, then reveal the answer.";
}

function isPermutation(arr: unknown, n: number): boolean {
  if (!Array.isArray(arr) || arr.length !== n) return false;
  const seen = new Set<number>();
  for (const v of arr) {
    if (typeof v !== "number" || !Number.isInteger(v)) return false;
    if (v < 0 || v >= n) return false;
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

function readOqOrderFromStepList(root: ParentNode, expectedLength: number): number[] | null {
  const stepItems = Array.from(root.querySelectorAll<HTMLElement>("[data-orig-idx]"));
  if (stepItems.length !== expectedLength) return null;
  const domOrder = stepItems.map((el) => Number(el.dataset.origIdx));
  return isPermutation(domOrder, expectedLength) ? domOrder : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header Menu (More-Menu Dropdown)
// ─────────────────────────────────────────────────────────────────────────────

export function makeHeaderMenu(opts: {
  interfaceLanguage?: string;
  canUndo: boolean;
  onUndo: () => void;
  canSkip: boolean;
  onSkip: () => void;
  canBurySuspend: boolean;
  onBury: () => void;
  onSuspend: () => void;
  onExit: () => void;
  canReplayAudio?: boolean;
  onReplayAudio?: () => void;
  compactTrigger?: boolean;
}): HTMLElement {
  const tx = (token: string, fallback: string, vars?: Record<string, string | number>) =>
    t(opts.interfaceLanguage, token, fallback, vars);
  const id = `learnkit-menu-${Math.random().toString(36).slice(2, 8)}`;

  const root = makeEl("div");
  root.id = id;
  root.className = "relative inline-flex";

  const trigger = makeEl("button");
  trigger.type = "button";
  trigger.id = `${id}-trigger`;
  trigger.className = "learnkit-btn-toolbar learnkit-btn-filter";
  trigger.dataset.bcAction = "reviewer-more-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-controls", `${id}-menu`);
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", tx("ui.reviewer.more.tooltip", "Open menu"));

  if (opts.compactTrigger) {
    trigger.classList.add("lk-review-more-icon-btn");
    const iconWrap = makeEl("span");
    iconWrap.className = "inline-flex items-center justify-center";
    setIcon(iconWrap, "menu");
    trigger.appendChild(iconWrap);
  } else {
    trigger.textContent = tx("ui.reviewer.more.title", "More");
    appendKbdRight(trigger, "M");
  }
  root.appendChild(trigger);

  const popover = makeEl("div");
  popover.id = `${id}-popover`;
  popover.className = "learnkit learnkit-popover-overlay";
  popover.setAttribute("aria-hidden", "true");

  const panel = makeEl("div");
  panel.className =
    "learnkit rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1 pointer-events-auto learnkit-header-menu-panel learnkit-session-more-popover flex flex-col";
  popover.appendChild(panel);

  const menu = makeEl("div");
  menu.className = "learnkit flex flex-col";
  menu.setAttribute("role", "menu");
  menu.id = `${id}-menu`;
  panel.appendChild(menu);

  const mkItem = (
    label: string,
    enabled: boolean,
    onSelect: () => void,
    kbd?: string,
    actionKey?: string,
    iconName?: string,
  ): HTMLButtonElement => {
    const item = makeEl("button");
    item.type = "button";
    item.className =
      "group learnkit-session-more-item flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm cursor-pointer select-none outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground menu-item";
    if (actionKey) item.dataset.bcAction = actionKey;
    item.setAttribute("role", "menuitem");
    item.tabIndex = enabled ? 0 : -1;

    if (!enabled) {
      item.setAttribute("aria-disabled", "true");
      item.classList.add("is-disabled", "learnkit-menu-item--disabled");
      item.disabled = true;
    }

    const leftWrap = makeEl("span");
    leftWrap.className = "flex items-center gap-2 min-w-0";

    if (iconName) {
      const iconWrap = makeEl("span");
      iconWrap.className = "inline-flex items-center justify-center opacity-70 shrink-0 learnkit-menu-item-icon";
      setIcon(iconWrap, iconName);
      queryFirst(iconWrap, "svg")?.setAttribute("width", "14");
      queryFirst(iconWrap, "svg")?.setAttribute("height", "14");
      leftWrap.appendChild(iconWrap);
    }

    const span = makeEl("span");
    span.className = "truncate";
    span.textContent = label;
    leftWrap.appendChild(span);

    item.appendChild(leftWrap);

    if (kbd) {
      const k = makeKbd(kbd);
      k.className = "kbd ml-auto text-xs text-muted-foreground tracking-widest shrink-0";
      item.appendChild(k);
    }

    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!enabled) return;
      closePopover();
      onSelect();
    });

    item.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (!enabled) return;
        closePopover();
        onSelect();
      }
    });

    return item;
  };

  const place = (): void => {
    const r = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(220, Math.round(panelRect.width || 0));

    let left: number;
    if (r.left + width > window.innerWidth - margin && r.right - width >= margin) {
      left = r.right - width;
    } else {
      left = r.left;
    }

    if (left + width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - width - margin);
    }
    if (left < margin) {
      left = margin;
    }

    const height = Math.max(1, panelRect.height);
    const spaceAbove = r.top;
    const spaceBelow = window.innerHeight - r.bottom;
    const dropUp = spaceAbove >= height + margin || spaceAbove >= spaceBelow;

    const top = dropUp
      ? Math.max(margin, r.top - height - 6)
      : Math.min(window.innerHeight - height - margin, r.bottom + 6);

    setCssProps(popover, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      "--learnkit-popover-left": `${left}px`,
      "--learnkit-popover-top": `${top}px`,
      "--learnkit-popover-width": `${width}px`,
      zIndex: "var(--lk-z-popover-overlay, 999999)",
    });
  };

  const getDoc = () => (typeof activeDocument !== "undefined" ? activeDocument : document);

  const onDocPointerDown = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (t && (root.contains(t) || popover.contains(t))) return;
    closePopover();
  };

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
      trigger.focus();
    }
  };

  const onResizeOrScroll = (): void => {
    if (popover.classList.contains("is-open")) {
      place();
    }
  };

  const closePopover = (): void => {
    popover.setAttribute("aria-hidden", "true");
    popover.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");

    const doc = getDoc();
    doc.removeEventListener("pointerdown", onDocPointerDown, true);
    doc.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("resize", onResizeOrScroll, true);
    window.removeEventListener("scroll", onResizeOrScroll, true);

    try {
      popover.remove();
    } catch (e) {
      log.swallow("makeHeaderMenu popover.remove", e);
    }
  };

  const openPopover = (): void => {
    if (popover.classList.contains("is-open")) {
      closePopover();
      return;
    }

    while (menu.firstChild) {
      menu.removeChild(menu.firstChild);
    }

    const undoItem = mkItem(tx("ui.widget.undo", "Undo"), opts.canUndo, opts.onUndo, "Z", "reviewer-menu-undo", "rotate-ccw");
    const skipItem = mkItem(tx("ui.widget.skip", "Skip"), opts.canSkip, opts.onSkip, "S", "reviewer-menu-skip", "skip-forward");
    const buryItem = mkItem(tx("ui.reviewer.action.bury", "Bury"), opts.canBurySuspend, opts.onBury, "B", "reviewer-menu-bury", "archive");
    const suspendItem = mkItem(tx("ui.reviewer.action.suspend", "Suspend"), opts.canBurySuspend, opts.onSuspend, "U", "reviewer-menu-suspend", "pause-circle");

    menu.appendChild(undoItem);
    menu.appendChild(skipItem);
    menu.appendChild(buryItem);
    menu.appendChild(suspendItem);

    if (opts.onReplayAudio) {
      const replayAudioItem = mkItem(
        tx("ui.reviewer.tts.readAloud", "Replay audio"),
        opts.canReplayAudio !== false,
        opts.onReplayAudio,
        "R",
        "reviewer-menu-replay-audio",
        "volume-2",
      );
      menu.appendChild(replayAudioItem);
    }

    const separator = makeEl("hr");
    separator.className = "learnkit-menu-separator my-1 border-t border-border/40";
    menu.appendChild(separator);

    const exitItem = mkItem(tx("ui.reviewer.more.action.exitSession", "Return to decks"), true, opts.onExit, "Q", "reviewer-menu-exit", "log-out");
    menu.appendChild(exitItem);

    const doc = getDoc();
    doc.body.appendChild(popover);
    popover.setAttribute("aria-hidden", "false");
    popover.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");

    place();
    window.requestAnimationFrame(() => place());

    doc.addEventListener("pointerdown", onDocPointerDown, true);
    doc.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("resize", onResizeOrScroll, true);
    window.addEventListener("scroll", onResizeOrScroll, true);
  };

  trigger.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (popover.classList.contains("is-open")) {
      closePopover();
    } else {
      openPopover();
    }
  });

  trigger.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (popover.classList.contains("is-open")) {
        closePopover();
      } else {
        openPopover();
      }
    }
  });

  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// CardReviewPresenter (Deep Module)
// ─────────────────────────────────────────────────────────────────────────────

export class CardReviewPresenter {
  private container: HTMLElement;
  private session: StudySession | Session;
  private options: CardReviewPresenterOptions;
  private showAnswer: boolean = false;
  private activeCardWrapper: HTMLElement | null = null;

  // Interaction states
  private mcqMultiSelected: Set<number> = new Set();
  private mcqMultiCardId: string = "";
  private typedClozeAnswers: Map<string, string> = new Map();
  private pendingManualGradeMeta: Map<string, Record<string, unknown>> = new Map();
  private pendingHotspotAttempt: Map<string, boolean> = new Map();
  private ttsLastSpokenKey: string = "";

  // Timing
  private cardStartTime: number = Date.now();
  private sessionStartTime: number = Date.now();
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CardReviewPresenterOptions) {
    this.container = options.container;
    this.session = options.session;
    this.options = options;
    this.showAnswer = options.initialShowAnswer ?? false;
  }

  // ── Public Interface ───────────────────────────────────────────────────────

  public get isAnswerRevealed(): boolean {
    return this.showAnswer;
  }

  public get currentCard(): CardRecord | null {
    if (this.options.currentCard) {
      return this.options.currentCard();
    }
    if (this.session instanceof StudySession) {
      return this.session.currentCard;
    }
    const q = this.session?.queue || [];
    const idx = Number(this.session?.index || 0);
    return q[idx] || null;
  }

  public get studySession(): StudySession | Session {
    return this.session;
  }

  public updateSession(session: StudySession | Session): void {
    this.session = session;
    this.showAnswer = false;
    this.render();
  }

  public mount(targetEl?: HTMLElement): void {
    this.render(targetEl);
  }

  public revealAnswer(): void {
    if (this.showAnswer) return;
    this.showAnswer = true;
    this.options.setShowAnswer?.(true);

    const card = this.currentCard;
    if (card) {
      this.speakCard(card, "back");
    }
    this.renderCardInPlace();
    this.options.rerender?.();
  }

  public hideAnswer(): void {
    if (!this.showAnswer) return;
    this.showAnswer = false;
    this.options.setShowAnswer?.(false);
    this.renderCardInPlace();
    this.options.rerender?.();
  }

  public async gradeCurrentRating(rating: Rating, meta?: Record<string, unknown> | null): Promise<void> {
    const card = this.currentCard;
    if (!card) return;

    this.stopAudio();
    const mergedMeta = { ...(meta || {}), ...(this.pendingManualGradeMeta.get(String(card.id)) || {}) };
    this.pendingManualGradeMeta.delete(String(card.id));

    if (this.options.gradeCurrentRating) {
      await this.options.gradeCurrentRating(rating, mergedMeta);
    } else if (this.session instanceof StudySession) {
      await this.session.grade(rating, mergedMeta);
    } else {
      const id = String(card.id);
      this.session.graded = this.session.graded || {};
      this.session.graded[id] = { rating, at: Date.now(), meta: mergedMeta };
      this.session.stats = this.session.stats || { total: this.session.queue.length, done: 0 };
      this.session.stats.done = Object.keys(this.session.graded).length;
    }

    await this.nextCard(true);
  }

  public async nextCard(userInitiated: boolean = true): Promise<void> {
    this.stopAudio();
    this.ttsLastSpokenKey = "";

    const card = this.currentCard;
    if (card) {
      const id = String(card.id);
      this.pendingManualGradeMeta.delete(id);
      this.pendingHotspotAttempt.delete(id);
    }

    if (this.options.nextCard) {
      await this.options.nextCard(userInitiated);
      return;
    }

    let hasNext = false;
    if (this.session instanceof StudySession) {
      hasNext = this.session.nextCard();
    } else {
      if (this.session.index < this.session.queue.length - 1) {
        this.session.index += 1;
        hasNext = true;
      } else {
        this.session.index = this.session.queue.length;
        hasNext = false;
      }
    }

    this.cardStartTime = Date.now();
    this.showAnswer = false;
    this.options.setShowAnswer?.(false);

    if (!hasNext || !this.currentCard) {
      if (this.options.onComplete) {
        this.options.onComplete();
      }
    }

    this.render();
    this.options.rerender?.();

    const next = this.currentCard;
    if (next && !this.showAnswer) {
      this.speakCard(next, "front");
    }
  }

  public prevCard(): void {
    if (this.session instanceof StudySession) {
      return;
    }
    if (this.session.index > 0) {
      this.session.index -= 1;
      this.showAnswer = false;
      this.render();
      this.options.rerender?.();
    }
  }

  private onCardAdvanced(): void {
    this.stopAudio();
    this.ttsLastSpokenKey = "";

    const card = this.currentCard;
    if (card) {
      const id = String(card.id);
      this.pendingManualGradeMeta.delete(id);
      this.pendingHotspotAttempt.delete(id);
    }

    this.cardStartTime = Date.now();
    this.showAnswer = false;
    this.options.setShowAnswer?.(false);

    if (!this.currentCard) {
      if (this.options.onComplete) {
        this.options.onComplete();
      }
    }

    this.render();
    this.options.rerender?.();

    const next = this.currentCard;
    if (next && !this.showAnswer) {
      this.speakCard(next, "front");
    }
  }

  public async buryCurrentCard(): Promise<void> {
    const card = this.currentCard;
    if (!card) return;
    this.stopAudio();
    if (this.session instanceof StudySession) {
      await this.session.buryCurrent();
      this.onCardAdvanced();
      return;
    }
    this.showAnswer = false;
    await this.nextCard(true);
  }

  public async suspendCurrentCard(): Promise<void> {
    const card = this.currentCard;
    if (!card) return;
    this.stopAudio();
    if (this.session instanceof StudySession) {
      await this.session.suspendCurrent();
      this.onCardAdvanced();
      return;
    }
    this.showAnswer = false;
    await this.nextCard(true);
  }

  public skipCurrentCard(meta?: Record<string, unknown>): void {
    const card = this.currentCard;
    if (!card) return;
    this.stopAudio();
    if (this.session instanceof StudySession) {
      this.session.skipCurrent(meta);
      this.onCardAdvanced();
      return;
    }
    this.showAnswer = false;
    void this.nextCard(true);
  }

  public async undoLast(): Promise<void> {
    if (this.session instanceof StudySession && this.session.canUndo) {
      this.stopAudio();
      await this.session.undo();
      this.showAnswer = false;
      this.render();
      this.options.rerender?.();
    }
  }

  public async answerMcq(choiceIdx: number): Promise<void> {
    const card = this.currentCard;
    if (!card || card.type !== "mcq") return;
    const correctIdx = Number.isFinite(card.correctIndex) ? Number(card.correctIndex) : 0;
    const isCorrect = choiceIdx === correctIdx;
    const rating: Rating = isCorrect ? "good" : "again";
    await this.gradeCurrentRating(rating, { chosenOptionIndex: choiceIdx, isCorrect });
  }

  public async answerMcqMulti(selectedIndices: number[]): Promise<void> {
    const card = this.currentCard;
    if (!card || card.type !== "mcq") return;
    const correctIndices = new Set(getCorrectIndices(card));
    const chosenSet = new Set(selectedIndices);
    const isExact = chosenSet.size === correctIndices.size && [...chosenSet].every((x) => correctIndices.has(x));
    const rating: Rating = isExact ? "good" : "again";
    await this.gradeCurrentRating(rating, { chosenOptionIndices: selectedIndices, isCorrect: isExact });
  }

  public async answerOq(userOrder: number[]): Promise<void> {
    const card = this.currentCard;
    if (!card || card.type !== "oq") return;
    const steps = Array.isArray(card.oqSteps) ? card.oqSteps : [];
    const isCorrect = userOrder.length === steps.length && userOrder.every((v, i) => v === i);
    const rating: Rating = isCorrect ? "good" : "again";
    await this.gradeCurrentRating(rating, { userOrder, isCorrect });
  }

  public handleKeyDown(ev: KeyboardEvent): boolean {
    const card = this.currentCard;
    if (!card) return false;

    // Do not intercept input when typing inside textareas or inputs
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      if (ev.key === "Enter" && target.tagName === "TEXTAREA" && !ev.shiftKey) {
        if (!this.showAnswer) {
          ev.preventDefault();
          this.revealAnswer();
          return true;
        }
      }
      return false;
    }

    const isAdvance = ev.key === " " || ev.key === "Enter";

    // Reveal answer on Space or Enter
    if (!this.showAnswer && isAdvance) {
      ev.preventDefault();
      ev.stopPropagation();
      this.revealAnswer();
      return true;
    }

    // Skip on Escape or 'S'
    if (ev.key === "Escape" || ev.key.toLowerCase() === "s") {
      if (this.options.enableSkipButton) {
        ev.preventDefault();
        ev.stopPropagation();
        this.skipCurrentCard({ uiSource: "keyboard", key: ev.key });
        return true;
      }
    }

    // Undo on 'Z' or 'U'
    if ((ev.key.toLowerCase() === "z" || ev.key.toLowerCase() === "u") && !ev.metaKey && !ev.ctrlKey) {
      if (this.session instanceof StudySession && this.session.canUndo) {
        ev.preventDefault();
        ev.stopPropagation();
        void this.undoLast();
        return true;
      }
    }

    // Bury on 'B'
    if (ev.key.toLowerCase() === "b" && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      ev.stopPropagation();
      void this.buryCurrentCard();
      return true;
    }

    // Suspend on Shift+'S' or 'S' when skip is not bound to 's'
    if (ev.key.toLowerCase() === "s" && !ev.metaKey && !ev.ctrlKey) {
      if (!this.options.enableSkipButton || ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        void this.suspendCurrentCard();
        return true;
      }
    }

    // Rating shortcuts (1-4) when answer is revealed
    if (this.showAnswer) {
      const four = !!this.options.fourButtonMode;
      if (ev.key === "1") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.gradeCurrentRating("again");
        return true;
      }
      if (ev.key === "2") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.gradeCurrentRating(four ? "hard" : "good");
        return true;
      }
      if (four && ev.key === "3") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.gradeCurrentRating("good");
        return true;
      }
      if (four && ev.key === "4") {
        ev.preventDefault();
        ev.stopPropagation();
        void this.gradeCurrentRating("easy");
        return true;
      }
      if (isAdvance) {
        ev.preventDefault();
        ev.stopPropagation();
        void this.gradeCurrentRating("good");
        return true;
      }
    }

    return false;
  }

  public destroy(): void {
    this.stopAudio();
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    const popovers = document.querySelectorAll(".learnkit-popover-overlay, .learnkit-session-more-popover");
    popovers.forEach((p) => p.remove());
  }

  // ── Rendering Implementation ───────────────────────────────────────────────

  public render(targetEl?: HTMLElement): void {
    const container = this.container;
    const card = this.currentCard;
    const applyAOS = !!this.options.applyAOS;
    const delayMs = Number.isFinite(this.options.aosDelayMs) ? Number(this.options.aosDelayMs) : applyAOS ? 100 : 0;

    const reusable = targetEl ?? this.activeCardWrapper;
    const isLightweight = !!(reusable && reusable.parentElement === container);
    const wrap = isLightweight ? reusable : makeEl("div");

    if (isLightweight) {
      while (wrap.firstChild) {
        wrap.removeChild(wrap.firstChild);
      }
    } else {
      renderStudySessionHeader(container, this.options.interfaceLanguage, applyAOS, {
        titleToken: "ui.reviewer.session.header.title",
        titleFallback: "Flashcards",
      });
      wrap.className = "card w-full learnkit-session-card lk-session-card m-0";
    }

    this.activeCardWrapper = wrap;
    wrap.classList.toggle("learnkit-session-answer-revealed", this.showAnswer);

    const resetAos = (): void => {
      wrap.classList.remove("aos-init", "aos-animate", "learnkit-aos-fallback");
    };

    if (applyAOS && !this.showAnswer) {
      resetAos();
      wrap.setAttribute("data-aos", "fade-up");
      wrap.setAttribute("data-aos-delay", String(Math.max(0, Math.floor(delayMs))));
    } else {
      wrap.removeAttribute("data-aos");
      wrap.removeAttribute("data-aos-delay");
      resetAos();
    }

    // ── Empty State ──
    if (!card) {
      this.renderEmptyState(wrap);
      if (!isLightweight) container.appendChild(wrap);
      this.triggerAos();
      this.options.onCardRendered?.(null, false);
      return;
    }

    // ── Card Present ──
    wrap.classList.add("learnkit-session-has-dock");
    const sourcePath = card.sourceNotePath || "";

    // Header Topbar
    const header = makeEl("header");
    header.className = "learnkit-session-topbar";
    wrap.appendChild(header);

    let displayTitle = card.title || "";
    if (card.type === "cloze" || card.type === "cloze-child") {
      displayTitle = displayTitle.replace(/\s*•\s*c\d+\s*$/, "");
    }
    if (card.type === "reversed-child") {
      displayTitle = displayTitle.replace(/\s*•\s*[AQ]\u2192[AQ]\s*$/, "");
    }
    const TYPE_LABELS = new Set(["basic", "basic (reversed)", "cloze", "multiple choice", "image occlusion", "ordered question", "flashcard"]);
    if (TYPE_LABELS.has(displayTitle.toLowerCase())) displayTitle = "";

    const titleText = (displayTitle || fallbackQuestionTitle(this.session, card) || "").trim();
    if (!titleText) {
      header.classList.add("learnkit-session-topbar-hidden");
    }

    const titleWrap = makeEl("div");
    titleWrap.className = "learnkit-session-topbar-title learnkit-question-title";
    header.appendChild(titleWrap);

    const deckIcon = makeEl("span");
    deckIcon.className = "learnkit-deck-icon inline-flex items-center justify-center opacity-70 shrink-0";
    setIcon(deckIcon, "folder");
    queryFirst(deckIcon, "svg")?.setAttribute("width", "13");
    queryFirst(deckIcon, "svg")?.setAttribute("height", "13");
    titleWrap.appendChild(deckIcon);

    const titleTextSpan = makeEl("span");
    titleTextSpan.className = "truncate learnkit-deck-title-text";
    titleWrap.appendChild(titleTextSpan);

    const titleMd = String(titleText ?? "");
    if (titleMd.includes("[[") || titleMd.includes("$")) {
      void this.renderMarkdown(titleTextSpan, titleMd, sourcePath);
    } else {
      applyInlineMarkdownWithFlags(titleTextSpan, titleMd);
    }

    // Card Content Section
    const section = makeEl("section");
    section.className = "flex flex-col gap-3";
    wrap.appendChild(section);

    this.renderCardContent(section, card, sourcePath);

    // Study Dock Footer
    const footer = makeEl("footer");
    footer.className = "learnkit-session-study-dock";
    wrap.appendChild(footer);

    this.renderStudyDock(footer, card);

    if (!isLightweight) container.appendChild(wrap);
    this.triggerAos();
    this.options.onCardRendered?.(card, this.showAnswer);
  }

  private renderCardInPlace(): void {
    if (this.activeCardWrapper) {
      this.render(this.activeCardWrapper);
    } else {
      this.render();
    }
  }

  private renderEmptyState(wrap: HTMLElement): void {
    const tx = (token: string, fallback: string) => t(this.options.interfaceLanguage, token, fallback);
    const isPractice = !!this.options.practiceMode;

    const header = makeEl("header");
    header.className = "learnkit-session-topbar";
    wrap.appendChild(header);

    const titleWrap = makeEl("div");
    titleWrap.className = "learnkit-session-topbar-title learnkit-question-title";
    titleWrap.textContent = isPractice
      ? tx("ui.reviewer.session.practiceComplete", "Practice complete")
      : tx("ui.reviewer.session.noCardsDue", "No cards are due");
    header.appendChild(titleWrap);

    const section = makeEl("section");
    section.className = "flex flex-col gap-3 learnkit-session-practice-prompt text-center";

    const d1 = makeEl("div");
    d1.className = "text-base";
    d1.textContent = isPractice
      ? tx("ui.reviewer.session.practiceSessionComplete", "Practice session complete")
      : tx("ui.reviewer.session.askStartPractice", "Would you like to start a practice session?");
    section.appendChild(d1);

    const d2 = makeEl("div");
    d2.className = "text-sm text-muted-foreground";
    d2.textContent = isPractice
      ? tx("ui.reviewer.session.practiceCompleteDescription", "This was a practice session. Scheduling was not changed.")
      : tx("ui.reviewer.session.practiceModeDescription", "Practice session reviews all cards in this deck without affecting scheduling.");
    section.appendChild(d2);
    wrap.appendChild(section);

    const footer = makeEl("footer");
    footer.className = "learnkit-session-study-dock flex justify-center gap-3";

    const backBtn = makeTextButton({
      label: tx("ui.reviewer.session.returnToDecks", "Return to Decks"),
      className: "learnkit-btn-toolbar",
      onClick: () => this.options.onBackToDecks?.(),
      kbd: "Q",
    });
    footer.appendChild(backBtn);

    if (!isPractice && this.options.onStartPractice) {
      const practiceBtn = makeTextButton({
        label: tx("ui.reviewer.session.startPractice", "Start Practice"),
        className: "btn-primary",
        onClick: () => this.options.onStartPractice?.(),
        kbd: "↵",
      });
      footer.appendChild(practiceBtn);
    }

    wrap.appendChild(footer);
  }

  private renderCardContent(section: HTMLElement, card: CardRecord, sourcePath: string): void {
    const tx = (token: string, fallback: string) => t(this.options.interfaceLanguage, token, fallback);

    const labelRow = (text: string, replayFn?: () => void, ttsField?: string): HTMLElement => {
      const row = makeEl("div");
      row.className = "flex items-center justify-between learnkit-label-row";

      const titleGroup = makeEl("div");
      titleGroup.className = "flex items-center gap-2 learnkit-label-left";

      const lbl = makeEl("div");
      lbl.className = "learnkit-label-title text-muted-foreground text-sm font-medium";
      lbl.textContent = text;
      titleGroup.appendChild(lbl);

      if (card.audioRef && replayFn) {
        const badge = makeEl("span");
        badge.className = "learnkit-audio-badge";
        badge.textContent = tx("ui.common.audioAttachment", "Audio");
        titleGroup.appendChild(badge);
      }
      row.appendChild(titleGroup);

      const canShowAudio = !!(this.options.ttsEnabled || card.audioRef);
      if (canShowAudio && replayFn) {
        const actions = makeEl("div");
        actions.className = "flex items-center gap-1 learnkit-label-actions";

        const btn = makeEl("button");
        btn.type = "button";
        btn.className = "btn-icon learnkit-tts-replay-btn";
        btn.setAttribute("aria-label", `${tx("ui.common.playAudio", "Play audio")} (R)`);
        if (ttsField) btn.setAttribute("data-tts-field", ttsField);
        if (card.audioRef) {
          btn.setAttribute("data-learnkit-audio-ref", String(card.audioRef).trim());
        }

        const icon = makeEl("span");
        setIcon(icon, "volume-2");
        btn.appendChild(icon);

        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          replayFn();
        });

        actions.appendChild(btn);
        row.appendChild(actions);

        bindTtsPlayingState(btn);
        if (isVaultAudioPlaying()) {
          markTtsButtonActive(btn);
        }
      }

      return row;
    };

    const renderMdBlock = (cls: string, md: string): HTMLElement => {
      const block = makeEl("div");
      block.className = `bc ${cls} whitespace-pre-wrap break-words learnkit-md-block`;
      const escaped = escapeAngleBracketsOutsideMathAndCode(String(md ?? ""));
      void this.renderMarkdown(block, escaped, sourcePath);
      return block;
    };

    const isBasicOrReversed =
      card.type === "basic" ||
      card.type === "reversed" ||
      card.type === "reversed-child" ||
      card.type === "combo-child";

    if (isBasicOrReversed) {
      const isBackDirection =
        card.type === "reversed-child" &&
        (card as unknown as { reversedDirection?: string }).reversedDirection === "back";
      const isOldReversed = card.type === "reversed";
      const frontContent = isBackDirection || isOldReversed ? card.a || "" : card.q || "";
      const backContent = isBackDirection || isOldReversed ? card.q || "" : card.a || "";

      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));
      section.appendChild(renderMdBlock("learnkit-q", convertInlineDisplayMath(frontContent)));

      if (this.showAnswer) {
        const qaDivider = makeEl("hr");
        qaDivider.className = "learnkit-qa-divider";
        section.appendChild(qaDivider);

        section.appendChild(labelRow(tx("ui.common.answer", "Answer")));
        section.appendChild(renderMdBlock("learnkit-a", convertInlineDisplayMath(backContent)));
      }
    } else if (card.type === "cloze" || card.type === "cloze-child") {
      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));

      const rawText = card.clozeText || card.q || "";
      const clozeOpts: ClozeRenderOptions = {
        mode: this.options.clozeMode === "typed" ? "typed" : "standard",
        clozeBgColor: this.options.clozeBgColor || "",
        clozeTextColor: this.options.clozeTextColor || "",
        typedAnswers: this.typedClozeAnswers,
        onTypedInput: (answerKey, _idx, val) => {
          this.typedClozeAnswers.set(answerKey, val);
        },
        onTypedSubmit: () => {
          if (!this.showAnswer) {
            this.revealAnswer();
          }
        },
      };
      const frontEl = renderClozeFront(rawText, this.showAnswer, null, clozeOpts);
      section.appendChild(frontEl);
    } else if (card.type === "mcq") {
      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));
      this.renderMcq(section, card, sourcePath);
    } else if (card.type === "oq") {
      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));
      this.renderOq(section, card, sourcePath);
    } else if (isIoCard(card) && this.options.renderImageOcclusionInto) {
      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));
      const ioContainer = makeEl("div");
      void this.options.renderImageOcclusionInto(ioContainer, card, sourcePath, this.showAnswer);
      section.appendChild(ioContainer);
    } else {
      const qReplay = this.options.ttsReplayFront ?? (() => this.speakCard(card, "front"));
      section.appendChild(labelRow(tx("ui.common.question", "Question"), qReplay, "question"));
      section.appendChild(renderMdBlock("learnkit-q", convertInlineDisplayMath(card.q || "")));

      if (this.showAnswer) {
        const qaDivider = makeEl("hr");
        qaDivider.className = "learnkit-qa-divider";
        section.appendChild(qaDivider);

        section.appendChild(labelRow(tx("ui.common.answer", "Answer")));
        section.appendChild(renderMdBlock("learnkit-a", convertInlineDisplayMath(card.a || "")));
      }
    }

    // Info Field
    if (this.showAnswer) {
      const info = extractInfoField(card);
      if (info) {
        const infoEl = renderMdBlock("learnkit-info whitespace-pre-wrap break-words", info);
        section.appendChild(infoEl);
      }
    }
  }

  private renderMcq(container: HTMLElement, card: CardRecord, sourcePath: string): void {
    const stem = card.stem || card.q || "";
    if (stem) {
      const stemEl = makeEl("div");
      stemEl.className = "mb-3 learnkit-mcq-stem";
      void this.renderMarkdown(stemEl, stem, sourcePath);
      container.appendChild(stemEl);
    }

    const options = Array.isArray(card.options) ? card.options : [];
    const list = makeEl("div");
    list.className = "flex flex-col gap-2 learnkit-mcq-option-list";

    const correctIndices = new Set(getCorrectIndices(card));
    const multi = isMultiAnswerMcq(card);

    options.forEach((optText, idx) => {
      const btn = makeEl("button");
      btn.type = "button";
      btn.className = "learnkit-btn-toolbar text-left flex items-center justify-between p-3 rounded-lg border";

      const isSelected = this.mcqMultiSelected.has(idx);
      const isCorrect = correctIndices.has(idx);

      if (this.showAnswer) {
        if (isCorrect) {
          btn.classList.add("learnkit-mcq-correct", "border-emerald-500", "bg-emerald-50/20");
        } else if (isSelected) {
          btn.classList.add("learnkit-mcq-wrong", "border-red-500", "bg-red-50/20");
        }
      } else if (isSelected) {
        btn.classList.add("border-primary", "bg-primary/10");
      }

      const textWrap = makeEl("span");
      textWrap.className = "flex-1 mr-2";
      void this.renderMarkdown(textWrap, optText, sourcePath);
      btn.appendChild(textWrap);

      const kbd = makeKbd(String(idx + 1));
      btn.appendChild(kbd);

      btn.addEventListener("click", () => {
        if (this.showAnswer) return;
        if (multi) {
          if (this.mcqMultiSelected.has(idx)) {
            this.mcqMultiSelected.delete(idx);
          } else {
            this.mcqMultiSelected.add(idx);
          }
          this.renderCardInPlace();
        } else {
          void this.answerMcq(idx);
        }
      });

      list.appendChild(btn);
    });

    container.appendChild(list);
  }

  private renderOq(container: HTMLElement, card: CardRecord, sourcePath: string): void {
    const steps = Array.isArray(card.oqSteps) ? card.oqSteps : [];
    const list = makeEl("div");
    list.className = "flex flex-col gap-2 learnkit-oq-list";

    steps.forEach((stepText, idx) => {
      const row = makeEl("div");
      row.className = "flex items-center gap-2 p-2.5 rounded-lg border bg-card text-sm";
      row.dataset.origIdx = String(idx);

      const kbd = makeKbd(String(idx + 1));
      row.appendChild(kbd);

      const text = makeEl("span");
      text.className = "flex-1";
      void this.renderMarkdown(text, stepText, sourcePath);
      row.appendChild(text);

      list.appendChild(row);
    });

    container.appendChild(list);
  }

  private renderStudyDock(footer: HTMLElement, card: CardRecord): void {
    const tx = (token: string, fallback: string) => t(this.options.interfaceLanguage, token, fallback);
    const four = !!this.options.fourButtonMode;
    const isPractice = !!this.options.practiceMode;

    const left = makeEl("div");
    left.className = "flex items-center gap-2 learnkit-session-study-dock-left";
    footer.appendChild(left);

    const center = makeEl("div");
    center.className = "flex flex-wrap gap-2 items-center justify-center learnkit-session-study-dock-center flex-1";
    footer.appendChild(center);

    const right = makeEl("div");
    right.className = "flex items-center gap-2 learnkit-session-study-dock-right";
    footer.appendChild(right);

    // Left controls: Back to Decks
    const backBtn = makeTextButton({
      label: tx("ui.reviewer.session.returnToDecks", "Decks"),
      className: "learnkit-btn-toolbar",
      onClick: () => this.options.onBackToDecks?.(),
      kbd: "Q",
    });
    left.appendChild(backBtn);

    // Header More-Menu
    const menuRoot = makeHeaderMenu({
      interfaceLanguage: this.options.interfaceLanguage,
      canUndo: this.session instanceof StudySession ? this.session.canUndo : false,
      onUndo: () => void this.undoLast(),
      canSkip: !!this.options.enableSkipButton,
      onSkip: () => this.skipCurrentCard(),
      canBurySuspend: !isPractice,
      onBury: () => void this.buryCurrentCard(),
      onSuspend: () => void this.suspendCurrentCard(),
      onExit: () => this.options.onBackToDecks?.(),
      canReplayAudio: !!card.audioRef,
      onReplayAudio: () => this.speakCard(card, this.showAnswer ? "back" : "front"),
      compactTrigger: true,
    });
    left.appendChild(menuRoot);

    // Center controls: Reveal Answer or Rating Buttons
    if (!this.showAnswer) {
      const revealBtn = makeTextButton({
        label: tx("ui.widget.revealAnswer", "Reveal Answer"),
        className: "btn-primary learnkit-reveal-btn px-6",
        onClick: () => this.revealAnswer(),
        kbd: "Space",
      });
      center.appendChild(revealBtn);
    } else if (isPractice) {
      const continueBtn = makeTextButton({
        label: tx("ui.reviewer.action.continue", "Continue"),
        className: "btn-primary px-6",
        onClick: () => void this.nextCard(true),
        kbd: "↵",
      });
      center.appendChild(continueBtn);
    } else {
      // Rating buttons: Again, Hard, Good, Easy
      const gradeGroup = makeEl("div");
      gradeGroup.className = "learnkit-session-study-dock-grade-group";
      center.appendChild(gradeGroup);

      const againBtn = makeTextButton({
        label: tx("ui.widget.grade.again", "Again"),
        className: "btn-destructive learnkit-btn-again",
        onClick: () => void this.gradeCurrentRating("again"),
        kbd: "1",
      });
      gradeGroup.appendChild(againBtn);

      if (four) {
        const hardBtn = makeTextButton({
          label: tx("ui.widget.grade.hard", "Hard"),
          className: "btn learnkit-btn-hard",
          onClick: () => void this.gradeCurrentRating("hard"),
          kbd: "2",
        });
        gradeGroup.appendChild(hardBtn);

        const goodBtn = makeTextButton({
          label: tx("ui.widget.grade.good", "Good"),
          className: "btn learnkit-btn-good",
          onClick: () => void this.gradeCurrentRating("good"),
          kbd: "3",
        });
        gradeGroup.appendChild(goodBtn);

        const easyBtn = makeTextButton({
          label: tx("ui.widget.grade.easy", "Easy"),
          className: "btn learnkit-btn-easy",
          onClick: () => void this.gradeCurrentRating("easy"),
          kbd: "4",
        });
        gradeGroup.appendChild(easyBtn);
      } else {
        const goodBtn = makeTextButton({
          label: tx("ui.widget.grade.good", "Good"),
          className: "btn learnkit-btn-good",
          onClick: () => void this.gradeCurrentRating("good"),
          kbd: "2",
        });
        gradeGroup.appendChild(goodBtn);
      }
    }

    // Right controls: Skip or Edit Card
    if (this.options.enableSkipButton) {
      const skipBtn = makeTextButton({
        label: tx("ui.widget.skip", "Skip"),
        className: "learnkit-btn-toolbar",
        onClick: () => this.skipCurrentCard(),
        kbd: "S",
      });
      right.appendChild(skipBtn);
    }

    if (this.options.onEditCard) {
      const editBtn = makeEl("button");
      editBtn.type = "button";
      editBtn.className = "btn-icon";
      editBtn.setAttribute("aria-label", tx("ui.reviewer.cardEditor.title", "Edit Card"));
      const icon = makeEl("span");
      setIcon(icon, "pencil");
      editBtn.appendChild(icon);
      editBtn.addEventListener("click", () => this.options.onEditCard?.(card));
      right.appendChild(editBtn);
    }
  }

  private async renderMarkdown(container: HTMLElement, md: string, sourcePath: string): Promise<void> {
    if (this.options.renderMarkdownInto) {
      await this.options.renderMarkdownInto(container, md, sourcePath);
    } else {
      applyInlineMarkdownWithFlags(container, md);
    }
    // Bind internal note links
    container.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const href = a.getAttribute("href") || a.dataset.href;
        if (href && this.options.onOpenNote) {
          this.options.onOpenNote(href);
        }
      });
    });
  }

  private speakCard(card: CardRecord, side: "front" | "back"): void {
    if (card.audioRef && this.options.app) {
      return;
    }
  }

  private stopAudio(): void {
    stopActiveVaultAudio(true);
    clearActiveTtsButton();
  }

  private triggerAos(): void {
    if (!this.options.applyAOS) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          refreshAOS();
        } catch (e) {
          log.swallow("CardReviewPresenter refreshAOS", e);
        }
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compatibility Adapter (renderSessionMode)
// ─────────────────────────────────────────────────────────────────────────────

export function renderSessionMode(args: unknown): void {
  const presenter = new CardReviewPresenter({
    container: args.container,
    session: args.session,
    interfaceLanguage: args.interfaceLanguage,
    fourButtonMode: args.fourButtonMode,
    enableSkipButton: args.enableSkipButton ?? args.skipEnabled,
    practiceMode: args.practiceMode,
    applyAOS: args.applyAOS,
    aosDelayMs: args.aosDelayMs,
    randomizeMcqOptions: args.randomizeMcqOptions,
    randomizeOqOrder: args.randomizeOqOrder,
    renderMarkdownInto: args.renderMarkdownInto,
    renderImageOcclusionInto: args.renderImageOcclusionInto,
    ttsEnabled: args.ttsEnabled,
    ttsReplayFront: args.ttsReplayFront,
    ttsReplayBack: args.ttsReplayBack,
    initialShowAnswer: args.showAnswer,
    setShowAnswer: args.setShowAnswer,
    rerender: args.rerender,
    currentCard: args.currentCard,
    gradeCurrentRating: args.gradeCurrentRating,
    nextCard: args.nextCard,
    onBackToDecks: args.backToDecks,
    onComplete: args.backToDecks,
    onStartPractice: args.startPractice,
  });

  presenter.mount(args.targetEl);
}
