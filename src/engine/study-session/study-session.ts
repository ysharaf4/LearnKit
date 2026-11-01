/**
 * @file src/engine/study-session/study-session.ts
 * @summary Deep domain module encapsulating a study session: queue building,
 *   scope resolution, FSRS grading, intra-session same-day requeueing,
 *   atomic store mutations, card actions (bury/suspend/skip), and undo history.
 *
 * @exports
 *   - StudySession        — Main study session domain class
 *   - StudySessionOptions — Options for initializing a study session
 *   - StudyGradeResult    — Result returned after grading a card
 *   - SkipResult          — Result returned after skipping a card
 *   - UndoFrame           — Snapshot for session rollback
 */

import type { Scope, Session } from "../../views/reviewer/types";
import type { CardRecord } from "../../platform/types/card";
import type { CardState, ReviewRating, SchedulerSettings, GradeResult } from "../../platform/types/scheduler";
import type { IStore } from "../../platform/core/store-interface";
import type { LearnKitSettings } from "../../platform/core/constants";
import { DEFAULT_SETTINGS, deepMerge } from "../../platform/core/constants";
import { gradeFromRating, buryCard, suspendCard } from "../scheduler/scheduler";
import {
  inScope,
  isAvailableNow,
  disperseSiblings,
  collapseSiblingFamilies,
  getNextDueInScope,
} from "../../views/reviewer/session";
import { isParentCard } from "../../platform/core/card-utils";
import { getGroupIndex, normaliseGroupPath } from "../indexing/group-index";
import { pathMatchesMetadataScope } from "../../views/shared/scope-metadata";

export interface StudySessionOptions {
  scope: Scope;
  store: IStore;
  settings?: LearnKitSettings;
  app?: unknown;
  plugin?: unknown;
  cards?: CardRecord[];
  practice?: boolean;
  dueOnly?: boolean;
  ignoreDailyNewLimit?: boolean;
  ignoreDailyReviewLimit?: boolean;
  targetCount?: number;
  sessionStamp?: number;
  now?: number;
}

export type StudyGradeResult = {
  card: CardRecord;
  rating: ReviewRating;
  nextDue: number;
  requeued: boolean;
  metrics?: GradeResult["metrics"];
  nextState?: CardState;
};

export type SkipResult = {
  skipped: boolean;
  promptBury: boolean;
  skipCount: number;
};

export type UndoFrame = {
  id: string;
  cardType: string;
  rating: ReviewRating;
  at: number;
  meta: Record<string, unknown> | null;
  sessionIndex: number;
  showAnswer: boolean;
  storeMutated: boolean;
  analyticsMutated: boolean;
  reviewLogLenBefore: number;
  analyticsLenBefore: number;
  prevState: CardState | null;
  requeuedCard: boolean;
};

function deepClone<T>(val: T): T {
  if (val === undefined || val === null) return val;
  return JSON.parse(JSON.stringify(val));
}

function startOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfTomorrowMs(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function toNonNegIntOrInfinity(x: unknown): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(n));
}

function filterReviewable(cards: CardRecord[]): CardRecord[] {
  return (cards || []).filter((c) => !isParentCard(c));
}

function computeDefaultSkipDelay(remainingAfterThisCard: number): number {
  const r = Math.max(0, Number(remainingAfterThisCard) || 0);
  const n = Math.round(r * 0.2);
  return Math.max(8, Math.min(20, n));
}

/**
 * Deep StudySession domain module.
 *
 * Encapsulates the complete lifecycle of a study session:
 * - Queue resolution and limit enforcement
 * - Atomic FSRS scheduler execution and store persistence
 * - Internal undo-history stack with exact array rollback
 * - Stable randomized option ordering for MCQ/OQ cards
 * - Headless operation (zero DOM or Obsidian View dependencies)
 */
export class StudySession implements Session {
  public scope: Scope;
  public scopeName: string;
  public scopeType: "note" | "folder";
  public scopeKey: string;
  public queue: CardRecord[];
  public index: number;
  public graded: Record<string, { rating: ReviewRating; at: number; meta?: Record<string, unknown> } | undefined>;
  public stats: { total: number; done: number; remaining: number };
  public practice: boolean;
  public _bcStamp: number;
  public mcqOrderMap: Record<string, number[]>;
  public oqOrderMap: Record<string, number[]>;
  public skipCounts: Record<string, number>;
  public mode: "scheduled" | "practice";

  private _store: IStore;
  private _settings: LearnKitSettings;
  private _showAnswer: boolean;
  private _undoStack: UndoFrame[];

  private constructor(
    scope: Scope,
    store: IStore,
    settings: LearnKitSettings,
    queue: CardRecord[],
    practice: boolean,
    sessionStamp: number,
  ) {
    this.scope = scope;
    this.scopeName = scope?.name || "";
    this.scopeType = scope?.type === "folder" ? "folder" : "note";
    this.scopeKey = scope?.key || "";
    this._store = store;
    this._settings = settings;
    this.practice = practice;
    this.queue = queue;
    this.index = 0;
    this._showAnswer = false;
    this.graded = {};
    this.stats = { total: queue.length, done: 0, remaining: queue.length };
    this._undoStack = [];
    this.skipCounts = {};
    this.mcqOrderMap = {};
    this.oqOrderMap = {};
    this._bcStamp = sessionStamp;
    this.mode = practice ? "practice" : "scheduled";
  }

  /**
   * Initializes and starts a study session for the given scope and store.
   */
  static start(options: StudySessionOptions): StudySession {
    const now = options.now ?? Date.now();
    const settings = deepMerge(DEFAULT_SETTINGS, options.settings ?? {});
    const practice = options.practice ?? false;
    const sessionStamp = options.sessionStamp ?? now;

    let queue: CardRecord[];
    if (options.cards && options.cards.length > 0) {
      queue = filterReviewable([...options.cards]);
    } else {
      queue = StudySession.buildQueue(options, now);
    }

    if (typeof options.targetCount === "number" && options.targetCount > 0 && queue.length > options.targetCount) {
      queue = queue.slice(0, options.targetCount);
    }

    return new StudySession(options.scope, options.store, settings, queue, practice, sessionStamp);
  }

  // ── Synchronous Inspection ──────────────────────────────────────────────────

  get isPractice(): boolean {
    return this.practice;
  }

  get currentCard(): CardRecord | null {
    if (this.index < 0 || this.index >= this.queue.length) return null;
    return this.queue[this.index] || null;
  }

  get isAnswerRevealed(): boolean {
    return this._showAnswer;
  }

  get canUndo(): boolean {
    if (this._undoStack.length === 0) return false;
    const last = this._undoStack[this._undoStack.length - 1];
    return !!last && !!this.graded[last.id];
  }

  get isComplete(): boolean {
    return this.queue.length === 0 || this.index >= this.queue.length;
  }

  get sessionStamp(): number {
    return this._bcStamp;
  }

  // ── View Compatibility Adapter ──────────────────────────────────────────────

  toSession(): Session {
    return this;
  }

  private _updateStats(): void {
    const total = this.queue.length;
    const done = Object.keys(this.graded).length;
    const remaining = Math.max(0, total - this.index);
    this.stats = { total, done, remaining };
  }

  // ── Option Shuffling ────────────────────────────────────────────────────────

  getOptionOrder(cardId: string): number[] | null {
    return this.mcqOrderMap[cardId] || null;
  }

  setOptionOrder(cardId: string, order: number[]): void {
    this.mcqOrderMap[cardId] = [...order];
  }

  getOqOrder(cardId: string): number[] | null {
    return this.oqOrderMap[cardId] || null;
  }

  setOqOrder(cardId: string, order: number[]): void {
    this.oqOrderMap[cardId] = [...order];
  }

  // ── Session Controls ────────────────────────────────────────────────────────

  revealAnswer(): void {
    this._showAnswer = true;
  }

  hideAnswer(): void {
    this._showAnswer = false;
  }

  /**
   * Advances to the next card in the queue, automatically handling pending same-day requeue.
   * Returns true if advanced to a card, false if the session is complete.
   */
  nextCard(): boolean {
    this._showAnswer = false;

    const current = this.currentCard;
    if (current) {
      const id = String(current.id);
      const gradedEntry = this.graded[id];
      if (gradedEntry?.meta && (gradedEntry.meta as Record<string, unknown>).sameDayRequeue) {
        // Requeue to end
        delete this.graded[id];
        if (this.queue.length > 1) {
          const [cardToRequeue] = this.queue.splice(this.index, 1);
          if (cardToRequeue) {
            this.queue.push(cardToRequeue);
          }
        }
        this._updateStats();
        return !this.isComplete;
      }
    }

    if (this.index < this.queue.length) {
      this.index += 1;
    }
    this._updateStats();
    return !this.isComplete;
  }

  // ── Actions: Grade, Undo, Skip, Bury, Suspend ────────────────────────────────

  /**
   * Grades the current card and persists scheduling updates (unless in practice mode).
   */
  async grade(
    rating: ReviewRating,
    meta?: Record<string, unknown>,
    msToAnswer?: number,
  ): Promise<StudyGradeResult> {
    const card = this.currentCard;
    if (!card) {
      throw new Error("Cannot grade: no active card in study session");
    }

    const id = String(card.id);
    const now = Date.now();
    const st = this._store.getState(id) ?? this._store.ensureState(id, now);

    const reviewLogLenBefore = Array.isArray(this._store.data?.reviewLog)
      ? this._store.data.reviewLog.length
      : 0;
    const analyticsLenBefore = Array.isArray(this._store.data?.analytics?.events)
      ? this._store.data.analytics.events.length
      : 0;

    let nextDue = now;
    let nextState: CardState | undefined;
    let metrics: GradeResult["metrics"] | undefined;
    const storeMutated = !this.practice;
    let analyticsMutated = false;

    if (!this.practice) {
      // 1. Compute FSRS scheduling
      const gradeRes = gradeFromRating(st, rating, now, this._settings);
      nextState = gradeRes.nextState;
      nextDue = gradeRes.nextDue;
      metrics = gradeRes.metrics;

      // 2. Persist state
      this._store.upsertState(nextState);

      // 3. Review log
      this._store.appendReviewLog({
        id,
        at: now,
        result: rating,
        prevDue: gradeRes.prevDue,
        nextDue: gradeRes.nextDue,
        meta: meta || null,
      });

      // 4. Analytics
      if (typeof this._store.appendAnalyticsReview === "function") {
        this._store.appendAnalyticsReview({
          at: now,
          cardId: id,
          cardType: String(card.type || "unknown"),
          result: rating,
          mode: "scheduled",
          msToAnswer,
          prevDue: gradeRes.prevDue,
          nextDue: gradeRes.nextDue,
          scope: this.scope,
          meta: meta || undefined,
        });
        analyticsMutated = true;
      }

      // 5. Persist store
      await this._store.persist();
    } else {
      // Practice mode: record analytics only if configured
      if (typeof this._store.appendAnalyticsReview === "function") {
        this._store.appendAnalyticsReview({
          at: now,
          cardId: id,
          cardType: String(card.type || "unknown"),
          result: rating,
          mode: "practice",
          msToAnswer,
          prevDue: st.due ?? now,
          nextDue: st.due ?? now,
          scope: this.scope,
          meta: meta || undefined,
        });
        analyticsMutated = true;
      }
      await this._store.persist();
    }

    // Intra-session requeue check: if 'again' and still due today, requeue
    const shouldRequeue =
      !this.practice &&
      rating === "again" &&
      Number.isFinite(nextDue) &&
      nextDue <= now &&
      nextDue < startOfTomorrowMs(now);

    let gradeMeta = meta ? { ...meta } : {};
    if (shouldRequeue) {
      gradeMeta = { ...gradeMeta, sameDayRequeue: true };
    }

    // Record undo frame
    this._undoStack.push({
      id,
      cardType: String(card.type || "unknown"),
      rating,
      at: now,
      meta: gradeMeta,
      sessionIndex: this.index,
      showAnswer: this._showAnswer,
      storeMutated,
      analyticsMutated,
      reviewLogLenBefore,
      analyticsLenBefore,
      prevState: deepClone(st),
      requeuedCard: shouldRequeue,
    });

    if (this._undoStack.length > 3) {
      this._undoStack.shift();
    }

    this.graded[id] = { rating, at: now, meta: gradeMeta };
    this._showAnswer = true;
    this._updateStats();

    return {
      card,
      rating,
      nextDue,
      requeued: shouldRequeue,
      metrics,
      nextState,
    };
  }

  /**
   * Reverts the most recent card grade in both session state and underlying store.
   */
  async undo(): Promise<UndoFrame | null> {
    const frame = this._undoStack.pop();
    if (!frame) return null;

    const needPersist = frame.storeMutated || frame.analyticsMutated;

    // 1. Restore previous scheduling state
    if (frame.storeMutated && frame.prevState) {
      this._store.upsertState(deepClone(frame.prevState));
    }

    // 2. Truncate review log
    if (frame.storeMutated) {
      this._store.truncateReviewLog(frame.reviewLogLenBefore);
    }

    // 3. Truncate analytics events
    if (frame.analyticsMutated) {
      this._store.truncateAnalyticsEvents(frame.analyticsLenBefore);
    }

    // 4. Persist store
    if (needPersist) {
      await this._store.persist();
    }

    // 5. Restore session state
    delete this.graded[frame.id];
    this.index = frame.sessionIndex;
    this._showAnswer = frame.showAnswer;
    this._updateStats();

    return frame;
  }

  /**
   * Postpones the current card to later in the session without changing its long-term schedule.
   */
  skipCurrent(meta?: Record<string, unknown>): SkipResult {
    const card = this.currentCard;
    if (!card) {
      return { skipped: false, promptBury: false, skipCount: 0 };
    }

    const id = String(card.id || "");
    if (!id || this.graded[id]) {
      return { skipped: false, promptBury: false, skipCount: 0 };
    }

    const nextCount = (this.skipCounts[id] || 0) + 1;
    this.skipCounts[id] = nextCount;

    if (nextCount >= 3) {
      return { skipped: false, promptBury: true, skipCount: nextCount };
    }

    const remaining = Math.max(0, this.queue.length - this.index - 1);
    const baseN = computeDefaultSkipDelay(remaining);
    const delay = nextCount === 1 ? baseN : Math.min(40, baseN * 2);

    const [removed] = this.queue.splice(this.index, 1);
    if (!removed) {
      return { skipped: false, promptBury: false, skipCount: nextCount };
    }

    const remainingAfterRemoval = Math.max(0, this.queue.length - this.index);
    const insertAt =
      remainingAfterRemoval < delay
        ? this.queue.length
        : Math.min(this.queue.length, this.index + delay);

    this.queue.splice(insertAt, 0, removed);
    this._showAnswer = false;
    this._updateStats();

    return { skipped: true, promptBury: false, skipCount: nextCount };
  }

  /**
   * Buries the current card until tomorrow and removes it from the remaining queue.
   */
  async buryCurrent(now: number = Date.now()): Promise<CardState | null> {
    const card = this.currentCard;
    if (!card) return null;

    const id = String(card.id);
    const st = this._store.getState(id) ?? this._store.ensureState(id, now);
    const in24h = now + 86400000;
    const nextState = {
      ...buryCard(st, now),
      buriedUntil: Math.max(Number(st.due ?? 0), in24h),
    };

    this._store.upsertState(nextState);
    await this._store.persist();

    // Remove from remaining queue
    this.queue.splice(this.index, 1);
    this._showAnswer = false;
    this._updateStats();

    return nextState;
  }

  /**
   * Suspends the current card indefinitely and removes it from the remaining queue.
   */
  async suspendCurrent(now: number = Date.now()): Promise<CardState | null> {
    const card = this.currentCard;
    if (!card) return null;

    const id = String(card.id);
    const st = this._store.getState(id) ?? this._store.ensureState(id, now);
    const nextState = suspendCard(st, now);

    this._store.upsertState(nextState);
    await this._store.persist();

    // Remove from remaining queue
    this.queue.splice(this.index, 1);
    this._showAnswer = false;
    this._updateStats();

    return nextState;
  }

  // ── Queue Construction (Internal) ───────────────────────────────────────────

  private static buildQueue(options: StudySessionOptions, now: number): CardRecord[] {
    const startToday = startOfTodayMs(now);
    const settings = options.settings;
    const study = settings?.study;

    const dailyNewLimit = options.ignoreDailyNewLimit
      ? Number.POSITIVE_INFINITY
      : toNonNegIntOrInfinity(study?.dailyNewLimit);
    const dailyReviewLimit = options.ignoreDailyReviewLimit
      ? Number.POSITIVE_INFINITY
      : toNonNegIntOrInfinity(study?.dailyReviewLimit);
    const dueOnly = options.dueOnly === true;
    const siblingMode = (study as Record<string, unknown> | undefined)?.siblingMode as string ?? "standard";

    const cards = StudySession.resolveCards(options);
    const states = options.store.data?.states || {};

    const idsInScope = new Set<string>(cards.map((c) => String(c.id)));
    const { newDoneToday, reviewDoneToday } = StudySession.getTodayCounts(
      options.store,
      idsInScope,
      startToday,
    );

    const remainingNew =
      dailyNewLimit === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, dailyNewLimit - newDoneToday);

    const remainingReview =
      dailyReviewLimit === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Math.max(0, dailyReviewLimit - reviewDoneToday);

    const available = cards.filter((c) => {
      let st = states[c.id];
      if (!st && options.store?.ensureState) {
        st = options.store.ensureState(c.id, now);
      }
      return isAvailableNow(st, now);
    });

    const dueLike: CardRecord[] = [];
    const news: CardRecord[] = [];

    for (const c of available) {
      let st = states[c.id];
      if (!st && options.store?.ensureState) {
        st = options.store.ensureState(c.id, now);
      }
      if (!st) continue;

      if (st.stage === "new") {
        news.push(c);
      } else if (st.stage === "learning" || st.stage === "relearning" || st.stage === "review") {
        dueLike.push(c);
      } else {
        dueLike.push(c);
      }
    }

    // Sort due-like by due date
    dueLike.sort((a, b) => {
      const sa = states[a.id];
      const sb = states[b.id];
      const da = sa && typeof sa.due === "number" && Number.isFinite(sa.due) ? Number(sa.due) : -1;
      const db = sb && typeof sb.due === "number" && Number.isFinite(sb.due) ? Number(sb.due) : -1;
      return da - db;
    });

    // Sort new cards by id stably
    news.sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const dueTake =
      remainingReview === Number.POSITIVE_INFINITY ? dueLike : dueLike.slice(0, remainingReview);
    const newTake = dueOnly
      ? []
      : remainingNew === Number.POSITIVE_INFINITY
        ? news
        : news.slice(0, remainingNew);

    let queue: CardRecord[];
    if (siblingMode === "disperse") {
      queue = disperseSiblings([...dueTake, ...newTake]);
    } else if (siblingMode === "bury") {
      queue = collapseSiblingFamilies(cards, [...dueTake, ...newTake], states, now);
    } else {
      queue = [...dueTake, ...newTake];
    }

    return queue;
  }

  private static resolveCards(options: StudySessionOptions): CardRecord[] {
    const store = options.store;
    const scope = options.scope;

    if (!scope || scope.type === "vault") {
      return filterReviewable(store.getAllCards());
    }

    if (scope.type === "group") {
      const rawKey = String(scope.key || "").trim();
      if (!rawKey) return [];

      const keys = rawKey
        .split(",")
        .map((k) => normaliseGroupPath(k) || String(k || "").trim())
        .filter((k) => !!k);
      if (!keys.length) return [];

      const plugin = options.plugin as any;
      if (plugin) {
        const gx = getGroupIndex(plugin);
        const ids = new Set<string>();
        for (const key of keys) {
          for (const id of gx.getIds(key)) ids.add(String(id));
        }

        const cardsObj = store.data?.cards || {};
        const quarantine = store.data?.quarantine || {};
        const out: CardRecord[] = [];
        for (const id of ids) {
          if (quarantine[String(id)]) continue;
          const c = cardsObj[String(id)];
          if (c) out.push(c);
        }
        return filterReviewable(out);
      }
    }

    if (scope.type === "tag" || scope.type === "property") {
      const app = (options.app || (options.plugin as any)?.app) as any;
      if (app) {
        const raw = store
          .getAllCards()
          .filter((c) => pathMatchesMetadataScope(app, c.sourceNotePath, scope));
        return filterReviewable(raw);
      }
    }

    const raw = store.getAllCards().filter((c) => inScope(scope, c.sourceNotePath));
    return filterReviewable(raw);
  }

  private static getTodayCounts(
    store: IStore,
    idsInScope: Set<string>,
    startToday: number,
  ): { newDoneToday: number; reviewDoneToday: number } {
    const log = store.data?.reviewLog || [];
    const earliestAtById = new Map<string, number>();
    const reviewedToday = new Set<string>();

    for (const e of log) {
      const id = String(e?.id ?? "");
      if (!id || !idsInScope.has(id)) continue;

      const at = Number(e?.at);
      if (!Number.isFinite(at)) continue;

      const prevEarliest = earliestAtById.get(id);
      if (prevEarliest === undefined || at < prevEarliest) earliestAtById.set(id, at);

      if (at >= startToday) reviewedToday.add(id);
    }

    let newDoneToday = 0;
    let reviewDoneToday = 0;

    for (const id of reviewedToday) {
      const firstAt = earliestAtById.get(id);
      if (firstAt === undefined) continue;

      if (firstAt >= startToday) newDoneToday += 1;
      else reviewDoneToday += 1;
    }

    return { newDoneToday, reviewDoneToday };
  }
}
